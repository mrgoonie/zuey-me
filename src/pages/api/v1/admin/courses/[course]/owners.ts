import { jsonOk } from '../../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../../lib/members/account';
import { requireCan } from '../../../../../../lib/members/policy';
import { AppError } from '../../../../../../lib/http';
import { grantCourseByEmail, listCourseOwners, revokeCourse } from '../../../../../../lib/courses/course-purchases';
import { requireCourse } from '../../../../../../lib/courses/course-store';

export const GET = memberRoute(async ({ params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const course = await requireCourse(d1, params.course ?? '');
  return jsonOk(await listCourseOwners(d1, course.id), 200, NO_STORE);
});

/** Admin: grant a complimentary copy. Body: { email }. */
export const POST = memberRoute(async ({ request, params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const course = await requireCourse(d1, params.course ?? '');
  const body = await requireJsonBody(request);
  return jsonOk(await grantCourseByEmail(d1, course.id, body.email), 200, NO_STORE);
});

/** Admin: revoke access without touching an order. Body: { user_id, reason }. */
export const DELETE = memberRoute(async ({ request, params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const course = await requireCourse(d1, params.course ?? '');
  const body = await requireJsonBody(request);
  if (typeof body.user_id !== 'string') throw new AppError(400, 'invalid_field', 'user_id is required', { field: 'user_id' });
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'admin';
  return jsonOk({ revoked: await revokeCourse(d1, { userId: body.user_id, courseId: course.id, reason, actor: 'admin' }) }, 200, NO_STORE);
});
