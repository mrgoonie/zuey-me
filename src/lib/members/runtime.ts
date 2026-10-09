import type { D1DatabaseLike } from '../../db/store';
import { hashString } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { FetchLike } from '../integrations/google-calendar';

/** Injectable side effects so tests can control time and outbound HTTP. */
export const membersRuntime: { fetch: FetchLike; now: () => number } = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
};

export const DAY_MS = 24 * 60 * 60 * 1000;

export type Row = Record<string, unknown>;

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function nowIso(): string {
  return iso(membersRuntime.now());
}

export function requireMembersDb(env: RuntimeEnv): D1DatabaseLike {
  if (!env.DB) throw new AppError(503, 'database_unavailable', 'Membership requires the D1 database binding (DB)');
  return env.DB;
}

export function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** URL-safe random secret with `bytes` bytes of entropy from the Web Crypto CSPRNG. */
export function randomSecret(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** Uppercase code from an alphabet without look-alike characters (0/O, 1/I). */
export function randomCode(length = 8): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

export const sha256Hex = hashString;

export function siteUrl(env: RuntimeEnv): string {
  return (env.PUBLIC_SITE_URL || 'https://zuey.me').replace(/\/+$/, '');
}

export function clientIp(request: Request): string {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const fwd = request.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : '';
}

export function userAgent(request: Request): string | null {
  const ua = request.headers.get('user-agent');
  return ua ? ua.slice(0, 300) : null;
}

export function str(row: Row, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v : '';
}

export function strOrNull(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' ? v : null;
}

export function num(row: Row, key: string): number {
  const v = row[key];
  return typeof v === 'number' ? v : Number(v) || 0;
}

export function numOrNull(row: Row, key: string): number | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

/** Placeholder origin used only to resolve a candidate path; never emitted. */
const NEXT_PATH_BASE = 'https://x.invalid';

/**
 * Only same-site relative paths are accepted as post-login or post-redirect destinations. Browsers strip
 * tabs/newlines and treat `\` as `/` while parsing a Location, so `/\t/evil.com` or `/\evil.com` would become
 * a protocol-relative URL to another host: any control character, whitespace or backslash is rejected, and
 * the path must resolve to the same origin. The normalized path + query + fragment is returned.
 */
export function safeNextPath(value: unknown, fallback = '/account'): string {
  if (typeof value !== 'string') return fallback;
  const v = value.trim();
  if (!v.startsWith('/') || v.length > 300 || /[\u0000-\u001F\u007F\s\\]/.test(v)) return fallback;
  let url: URL;
  try {
    url = new URL(v, NEXT_PATH_BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== NEXT_PATH_BASE) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
