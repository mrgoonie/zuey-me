/**
 * Pages → presence Worker client for the owner status control (`GET`/`PUT /internal/owner`, see
 * `contract.ts`). Uses the `PRESENCE` service binding when bound and falls back to HTTP against
 * PUBLIC_PRESENCE_URL (or the default origin): local `astro dev` has no running Worker behind the
 * binding, and a binding hiccup must not hide a reachable Worker. Every failure becomes 503
 * `presence_unavailable`; Worker responses are validated before use.
 */
import type { RuntimeEnv, ServiceBindingLike } from '../../env';
import { AppError } from '../http';
import {
  OWNER_STATUS_TEXT_MAX,
  PRESENCE_INTERNAL_HEADER,
  PRESENCE_INTERNAL_LABEL,
  isOwnerMode,
  type OwnerStatusState,
  type OwnerStatusUpdate,
} from './contract';
import { isOwnerStatusState, sanitizeOwnerStatusText } from './presence-owner-status-guards';
import { presenceWorkerOrigin } from './presence-ticket-issuer';
import { hmacBase64Url } from './ticket';

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

/** Value of PRESENCE_INTERNAL_HEADER: `hmacBase64Url(PRESENCE_TICKET_SECRET, PRESENCE_INTERNAL_LABEL)`. */
export function presenceInternalAuth(secret: string): Promise<string> {
  return hmacBase64Url(secret, PRESENCE_INTERNAL_LABEL);
}

export type PresenceTransportKind = 'binding' | 'http';

interface PresenceTransport {
  kind: PresenceTransportKind;
  fetch(input: string, init: RequestInit): Promise<Response>;
}

/** Transports in the order they are tried: the service binding first when bound, then public HTTP. */
export function presenceOwnerTransports(env: RuntimeEnv): PresenceTransport[] {
  const http: PresenceTransport = { kind: 'http', fetch: (input, init) => fetch(input, init) };
  const binding: ServiceBindingLike | undefined = env.PRESENCE;
  if (!binding) return [http];
  return [{ kind: 'binding', fetch: (input, init) => binding.fetch(input, init) }, http];
}

const unavailable = (): AppError => new AppError(503, 'presence_unavailable', 'Realtime presence is unavailable right now');

async function readState(res: Response): Promise<OwnerStatusState | null> {
  if (!res.ok) return null;
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
  const url = `${presenceWorkerOrigin(env)}${PRESENCE_OWNER_PATH}`;
  const headers: Record<string, string> = { [PRESENCE_INTERNAL_HEADER]: await presenceInternalAuth(secret), Accept: 'application/json' };
  if (update) headers['Content-Type'] = 'application/json';

  for (const transport of presenceOwnerTransports(env)) {
    try {
      const res = await transport.fetch(url, {
        method,
        headers,
        body: update ? JSON.stringify(update) : undefined,
        signal: AbortSignal.timeout(PRESENCE_INTERNAL_TIMEOUT_MS),
      });
      const state = await readState(res);
      if (state) return state;
      console.error('presence owner: unusable Worker response', transport.kind, method, res.status);
    } catch (err) {
      console.error('presence owner: Worker unreachable', transport.kind, method, err instanceof Error ? err.name : 'unknown');
    }
  }
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
