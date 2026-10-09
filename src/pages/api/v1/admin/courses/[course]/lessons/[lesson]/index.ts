import { jsonOk } from '../../../../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../../../../lib/members/account';
import { requireCan } from '../../../../../../../../lib/members/policy';
import { adminLessonView } from '../../../../../../../../lib/courses/course-admin-views';
import { requireCourse } from '../../../../../../../../lib/courses/course-store';
import { deleteLesson, requireLesson, updateLesson } from '../../../../../../../../lib/courses/course-structure-store';

/** Admin: lesson with its draft and published documents (quiz answers included). */
export const GET = memberRoute(async ({ params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const course = await requireCourse(d1, params.course ?? '');
  return jsonOk(adminLessonView(await requireLesson(d1, course.id, params.lesson ?? '')), 200, NO_STORE);
});

/** Updates metadata and/or the draft `doc`; pass `expected_revision` to avoid overwriting a concurrent edit. */
export const PATCH = memberRoute(async ({ request, params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const course = await requireCourse(d1, params.course ?? '');
  return jsonOk(adminLessonView(await updateLesson(d1, course, params.lesson ?? '', await requireJsonBody(request))), 200, NO_STORE);
});

export const DELETE = memberRoute(async ({ params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const course = await requireCourse(d1, params.course ?? '');
  return jsonOk(await deleteLesson(d1, course, params.lesson ?? ''), 200, NO_STORE);
});
