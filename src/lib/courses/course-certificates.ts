/**
 * Completion certificates: issued once an owner has completed every published lesson of a course,
 * verifiable by anyone at /certificates/{code}, and revoked when the purchase is reversed.
 */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import type { Row } from '../members/runtime';
import { iso, isUniqueViolation, membersRuntime, randomCode, randomId, siteUrl, str, strOrNull } from '../members/runtime';
import { getUserById, logActivity } from '../members/users';
import { ownsCourse } from './course-access';
import type { CourseRecord } from './course-types';

export interface CertificateView {
  code: string;
  holder_name: string;
  course_id: string;
  course_title: string;
  course_slug: string | null;
  issued_at: string;
  revoked: boolean;
  url: string;
}

function toView(r: Row, env: RuntimeEnv): CertificateView {
  const code = str(r, 'code');
  return {
    code,
    holder_name: str(r, 'holder_name'),
    course_id: str(r, 'course_id'),
    course_title: str(r, 'course_title'),
    course_slug: strOrNull(r, 'slug'),
    issued_at: str(r, 'issued_at'),
    revoked: strOrNull(r, 'revoked_at') !== null,
    url: `${siteUrl(env)}/certificates/${code}`,
  };
}

/** Published lessons of a course versus those the learner completed. */
export async function courseCompletion(d1: D1DatabaseLike, userId: string, courseId: string): Promise<{ total: number; completed: number }> {
  const row = await d1.prepare(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN p.status = 'completed' THEN 1 ELSE 0 END) AS completed
     FROM course_lessons l LEFT JOIN lesson_progress p ON p.lesson_id = l.id AND p.user_id = ?
     WHERE l.course_id = ? AND l.status = 'published'`
  ).bind(userId, courseId).first<Row>();
  return { total: Number(row?.total ?? 0), completed: Number(row?.completed ?? 0) };
}

/**
 * Issues (or re-activates) the certificate when an owner has finished every published lesson.
 * Returns the certificate when it was issued by this call, null otherwise.
 */
export async function maybeIssueCertificate(d1: D1DatabaseLike, env: RuntimeEnv, userId: string, course: CourseRecord): Promise<CertificateView | null> {
  if (!(await ownsCourse(d1, userId, course.id))) return null;
  const { total, completed } = await courseCompletion(d1, userId, course.id);
  if (total === 0 || completed < total) return null;
  const existing = await d1.prepare('SELECT * FROM course_certificates WHERE user_id = ? AND course_id = ?').bind(userId, course.id).first<Row>();
  const now = iso(membersRuntime.now());
  if (existing) {
    if (strOrNull(existing, 'revoked_at') === null) return null;
    await d1.prepare('UPDATE course_certificates SET revoked_at = NULL, issued_at = ? WHERE id = ?').bind(now, str(existing, 'id')).run();
    return getCertificate(d1, env, str(existing, 'code'));
  }
  const user = await getUserById(d1, userId);
  const holder = user?.name?.trim() || (user?.email.split('@')[0] ?? 'Learner');
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = `ZC-${randomCode(10)}`;
    try {
      await d1.prepare(
        'INSERT INTO course_certificates (id, code, user_id, course_id, holder_name, course_title, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(randomId('cert'), code, userId, course.id, holder.slice(0, 120), course.title, now).run();
      await logActivity(d1, userId, 'courses.certificate_issued', { course_id: course.id, code });
      return getCertificate(d1, env, code);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // UNIQUE(user_id, course_id): a concurrent request issued it first.
      if (await d1.prepare('SELECT 1 AS ok FROM course_certificates WHERE user_id = ? AND course_id = ?').bind(userId, course.id).first<Row>()) return null;
    }
  }
  return null;
}

export async function getCertificate(d1: D1DatabaseLike, env: RuntimeEnv, code: string): Promise<CertificateView | null> {
  const row = await d1.prepare('SELECT c.*, k.slug FROM course_certificates c LEFT JOIN courses k ON k.id = c.course_id WHERE c.code = ?')
    .bind(code.trim().toUpperCase()).first<Row>();
  return row ? toView(row, env) : null;
}

export async function listCertificates(d1: D1DatabaseLike, env: RuntimeEnv, userId: string): Promise<CertificateView[]> {
  const { results } = await d1.prepare(
    'SELECT c.*, k.slug FROM course_certificates c LEFT JOIN courses k ON k.id = c.course_id WHERE c.user_id = ? ORDER BY c.issued_at DESC'
  ).bind(userId).all<Row>();
  return (results ?? []).map(r => toView(r, env));
}
