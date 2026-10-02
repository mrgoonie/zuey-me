/**
 * Server-side fetch broker for sandboxed interactive blocks (`zuey.fetch` → parent → POST /api/v1/sandbox/fetch).
 *
 * Guarantees: HTTPS GET only, host must be in SANDBOX_FETCH_ALLOWLIST, private/loopback/link-local
 * literals and internal names are refused even when allowlisted, redirects are re-validated hop by hop,
 * no caller cookies or credentials are forwarded, responses are size- and time-capped and text-only,
 * and callers are rate limited per member (or per salted IP hash when anonymous).
 *
 * DNS rebinding: Workers cannot resolve DNS before fetching; Cloudflare's egress does not reach
 * private networks, and literal private addresses are refused here.
 */
import type { D1DatabaseLike } from '../../db/store';
import { hashString } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { FetchFn } from './runtime';
import { aiRuntime } from './runtime';

export const SANDBOX_FETCH_TIMEOUT_MS = 8_000;
export const SANDBOX_FETCH_MAX_BYTES = 512 * 1024;
export const SANDBOX_FETCH_MAX_REDIRECTS = 3;
export const SANDBOX_RATE_WINDOW_MS = 60_000;
export const SANDBOX_RATE_LIMIT_MEMBER = 60;
export const SANDBOX_RATE_LIMIT_ANON = 20;

const TEXT_TYPES = /^(text\/[\w.+-]+|application\/([\w.+-]+\+)?(json|xml)|application\/(javascript|x-ndjson|geo\+json|csv))\b/i;

export interface SandboxFetchResult {
  url: string;
  status: number;
  content_type: string;
  body: string;
}

/** Parses the allowlist: exact hosts (`api.example.com`) and wildcard suffixes (`*.example.com`). */
export function parseAllowlist(env: RuntimeEnv): string[] {
  return (env.SANDBOX_FETCH_ALLOWLIST ?? '')
    .split(',')
    .map(h => h.trim().toLowerCase().replace(/\.$/, ''))
    .filter(h => /^(\*\.)?[a-z0-9.-]+$/.test(h) && h.includes('.'));
}

export function hostAllowed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowlist.some(entry => (entry.startsWith('*.') ? h.endsWith(entry.slice(1)) && h.length > entry.length - 1 : h === entry));
}

function ipv4Private(parts: number[]): boolean {
  const [a, b] = parts;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** True for loopback/private/link-local/reserved IP literals and internal-only names. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) return ipv4Private(v4.slice(1).map(Number));
  if (h.includes(':')) {
    if (h === '::' || h === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return isPrivateHost(mapped[1]);
    // IPv4-mapped in hex form and NAT64 can address IPv4 space; refuse them outright.
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(h) || h.startsWith('64:ff9b:')) return true;
    const first = parseInt(h.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return false;
}

/** Validates a proxy target; throws AppError with a stable code. */
export function checkSandboxUrl(raw: unknown, allowlist: string[]): URL {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    throw new AppError(400, 'invalid_url', 'url must be an absolute https:// URL of at most 2048 characters', { field: 'url' });
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(400, 'invalid_url', 'url must be an absolute https:// URL', { field: 'url' });
  }
  if (url.protocol !== 'https:') throw new AppError(400, 'invalid_url', 'Only https:// URLs can be fetched', { field: 'url' });
  if (url.username || url.password) throw new AppError(400, 'invalid_url', 'URLs with credentials are not allowed', { field: 'url' });
  if (url.port && url.port !== '443') throw new AppError(400, 'invalid_url', 'Only the default HTTPS port is allowed', { field: 'url' });
  if (isPrivateHost(url.hostname)) throw new AppError(403, 'private_address_blocked', 'Private, loopback and internal addresses cannot be fetched');
  if (!hostAllowed(url.hostname, allowlist)) {
    throw new AppError(403, 'host_not_allowed', `Host ${url.hostname} is not in the sandbox fetch allowlist`, { host: url.hostname });
  }
  url.hash = '';
  return url;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AppError(502, 'upstream_too_large', `Upstream response exceeds ${maxBytes} bytes`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AppError(502, 'upstream_too_large', `Upstream response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { all.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(all);
}

export interface ProxyOptions {
  allowlist: string[];
  fetchImpl?: FetchFn;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Performs the brokered GET. Caller headers are never forwarded. */
export async function proxySandboxFetch(rawUrl: unknown, method: unknown, opts: ProxyOptions): Promise<SandboxFetchResult> {
  if (method !== undefined && (typeof method !== 'string' || method.toUpperCase() !== 'GET')) {
    throw new AppError(405, 'method_not_allowed', 'The sandbox proxy only performs GET requests');
  }
  if (opts.allowlist.length === 0) {
    throw new AppError(503, 'sandbox_fetch_unconfigured', 'External requests from interactive blocks are disabled (SANDBOX_FETCH_ALLOWLIST is empty)');
  }
  let url = checkSandboxUrl(rawUrl, opts.allowlist);
  const fetchImpl = opts.fetchImpl ?? aiRuntime.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? SANDBOX_FETCH_TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop += 1) {
      let res: Response;
      try {
        res = await fetchImpl(url.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { Accept: 'application/json, text/plain;q=0.9, */*;q=0.5', 'User-Agent': 'zuey.me-sandbox-proxy/1' },
        });
      } catch {
        if (controller.signal.aborted) throw new AppError(504, 'upstream_timeout', 'Upstream did not respond in time');
        throw new AppError(502, 'upstream_failed', 'Could not reach the upstream host');
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (!location || hop >= SANDBOX_FETCH_MAX_REDIRECTS) {
          throw new AppError(502, 'upstream_redirect_blocked', 'Upstream redirected too many times or without a location');
        }
        url = checkSandboxUrl(new URL(location, url).toString(), opts.allowlist);
        continue;
      }
      const contentType = (res.headers.get('content-type') ?? '').slice(0, 200);
      if (contentType && !TEXT_TYPES.test(contentType)) {
        await res.body?.cancel().catch(() => undefined);
        throw new AppError(415, 'unsupported_content_type', 'Only text and JSON responses can be returned to interactive blocks');
      }
      let body: string;
      try {
        body = await readCapped(res, opts.maxBytes ?? SANDBOX_FETCH_MAX_BYTES);
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (controller.signal.aborted) throw new AppError(504, 'upstream_timeout', 'Upstream did not respond in time');
        throw new AppError(502, 'upstream_failed', 'Upstream response could not be read');
      }
      return { url: url.toString(), status: res.status, content_type: contentType, body };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Fixed-window limiter; returns false when the caller is over the limit for the current window. */
export async function consumeSandboxRateLimit(d1: D1DatabaseLike, key: string, limit: number, nowMs: number): Promise<boolean> {
  const window = Math.floor(nowMs / SANDBOX_RATE_WINDOW_MS) * SANDBOX_RATE_WINDOW_MS;
  const res = await d1.prepare(
    `INSERT INTO sandbox_rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 WHERE count < ?`
  ).bind(key, window, limit).run();
  if (Math.random() < 0.02) {
    await d1.prepare('DELETE FROM sandbox_rate_limits WHERE window_start < ?').bind(window - 10 * SANDBOX_RATE_WINDOW_MS).run();
  }
  return (res.meta?.changes ?? 0) > 0;
}

export async function anonymousRateKey(ip: string, env: RuntimeEnv): Promise<string> {
  return `ip:${(await hashString(`${env.MEMBER_HASH_SALT ?? ''}:sandbox:${ip || 'unknown'}`)).slice(0, 32)}`;
}
