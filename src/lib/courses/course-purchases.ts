/**
 * Course ownership. `grantCourse` and `revokeCourse` are the only writers of `course_purchases`, so
 * every path (payment, refund, chargeback, admin) also syncs GitHub access and the activity log.
 */
import type { D1DatabaseLike, D1PreparedStatementLike, SqlCondition } from '../../db/store';
import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { iso, membersRuntime, randomId, str, strOrNull } from '../members/runtime';
import { activityStatement, getUserById } from '../members/users';
import { githubSyncStatements } from './course-github-invites';
import { getCourseById } from './course-store';
import type { CourseRecord } from './course-types';

export interface PurchaseView {
  course_id: string;
  source: 'purchase' | 'grant';
  status: 'active' | 'revoked';
  order_id: string | null;
  granted_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

function rowToPurchase(r: Row): PurchaseView {
  return {
    course_id: str(r, 'course_id'),
    source: str(r, 'source') === 'grant' ? 'grant' : 'purchase',
    status: str(r, 'status') === 'revoked' ? 'revoked' : 'active',
    order_id: strOrNull(r, 'order_id'),
    granted_at: str(r, 'granted_at'),
    revoked_at: strOrNull(r, 'revoked_at'),
    revoked_reason: strOrNull(r, 'revoked_reason'),
  };
}

export async function getPurchase(d1: D1DatabaseLike, userId: string, courseId: string): Promise<PurchaseView | null> {
  const row = await d1.prepare('SELECT * FROM course_purchases WHERE user_id = ? AND course_id = ?').bind(userId, courseId).first<Row>();
  return row ? rowToPurchase(row) : null;
}

export async function listPurchases(d1: D1DatabaseLike, userId: string): Promise<PurchaseView[]> {
  const { results } = await d1.prepare('SELECT * FROM course_purchases WHERE user_id = ? ORDER BY granted_at DESC').bind(userId).all<Row>();
  return (results ?? []).map(rowToPurchase);
}

/**
 * Activates ownership (idempotent), queues the GitHub invites and logs it, as one D1 batch: a failed write (the
 * activity log included) fails the whole grant and leaves nothing written. Returns false when it was already active.
 */
export async function grantCourse(d1: D1DatabaseLike, input: GrantInput): Promise<boolean> {
  const course = await getCourseById(d1, input.courseId);
  if (!course) throw new AppError(404, 'course_not_found', 'Course not found');
  const results = await d1.batch(grantCourseStatements(d1, course, input));
  return Boolean(results.at(-1)?.meta?.changes);
}

type GrantInput = { userId: string; courseId: string; orderId: string | null; source: 'purchase' | 'grant'; actor?: string };

function grantDetail(course: Pick<CourseRecord, 'id' | 'slug'>, input: GrantInput): Record<string, unknown> {
  return { course_id: course.id, slug: course.slug, source: input.source, order_id: input.orderId, actor: input.actor ?? 'system' };
}

/** Activates ownership; with `onlyIf`, only while it holds. The WHERE clause also keeps SQLite from reading ON as a join constraint. */
function purchaseUpsertStatement(d1: D1DatabaseLike, input: GrantInput, onlyIf?: SqlCondition): D1PreparedStatementLike {
  return d1.prepare(
    `INSERT INTO course_purchases (id, user_id, course_id, order_id, source, status, granted_at)
     SELECT ?, ?, ?, ?, ?, 'active', ? WHERE ${onlyIf?.sql ?? 'true'}
     ON CONFLICT (user_id, course_id) DO UPDATE SET status = 'active', order_id = excluded.order_id, source = excluded.source,
       granted_at = excluded.granted_at, revoked_at = NULL, revoked_reason = NULL`
  ).bind(randomId('cpu'), input.userId, input.courseId, input.orderId, input.source, iso(membersRuntime.now()), ...(onlyIf?.params ?? []));
}

/**
 * The writes of `grantCourse` for a caller that makes them part of one D1 batch: they apply only while the course is
 * not active for the user and `onlyIf` holds when the batch runs. The purchase upsert is the last statement, so the
 * conditions hold for every earlier one and its result says whether access was granted. A failed activity insert
 * fails the batch.
 */
export function grantCourseStatements(
  d1: D1DatabaseLike, course: Pick<CourseRecord, 'id' | 'slug' | 'github_repos'>, input: GrantInput, onlyIf?: SqlCondition,
): D1PreparedStatementLike[] {
  const inactive: SqlCondition = {
    sql: `NOT EXISTS (SELECT 1 FROM course_purchases WHERE user_id = ? AND course_id = ? AND status = 'active')${onlyIf ? ` AND (${onlyIf.sql})` : ''}`,
    params: [input.userId, input.courseId, ...(onlyIf?.params ?? [])],
  };
  return [
    ...githubSyncStatements(d1, input.userId, course, 'invite', inactive),
    activityStatement(d1, input.userId, 'courses.granted', grantDetail(course, input), undefined, inactive),
    purchaseUpsertStatement(d1, input, inactive),
  ];
}

/**
 * Ends ownership, revokes the certificate, queues the GitHub removal and logs it, as one D1 batch: a failed write
 * (the activity log included) fails the whole revoke and leaves nothing written. Returns false when nothing was active.
 */
export async function revokeCourse(
  d1: D1DatabaseLike, input: { userId: string; courseId: string; reason: string; actor?: string },
): Promise<boolean> {
  const course = await getCourseById(d1, input.courseId);
  const results = await d1.batch(revokeCourseStatements(d1, course, input));
  return Boolean(results.at(-1)?.meta?.changes);
}

/**
 * The writes of `revokeCourse` for a caller that makes them part of one D1 batch: they apply only while the
 * course is active for the user (granted by `orderId` when given) and `onlyIf` holds when the batch runs. The
 * purchase update is the last statement, so the conditions hold for every earlier one and its result says
 * whether access was revoked. A failed activity insert fails the batch.
 */
export function revokeCourseStatements(
  d1: D1DatabaseLike, course: Pick<CourseRecord, 'id' | 'github_repos'> | null,
  input: { userId: string; courseId: string; reason: string; actor?: string; orderId?: string },
  onlyIf?: SqlCondition,
): D1PreparedStatementLike[] {
  const now = iso(membersRuntime.now());
  const owner = input.orderId ? ' AND order_id = ?' : '';
  const ownerParams = input.orderId ? [input.orderId] : [];
  const extra = onlyIf ? { sql: ` AND (${onlyIf.sql})`, params: onlyIf.params } : { sql: '', params: [] };
  const active: SqlCondition = {
    sql: `EXISTS (SELECT 1 FROM course_purchases WHERE user_id = ? AND course_id = ? AND status = 'active'${owner})${extra.sql}`,
    params: [input.userId, input.courseId, ...ownerParams, ...extra.params],
  };
  return [
    d1.prepare(`UPDATE course_certificates SET revoked_at = ? WHERE user_id = ? AND course_id = ? AND revoked_at IS NULL AND ${active.sql}`)
      .bind(now, input.userId, input.courseId, ...active.params),
    ...(course ? githubSyncStatements(d1, input.userId, course, 'remove', active) : []),
    activityStatement(d1, input.userId, 'courses.revoked', { course_id: input.courseId, reason: input.reason, actor: input.actor ?? 'system' }, undefined, active),
    d1.prepare(
      `UPDATE course_purchases SET status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND course_id = ? AND status = 'active'${owner}${extra.sql}`
    ).bind(now, input.reason.slice(0, 200), input.userId, input.courseId, ...ownerParams, ...extra.params),
  ];
}
export interface CourseOwnerRow { user_id: string; email: string | null; source: string; status: string; granted_at: string; revoked_reason: string | null }

/** Admin: who owns (or owned) a course. */
export async function listCourseOwners(d1: D1DatabaseLike, courseId: string, limit = 200): Promise<CourseOwnerRow[]> {
  const { results } = await d1.prepare(
    `SELECT p.user_id, u.email, p.source, p.status, p.granted_at, p.revoked_reason
     FROM course_purchases p LEFT JOIN users u ON u.id = p.user_id WHERE p.course_id = ? ORDER BY p.granted_at DESC LIMIT ?`
  ).bind(courseId, limit).all<Row>();
  return (results ?? []).map(r => ({
    user_id: str(r, 'user_id'), email: strOrNull(r, 'email'), source: str(r, 'source'), status: str(r, 'status'),
    granted_at: str(r, 'granted_at'), revoked_reason: strOrNull(r, 'revoked_reason'),
  }));
}

/** Admin grant by email (comp copies, support fixes). */
export async function grantCourseByEmail(d1: D1DatabaseLike, courseId: string, email: unknown): Promise<{ user_id: string; granted: boolean }> {
  if (typeof email !== 'string' || !email.includes('@')) throw new AppError(400, 'invalid_field', 'email is required', { field: 'email' });
  const row = await d1.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL').bind(email.trim().toLowerCase()).first<Row>();
  if (!row) throw new AppError(404, 'user_not_found', 'No member account with this email');
  const user = await getUserById(d1, str(row, 'id'));
  if (!user) throw new AppError(404, 'user_not_found', 'No member account with this email');
  return { user_id: user.id, granted: await grantCourse(d1, { userId: user.id, courseId, orderId: null, source: 'grant', actor: 'admin' }) };
}
