import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import { raiseAccountFlag } from './account-flags';
import type { UserRecord } from './users';
import { logActivity, rowToUser } from './users';
import type { Row } from './runtime';
import { DAY_MS, iso, membersRuntime, randomId, randomSecret, sha256Hex, str, strOrNull, userAgent } from './runtime';

export const MEMBER_COOKIE = 'zuey_member';
export const SESSION_TTL_MS = 30 * DAY_MS;
/** Sliding expiry is refreshed at most this often to avoid a write on every request. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const TOKEN_PREFIX = 'zm_';

export interface MemberSession {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  user_agent: string | null;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function memberCookie(token: string): string {
  return `${MEMBER_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearMemberCookie(): string {
  return `${MEMBER_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * CSRF guard for cookie-authenticated requests: unsafe methods must come from this origin,
 * proven by `Origin` (preferred) or `Sec-Fetch-Site: same-origin` when Origin is absent.
 */
export function isSameOriginRequest(request: Request): boolean {
  if (SAFE_METHODS.includes(request.method.toUpperCase())) return true;
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      return origin !== 'null' && new URL(origin).origin === new URL(request.url).origin;
    } catch {
      return false;
    }
  }
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

function rowToSession(row: Row): MemberSession {
  return {
    id: str(row, 'id'),
    user_id: str(row, 'user_id'),
    created_at: str(row, 'created_at'),
    expires_at: str(row, 'expires_at'),
    last_seen_at: str(row, 'last_seen_at'),
    user_agent: strOrNull(row, 'user_agent'),
  };
}

/**
 * Opens a session. `ipHash` (salted hash of the sign-in IP, see `ipHash` in login-tokens) is kept only as a
 * referral fraud signal: a referee binding from an IP the referrer signs in from goes to review.
 */
export async function createMemberSession(
  d1: D1DatabaseLike, userId: string, request?: Request, ipHash: string | null = null,
): Promise<{ token: string; session: MemberSession }> {
  const token = TOKEN_PREFIX + randomSecret(32);
  const now = membersRuntime.now();
  const session: MemberSession = {
    id: randomId('ms'),
    user_id: userId,
    created_at: iso(now),
    expires_at: iso(now + SESSION_TTL_MS),
    last_seen_at: iso(now),
    user_agent: request ? userAgent(request) : null,
  };
  await d1.prepare(
    'INSERT INTO member_sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(session.id, await sha256Hex(token), userId, session.created_at, session.expires_at, session.last_seen_at, session.user_agent, ipHash).run();
  await enforceSessionCap(d1, userId, session.id);
  return { token, session };
}

/** Signed-in devices per account; a new sign-in beyond this signs out the least recently used one. */
export const MAX_MEMBER_SESSIONS = 2;
/** Evictions within a week that suggest a shared account and raise a review flag. */
const EVICTION_FLAG_THRESHOLD = 6;

async function enforceSessionCap(d1: D1DatabaseLike, userId: string, keepId: string): Promise<void> {
  const now = membersRuntime.now();
  const { results } = await d1.prepare(
    'SELECT id FROM member_sessions WHERE user_id = ? AND expires_at > ? AND id <> ? ORDER BY last_seen_at DESC, created_at DESC'
  ).bind(userId, iso(now), keepId).all<Row>();
  const evict = (results ?? []).slice(MAX_MEMBER_SESSIONS - 1).map(r => str(r, 'id'));
  if (evict.length === 0) return;
  for (const id of evict) await d1.prepare('DELETE FROM member_sessions WHERE id = ?').bind(id).run();
  await logActivity(d1, userId, 'session.evicted', { count: evict.length });
  const recent = await d1.prepare("SELECT COUNT(*) AS n FROM user_activity WHERE user_id = ? AND action = 'session.evicted' AND created_at > ?")
    .bind(userId, iso(now - 7 * DAY_MS)).first<Row>();
  if (Number(recent?.n ?? 0) >= EVICTION_FLAG_THRESHOLD) {
    await raiseAccountFlag(d1, userId, 'session_churn', { evictions_7d: Number(recent?.n ?? 0) });
  }
}

export interface ResolvedMemberSession {
  session: MemberSession;
  user: UserRecord;
}

/** Looks up a live session + live user for a raw cookie token and slides its expiry. */
export async function lookupMemberSession(d1: D1DatabaseLike, token: string): Promise<ResolvedMemberSession | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
  const now = membersRuntime.now();
  const row = await d1.prepare(
    `SELECT s.id AS s_id, s.user_id AS s_user_id, s.created_at AS s_created_at, s.expires_at AS s_expires_at,
            s.last_seen_at AS s_last_seen_at, s.user_agent AS s_user_agent, u.*
     FROM member_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.deleted_at IS NULL`
  ).bind(await sha256Hex(token), iso(now)).first<Row>();
  if (!row) return null;
  const session: MemberSession = {
    id: str(row, 's_id'),
    user_id: str(row, 's_user_id'),
    created_at: str(row, 's_created_at'),
    expires_at: str(row, 's_expires_at'),
    last_seen_at: str(row, 's_last_seen_at'),
    user_agent: strOrNull(row, 's_user_agent'),
  };
  if (now - Date.parse(session.last_seen_at) > TOUCH_INTERVAL_MS) {
    session.last_seen_at = iso(now);
    session.expires_at = iso(now + SESSION_TTL_MS);
    await d1.prepare('UPDATE member_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .bind(session.last_seen_at, session.expires_at, session.id).run()
      .catch((err: unknown) => console.error('member session touch failed:', err instanceof Error ? err.message : 'unknown'));
  }
  return { session, user: rowToUser(row) };
}

/** Resolves the `zuey_member` cookie of a request (no CSRF decision here). */
export async function resolveMemberSession(request: Request, d1: D1DatabaseLike | undefined): Promise<ResolvedMemberSession | null> {
  const token = readCookie(request, MEMBER_COOKIE);
  if (!token || !d1) return null;
  return lookupMemberSession(d1, token);
}

export async function destroyMemberSessionByToken(d1: D1DatabaseLike, token: string): Promise<void> {
  await d1.prepare('DELETE FROM member_sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

export async function listMemberSessions(d1: D1DatabaseLike, userId: string): Promise<MemberSession[]> {
  const { results } = await d1.prepare('SELECT * FROM member_sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC')
    .bind(userId, iso(membersRuntime.now())).all<Row>();
  return (results ?? []).map(rowToSession);
}

/** Revokes one of the user's own sessions; 404 for sessions that belong to someone else. */
export async function revokeMemberSession(d1: D1DatabaseLike, userId: string, sessionId: string): Promise<void> {
  const res = await d1.prepare('DELETE FROM member_sessions WHERE id = ? AND user_id = ?').bind(sessionId, userId).run();
  if (!res.meta?.changes) throw new AppError(404, 'not_found', 'Session not found');
}

export async function revokeOtherMemberSessions(d1: D1DatabaseLike, userId: string, keepSessionId: string): Promise<number> {
  const res = await d1.prepare('DELETE FROM member_sessions WHERE user_id = ? AND id <> ?').bind(userId, keepSessionId).run();
  return res.meta?.changes ?? 0;
}
