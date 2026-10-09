/**
 * Account review flags raised by anti-abuse signals (account sharing, session churn). A flag never
 * blocks anyone by itself: the admin reviews it in Studio and may lock course access.
 */
import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import type { Row } from './runtime';
import { DAY_MS, iso, membersRuntime, randomId, str, strOrNull } from './runtime';

export type AccountFlagStatus = 'open' | 'dismissed' | 'locked';

export interface AccountFlag {
  id: string;
  user_id: string;
  email: string | null;
  kind: string;
  detail: Record<string, unknown>;
  status: AccountFlagStatus;
  created_at: string;
  resolved_at: string | null;
}

function rowToFlag(r: Row): AccountFlag {
  let detail: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(str(r, 'detail_json') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) detail = parsed as Record<string, unknown>;
  } catch { /* keep empty */ }
  const status = str(r, 'status');
  return {
    id: str(r, 'id'),
    user_id: str(r, 'user_id'),
    email: strOrNull(r, 'email'),
    kind: str(r, 'kind'),
    detail,
    status: status === 'dismissed' || status === 'locked' ? status : 'open',
    created_at: str(r, 'created_at'),
    resolved_at: strOrNull(r, 'resolved_at'),
  };
}

/** Raises a flag unless the same kind is already open (or was raised in the last day) for the user. */
export async function raiseAccountFlag(d1: D1DatabaseLike, userId: string, kind: string, detail: Record<string, unknown>): Promise<boolean> {
  const now = membersRuntime.now();
  const recent = await d1.prepare("SELECT 1 AS ok FROM account_flags WHERE user_id = ? AND kind = ? AND (status = 'open' OR created_at > ?)")
    .bind(userId, kind, iso(now - DAY_MS)).first<Row>();
  if (recent) return false;
  await d1.prepare('INSERT INTO account_flags (id, user_id, kind, detail_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(randomId('flg'), userId, kind, JSON.stringify(detail), 'open', iso(now)).run();
  return true;
}

export async function listAccountFlags(d1: D1DatabaseLike, status: AccountFlagStatus | 'all' = 'open', limit = 100): Promise<AccountFlag[]> {
  const where = status === 'all' ? '' : 'WHERE f.status = ?';
  const stmt = d1.prepare(`SELECT f.*, u.email FROM account_flags f LEFT JOIN users u ON u.id = f.user_id ${where} ORDER BY f.created_at DESC LIMIT ?`);
  const { results } = await (status === 'all' ? stmt.bind(limit) : stmt.bind(status, limit)).all<Row>();
  return (results ?? []).map(rowToFlag);
}

export async function lockCourseAccess(d1: D1DatabaseLike, userId: string, reason: string): Promise<void> {
  await d1.prepare('INSERT INTO course_user_locks (user_id, reason, locked_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET reason = excluded.reason, locked_at = excluded.locked_at')
    .bind(userId, reason.slice(0, 300), iso(membersRuntime.now())).run();
}

export async function unlockCourseAccess(d1: D1DatabaseLike, userId: string): Promise<boolean> {
  const res = await d1.prepare('DELETE FROM course_user_locks WHERE user_id = ?').bind(userId).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function listCourseLocks(d1: D1DatabaseLike): Promise<Array<{ user_id: string; email: string | null; reason: string; locked_at: string }>> {
  const { results } = await d1.prepare('SELECT l.*, u.email FROM course_user_locks l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.locked_at DESC').all<Row>();
  return (results ?? []).map(r => ({ user_id: str(r, 'user_id'), email: strOrNull(r, 'email'), reason: str(r, 'reason'), locked_at: str(r, 'locked_at') }));
}

/** Admin decision on a flag: dismiss it, or lock the account's course access (and sign it out everywhere). */
export async function resolveAccountFlag(d1: D1DatabaseLike, id: string, action: unknown): Promise<AccountFlag> {
  if (action !== 'dismiss' && action !== 'lock') throw new AppError(400, 'invalid_field', "action must be 'dismiss' or 'lock'", { field: 'action' });
  const row = await d1.prepare('SELECT f.*, u.email FROM account_flags f LEFT JOIN users u ON u.id = f.user_id WHERE f.id = ?').bind(id).first<Row>();
  if (!row) throw new AppError(404, 'not_found', 'Flag not found');
  const flag = rowToFlag(row);
  const now = iso(membersRuntime.now());
  if (action === 'lock') {
    await lockCourseAccess(d1, flag.user_id, `flag:${flag.kind}`);
    await d1.prepare('DELETE FROM member_sessions WHERE user_id = ?').bind(flag.user_id).run();
  }
  await d1.prepare('UPDATE account_flags SET status = ?, resolved_at = ? WHERE id = ?').bind(action === 'lock' ? 'locked' : 'dismissed', now, flag.id).run();
  return { ...flag, status: action === 'lock' ? 'locked' : 'dismissed', resolved_at: now };
}
