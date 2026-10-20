/**
 * Issues presence connect tickets (POST /api/v1/presence/ticket). Every trust decision is made here,
 * server-side: the browser only says whether it may be counted and, for guests, its random presence id.
 * Membership comes from the `zuey_member` session cookie (never API keys), owner status from the
 * PRESENCE_OWNER_MEMBER_IDS allowlist (never the admin role), and the dedupe key is an HMAC, never a raw id.
 */
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { clientIp, membersRuntime, randomSecret } from '../members/runtime';
import { isSameOriginRequest, resolveMemberSession } from '../members/session';
import { PRESENCE_DEFAULT_ORIGIN, PRESENCE_TICKET_TTL_MS, type PresenceTicketPayload } from './contract';
import { presenceIpKey } from './ip-prefix';
import { presenceOwnerIds } from './presence-owner-identity';
import { presenceTicketLimiter } from './presence-rate-limit';
import { hmacBase64Url, signPresenceTicket } from './ticket';

export { presenceOwnerIds } from './presence-owner-identity';

/** Random browser presence id the client keeps in localStorage `zuey_presence_id`. */
export const PRESENCE_BROWSER_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** Length the opaque dedupe key is cut to (192 bits of the HMAC; plenty to avoid collisions). */
export const PRESENCE_KEY_LENGTH = 32;

export interface PresenceTicketRequest {
  count: boolean;
  browserId: string | null;
}

export interface IssuedPresenceTicket {
  ticket: string;
  url: string;
  expiresAt: string;
}

/** Validates the JSON body; unknown fields (including any m/o/k a client might send) are ignored. */
export function parsePresenceTicketRequest(body: Record<string, unknown> | null): PresenceTicketRequest {
  if (!body) throw new AppError(400, 'invalid_json', 'Body must be a JSON object');
  if (typeof body.count !== 'boolean') throw new AppError(400, 'invalid_request', '`count` must be a boolean', { field: 'count' });
  const raw = body.browserId;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw new AppError(400, 'invalid_browser_id', '`browserId` must be a string', { field: 'browserId' });
  }
  return { count: body.count, browserId: typeof raw === 'string' ? raw : null };
}

/** HTTP(S) base URL of the presence Worker: PUBLIC_PRESENCE_URL or the default origin. Throws 503 when misconfigured. */
export function presenceWorkerBase(env: RuntimeEnv): URL {
  const base = env.PUBLIC_PRESENCE_URL?.trim() || PRESENCE_DEFAULT_ORIGIN;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new AppError(503, 'presence_unavailable', 'Realtime presence is misconfigured');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError(503, 'presence_unavailable', 'Realtime presence is misconfigured');
  }
  return url;
}

/** Origin plus base path of the presence Worker, without a trailing slash (e.g. `https://presence.zuey.me`). */
export function presenceWorkerOrigin(env: RuntimeEnv): string {
  const url = presenceWorkerBase(env);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/** WebSocket connect URL of the presence Worker: PUBLIC_PRESENCE_URL (or the default origin) as ws(s) + /v1/connect. */
export function presenceConnectUrl(env: RuntimeEnv): string {
  const url = presenceWorkerBase(env);
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${url.host}${url.pathname.replace(/\/+$/, '')}/v1/connect`;
}

/** Throws 429 when this client IP (IPv6: its /64) asked for too many tickets in the current window (per isolate). */
export function enforcePresenceTicketRateLimit(request: Request, now: number): void {
  const retryAfter = presenceTicketLimiter.hit(presenceIpKey(clientIp(request)) || 'unknown', now);
  if (retryAfter !== null) {
    throw new AppError(429, 'rate_limited', 'Too many presence tickets; try again later', { retry_after: retryAfter });
  }
}

/** Signed-in member id from the session cookie, only for same-origin requests (CSRF); otherwise anonymous. */
async function sessionMemberId(request: Request, env: RuntimeEnv): Promise<string | null> {
  if (!env.DB || !isSameOriginRequest(request)) return null;
  const resolved = await resolveMemberSession(request, env.DB);
  return resolved ? resolved.user.id : null;
}

export async function issuePresenceTicket(request: Request, env: RuntimeEnv, input: PresenceTicketRequest): Promise<IssuedPresenceTicket> {
  const secret = env.PRESENCE_TICKET_SECRET;
  if (!secret) throw new AppError(503, 'presence_unavailable', 'Realtime presence is not configured');
  const url = presenceConnectUrl(env);

  const memberId = await sessionMemberId(request, env);
  let keySource: string;
  if (!input.count) {
    // Watch-only: a throwaway key, so a viewer who may not be counted is never linkable across connections.
    keySource = `w:${randomSecret(16)}`;
  } else if (memberId) {
    // One member is one visitor across tabs and devices.
    keySource = `m:${memberId}`;
  } else {
    if (!input.browserId || !PRESENCE_BROWSER_ID_PATTERN.test(input.browserId)) {
      throw new AppError(400, 'invalid_browser_id', '`browserId` (16-64 characters of A-Z a-z 0-9 _ -) is required to be counted', { field: 'browserId' });
    }
    keySource = `b:${input.browserId}`;
  }

  const now = membersRuntime.now();
  const payload: PresenceTicketPayload = {
    k: (await hmacBase64Url(secret, keySource)).slice(0, PRESENCE_KEY_LENGTH),
    c: input.count,
    m: memberId !== null,
    o: memberId !== null && presenceOwnerIds(env).has(memberId),
    exp: now + PRESENCE_TICKET_TTL_MS,
    n: randomSecret(16),
  };
  return { ticket: await signPresenceTicket(secret, payload), url, expiresAt: new Date(payload.exp).toISOString() };
}
