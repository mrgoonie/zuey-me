import { jsonOk } from '../../../../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../../../../lib/members/account';
import { requireCan } from '../../../../../../../../lib/members/policy';
import { adminLessonView } from '../../../../../../../../lib/courses/course-admin-views';
import { requireCourse } from '../../../../../../../../lib/courses/course-store';
import { publishLesson, unpublishLesson } from '../../../../../../../../lib/courses/course-structure-store';

/** Publish the draft (readers get this snapshot). */
export const POST = memberRoute(async ({ params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const course = await requireCourse(d1, params.course ?? '');
  return jsonOk(adminLessonView(await publishLesson(d1, course, params.lesson ?? '')), 200, NO_STORE);
});

/** Unpublish (back to draft; readers lose access, progress is kept). */
export const DELETE = memberRoute(async ({ params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const course = await requireCourse(d1, params.course ?? '');
  return jsonOk(adminLessonView(await unpublishLesson(d1, course, params.lesson ?? '')), 200, NO_STORE);
});
