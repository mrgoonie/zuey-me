/**
 * Course ownership. `grantCourse` and `revokeCourse` are the only writers of `course_purchases`, so
 * every path (payment, refund, chargeback, admin) also syncs GitHub access and the activity log.
 */
import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { iso, membersRuntime, randomId, str, strOrNull } from '../members/runtime';
import { getUserById, logActivity } from '../members/users';
import { enqueueGithubSync } from './course-github-invites';
import { getCourseById } from './course-store';

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

/** Activates ownership (idempotent) and queues GitHub invites. Returns false when it was already active. */
export async function grantCourse(
  d1: D1DatabaseLike, input: { userId: string; courseId: string; orderId: string | null; source: 'purchase' | 'grant'; actor?: string },
): Promise<boolean> {
  const course = await getCourseById(d1, input.courseId);
  if (!course) throw new AppError(404, 'course_not_found', 'Course not found');
  const existing = await getPurchase(d1, input.userId, input.courseId);
  if (existing?.status === 'active') return false;
  const now = iso(membersRuntime.now());
  await d1.prepare(
    `INSERT INTO course_purchases (id, user_id, course_id, order_id, source, status, granted_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)
     ON CONFLICT (user_id, course_id) DO UPDATE SET status = 'active', order_id = excluded.order_id, source = excluded.source,
       granted_at = excluded.granted_at, revoked_at = NULL, revoked_reason = NULL`
  ).bind(randomId('cpu'), input.userId, input.courseId, input.orderId, input.source, now).run();
  await enqueueGithubSync(d1, input.userId, course, 'invite');
  await logActivity(d1, input.userId, 'courses.granted', { course_id: course.id, slug: course.slug, source: input.source, order_id: input.orderId, actor: input.actor ?? 'system' });
  return true;
}

/** Ends ownership, removes GitHub access and revokes the certificate. Returns false when nothing was active. */
export async function revokeCourse(
  d1: D1DatabaseLike, input: { userId: string; courseId: string; reason: string; actor?: string },
): Promise<boolean> {
  const now = iso(membersRuntime.now());
  const res = await d1.prepare(
    "UPDATE course_purchases SET status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND course_id = ? AND status = 'active'"
  ).bind(now, input.reason.slice(0, 200), input.userId, input.courseId).run();
  if (!res.meta?.changes) return false;
  await d1.prepare('UPDATE course_certificates SET revoked_at = ? WHERE user_id = ? AND course_id = ? AND revoked_at IS NULL').bind(now, input.userId, input.courseId).run();
  const course = await getCourseById(d1, input.courseId);
  if (course) await enqueueGithubSync(d1, input.userId, course, 'remove');
  await logActivity(d1, input.userId, 'courses.revoked', { course_id: input.courseId, reason: input.reason, actor: input.actor ?? 'system' });
  return true;
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
