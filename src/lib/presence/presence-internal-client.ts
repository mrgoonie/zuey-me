/**
 * Shared Pages → presence Worker transport for the private `/internal/*` API (see `contract.ts`). With the
 * `PRESENCE` service binding every call goes through it and a failure is a 503 (no retry over the public
 * internet). Only without a binding does it use HTTP to PUBLIC_PRESENCE_URL (or the default origin), and only
 * to `https:` or loopback `http:`. Redirects are never followed, the internal header is time-bound
 * (`internal-auth.ts`), every Worker answer is validated by the caller's parser, and every failure becomes
 * 503 `presence_unavailable`.
 */
import type { RuntimeEnv, ServiceBindingLike } from '../../env';
import { AppError } from '../http';
import { PRESENCE_DEFAULT_ORIGIN, PRESENCE_INTERNAL_HEADER, type PresenceDiagnostics } from './contract';
import { parsePresenceDiagnostics } from './presence-diagnostics-guards';
import { presenceWorkerOrigin } from './presence-ticket-issuer';
import { signPresenceInternal } from './internal-auth';

/** Upper bound for one Worker round trip (per transport attempt). */
export const PRESENCE_INTERNAL_TIMEOUT_MS = 5_000;

export const PRESENCE_DIAGNOSTICS_PATH = '/internal/diagnostics';

export type PresenceTransportKind = 'binding' | 'http';

export interface PresenceTransport {
  kind: PresenceTransportKind;
  /** Absolute URL of the `/internal/*` path for this transport. */
  url: string;
  fetch(input: string, init: RequestInit): Promise<Response>;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** HTTP is allowed only to `https:` or to a loopback `http:` host (local `wrangler dev`). */
export function isAllowedPresenceHttpTarget(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
}

/**
 * The single transport for one internal path. With the `PRESENCE` service binding it is always the binding
 * (a binding failure is a 503, never a retry over the public internet). Without a binding (local dev) it is
 * HTTP to PUBLIC_PRESENCE_URL or the default origin, refused (503) unless https or loopback http.
 */
export function presenceInternalTransport(env: RuntimeEnv, path: string): PresenceTransport {
  const binding: ServiceBindingLike | undefined = env.PRESENCE;
  if (binding) {
    // The host is ignored by a service binding; the default origin keeps the URL well formed.
    return { kind: 'binding', url: `${PRESENCE_DEFAULT_ORIGIN}${path}`, fetch: (input, init) => binding.fetch(input, init) };
  }
  const url = new URL(`${presenceWorkerOrigin(env)}${path}`);
  if (!isAllowedPresenceHttpTarget(url)) {
    throw new AppError(503, 'presence_unavailable', 'Realtime presence is misconfigured');
  }
  return { kind: 'http', url: url.href, fetch: (input, init) => fetch(input, init) };
}

const unavailable = (): AppError => new AppError(503, 'presence_unavailable', 'Realtime presence is unavailable right now');

async function readBody<T>(res: Response, parse: (body: unknown) => T | null): Promise<T | null> {
  // `redirect: 'manual'`: a 3xx (or an opaque redirect, status 0) is a failure, never followed.
  if (!res.ok || res.type === 'opaqueredirect') return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  return parse(body);
}

export interface PresenceInternalCall<T> {
  method: 'GET' | 'PUT';
  path: string;
  /** JSON body (PUT only). */
  body?: unknown;
  /** Validates the Worker answer; null rejects it (503). */
  parse: (body: unknown) => T | null;
}

/** One authenticated call to the Worker's `/internal/*` API. Throws 503 `presence_unavailable` on any failure. */
export async function callPresenceInternal<T>(env: RuntimeEnv, call: PresenceInternalCall<T>): Promise<T> {
  const secret = env.PRESENCE_TICKET_SECRET;
  if (!secret) throw new AppError(503, 'presence_unavailable', 'Realtime presence is not configured');
  const transport = presenceInternalTransport(env, call.path);
  const hasBody = call.body !== undefined;
  const headers: Record<string, string> = { [PRESENCE_INTERNAL_HEADER]: await signPresenceInternal(secret, call.method, call.path), Accept: 'application/json' };
  if (hasBody) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await transport.fetch(transport.url, {
      method: call.method,
      headers,
      body: hasBody ? JSON.stringify(call.body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(PRESENCE_INTERNAL_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('presence internal: Worker unreachable', transport.kind, call.method, call.path, err instanceof Error ? err.name : 'unknown');
    throw unavailable();
  }
  const value = await readBody(res, call.parse);
  if (value !== null) return value;
  console.error('presence internal: unusable Worker response', transport.kind, call.method, call.path, res.status);
  throw unavailable();
}

/** Worker counters for admins (`GET /internal/diagnostics`), re-built from known fields only. */
export function getPresenceDiagnostics(env: RuntimeEnv): Promise<PresenceDiagnostics> {
  return callPresenceInternal(env, { method: 'GET', path: PRESENCE_DIAGNOSTICS_PATH, parse: parsePresenceDiagnostics });
}
