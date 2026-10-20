/**
 * Pages → presence Worker client for the owner status control (`GET`/`PUT /internal/owner`, see
 * `contract.ts`). With the `PRESENCE` service binding every call goes through it and a failure is a 503
 * (no retry over the public internet). Only without a binding does it use HTTP to PUBLIC_PRESENCE_URL (or
 * the default origin), and only to `https:` or loopback `http:`. Redirects are never followed, the internal
 * header is time-bound (`internal-auth.ts`), Worker responses are validated, and every failure becomes 503
 * `presence_unavailable`.
 */
import type { RuntimeEnv, ServiceBindingLike } from '../../env';
import { AppError } from '../http';
import {
  OWNER_STATUS_TEXT_MAX,
  PRESENCE_DEFAULT_ORIGIN,
  PRESENCE_INTERNAL_HEADER,
  isOwnerMode,
  type OwnerStatusState,
  type OwnerStatusUpdate,
} from './contract';
import { isOwnerStatusState, sanitizeOwnerStatusText } from './presence-owner-status-guards';
import { presenceWorkerOrigin } from './presence-ticket-issuer';
import { signPresenceInternal } from './internal-auth';

/** Upper bound for one Worker round trip (per transport attempt). */
export const PRESENCE_INTERNAL_TIMEOUT_MS = 5_000;

export const PRESENCE_OWNER_PATH = '/internal/owner';

/**
 * Validates an owner status update (REST body or MCP arguments). `text` may be a string, null or
 * omitted; empty after sanitizing clears it. Over-long text is rejected, never silently cut.
 */
export function parseOwnerStatusUpdate(body: Record<string, unknown> | null): OwnerStatusUpdate {
  if (!body) throw new AppError(400, 'invalid_json', 'Body must be a JSON object');
  if (!isOwnerMode(body.mode)) {
    throw new AppError(400, 'invalid_mode', '`mode` must be one of auto, away, busy, offline, invisible', { field: 'mode' });
  }
  const raw = body.text;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw new AppError(400, 'invalid_text', '`text` must be a string or null', { field: 'text' });
  }
  const text = typeof raw === 'string' ? sanitizeOwnerStatusText(raw) : '';
  if (text.length > OWNER_STATUS_TEXT_MAX) {
    throw new AppError(400, 'text_too_long', `\`text\` must be at most ${OWNER_STATUS_TEXT_MAX} characters`, {
      field: 'text', max_length: OWNER_STATUS_TEXT_MAX,
    });
  }
  return text ? { mode: body.mode, text } : { mode: body.mode };
}

export type PresenceTransportKind = 'binding' | 'http';

export interface PresenceTransport {
  kind: PresenceTransportKind;
  /** Absolute URL of `/internal/owner` for this transport. */
  url: string;
  fetch(input: string, init: RequestInit): Promise<Response>;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** HTTP is allowed only to `https:` or to a loopback `http:` host (local `wrangler dev`). */
export function isAllowedPresenceHttpTarget(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
}

/**
 * The single transport for owner calls. With the `PRESENCE` service binding it is always the binding (a
 * binding failure is a 503, never a retry over the public internet). Without a binding (local dev) it is
 * HTTP to PUBLIC_PRESENCE_URL or the default origin, refused (503) unless https or loopback http.
 */
export function presenceOwnerTransport(env: RuntimeEnv): PresenceTransport {
  const binding: ServiceBindingLike | undefined = env.PRESENCE;
  if (binding) {
    // The host is ignored by a service binding; the default origin keeps the URL well formed.
    return { kind: 'binding', url: `${PRESENCE_DEFAULT_ORIGIN}${PRESENCE_OWNER_PATH}`, fetch: (input, init) => binding.fetch(input, init) };
  }
  const url = new URL(`${presenceWorkerOrigin(env)}${PRESENCE_OWNER_PATH}`);
  if (!isAllowedPresenceHttpTarget(url)) {
    throw new AppError(503, 'presence_unavailable', 'Realtime presence is misconfigured');
  }
  return { kind: 'http', url: url.href, fetch: (input, init) => fetch(input, init) };
}

const unavailable = (): AppError => new AppError(503, 'presence_unavailable', 'Realtime presence is unavailable right now');

async function readState(res: Response): Promise<OwnerStatusState | null> {
  // `redirect: 'manual'`: a 3xx (or an opaque redirect, status 0) is a failure, never followed.
  if (!res.ok || res.type === 'opaqueredirect') return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  return isOwnerStatusState(body) ? body : null;
}

async function callOwnerEndpoint(env: RuntimeEnv, method: 'GET' | 'PUT', update?: OwnerStatusUpdate): Promise<OwnerStatusState> {
  const secret = env.PRESENCE_TICKET_SECRET;
  if (!secret) throw new AppError(503, 'presence_unavailable', 'Realtime presence is not configured');
  const transport = presenceOwnerTransport(env);
  const headers: Record<string, string> = { [PRESENCE_INTERNAL_HEADER]: await signPresenceInternal(secret, method, new URL(transport.url).pathname), Accept: 'application/json' };
  if (update) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await transport.fetch(transport.url, {
      method,
      headers,
      body: update ? JSON.stringify(update) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(PRESENCE_INTERNAL_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('presence owner: Worker unreachable', transport.kind, method, err instanceof Error ? err.name : 'unknown');
    throw unavailable();
  }
  const state = await readState(res);
  if (state) return state;
  console.error('presence owner: unusable Worker response', transport.kind, method, res.status);
  throw unavailable();
}

/** Current owner setting plus what the public sees. Throws 503 `presence_unavailable` on any Worker failure. */
export function getOwnerStatus(env: RuntimeEnv): Promise<OwnerStatusState> {
  return callOwnerEndpoint(env, 'GET');
}

/** Stores the owner setting (idempotent: the same update twice yields the same state). */
export function setOwnerStatus(env: RuntimeEnv, update: OwnerStatusUpdate): Promise<OwnerStatusState> {
  return callOwnerEndpoint(env, 'PUT', update);
}
