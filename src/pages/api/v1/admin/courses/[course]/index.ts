import { jsonOk } from '../../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../../lib/members/account';
import { requireCan } from '../../../../../../lib/members/policy';
import { adminCourseView } from '../../../../../../lib/courses/course-admin-views';
import { deleteCourse, requireCourse, updateCourse } from '../../../../../../lib/courses/course-store';

/** Admin: course with its full outline (drafts included), media assets and owner count. */
export const GET = memberRoute(async ({ params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  return jsonOk(await adminCourseView(d1, await requireCourse(d1, params.course ?? '')), 200, NO_STORE);
});

export const PATCH = memberRoute(async ({ request, params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  return jsonOk(await updateCourse(d1, params.course ?? '', await requireJsonBody(request)), 200, NO_STORE);
});

/** Admin: soft-delete; refused while anyone owns the course (archive it instead). */
export const DELETE = memberRoute(async ({ params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  return jsonOk(await deleteCourse(d1, params.course ?? ''), 200, NO_STORE);
});
