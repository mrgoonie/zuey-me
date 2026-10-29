/**
 * Pages → presence Worker client for the owner status control (`GET`/`PUT /internal/owner`, see
 * `contract.ts`). Transport, time-bound header, redirect and failure rules live in
 * `presence-internal-client.ts`; every failure becomes 503 `presence_unavailable`.
 */
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { OWNER_STATUS_TEXT_MAX, isOwnerMode, type OwnerStatusState, type OwnerStatusUpdate } from './contract';
import { isOwnerStatusState, sanitizeOwnerStatusText } from './presence-owner-status-guards';
import { callPresenceInternal, presenceInternalTransport, type PresenceTransport } from './presence-internal-client';

export {
  PRESENCE_INTERNAL_TIMEOUT_MS, isAllowedPresenceHttpTarget, type PresenceTransport, type PresenceTransportKind,
} from './presence-internal-client';

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

/** The transport for `/internal/owner` (see `presenceInternalTransport`). */
export function presenceOwnerTransport(env: RuntimeEnv): PresenceTransport {
  return presenceInternalTransport(env, PRESENCE_OWNER_PATH);
}

const callOwnerEndpoint = (env: RuntimeEnv, method: 'GET' | 'PUT', update?: OwnerStatusUpdate): Promise<OwnerStatusState> =>
  callPresenceInternal(env, { method, path: PRESENCE_OWNER_PATH, body: update, parse: (v) => (isOwnerStatusState(v) ? v : null) });

/** Current owner setting plus what the public sees. Throws 503 `presence_unavailable` on any Worker failure. */
export function getOwnerStatus(env: RuntimeEnv): Promise<OwnerStatusState> {
  return callOwnerEndpoint(env, 'GET');
}

/** Stores the owner setting (idempotent: the same update twice yields the same state). */
export function setOwnerStatus(env: RuntimeEnv, update: OwnerStatusUpdate): Promise<OwnerStatusState> {
  return callOwnerEndpoint(env, 'PUT', update);
}
