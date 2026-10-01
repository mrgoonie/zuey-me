import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { isAdminIdentity } from './admins';
import type { PlanId } from './plans';
import { isPlanId } from './plans';
import type { Row } from './runtime';
import { iso, membersRuntime, str, strOrNull } from './runtime';

export interface MemberListItem {
  id: string;
  email: string;
  email_verified: boolean;
  name: string | null;
  created_at: string;
  last_seen_at: string | null;
  is_admin: boolean;
  active_plans: PlanId[];
}

/** Admin directory of live members, searchable by email or name. */
export async function listMembers(
  d1: D1DatabaseLike,
  env: RuntimeEnv,
  opts: { q?: string | null; limit?: number; offset?: number },
): Promise<{ members: MemberListItem[]; total: number; limit: number; offset: number }> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Math.trunc(opts.offset ?? 0) || 0, 0);
  const q = (opts.q ?? '').trim().toLowerCase().slice(0, 100);
  // LIKE wildcards in the search text are escaped so they match literally.
  const pattern = `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`;
  const where = q ? "WHERE u.deleted_at IS NULL AND (u.email LIKE ? ESCAPE '\\' OR lower(COALESCE(u.name, '')) LIKE ? ESCAPE '\\')" : 'WHERE u.deleted_at IS NULL';
  const params: unknown[] = q ? [pattern, pattern] : [];
  const totalRow = await d1.prepare(`SELECT COUNT(*) AS n FROM users u ${where}`).bind(...params).first<Row>();
  const { results } = await d1.prepare(
    `SELECT u.id, u.email, u.email_verified_at, u.name, u.created_at,
       (SELECT MAX(last_seen_at) FROM member_sessions s WHERE s.user_id = u.id) AS last_seen_at,
       (SELECT group_concat(plan) FROM subscriptions p WHERE p.user_id = u.id AND p.status = 'active' AND p.current_period_end > ?) AS plans
     FROM users u ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`
  ).bind(iso(membersRuntime.now()), ...params, limit, offset).all<Row>();
  const members = (results ?? []).map(r => {
    const verifiedAt = strOrNull(r, 'email_verified_at');
    return {
      id: str(r, 'id'),
      email: str(r, 'email'),
      email_verified: verifiedAt !== null,
      name: strOrNull(r, 'name'),
      created_at: str(r, 'created_at'),
      last_seen_at: strOrNull(r, 'last_seen_at'),
      is_admin: isAdminIdentity(str(r, 'email'), verifiedAt, env),
      active_plans: (strOrNull(r, 'plans') ?? '').split(',').filter(isPlanId),
    };
  });
  return { members, total: Number(totalRow?.n ?? 0), limit, offset };
}
