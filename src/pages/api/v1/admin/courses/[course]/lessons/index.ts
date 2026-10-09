import { jsonOk } from '../../../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../../../lib/members/account';
import { requireCan } from '../../../../../../../lib/members/policy';
import { adminLessonView } from '../../../../../../../lib/courses/course-admin-views';
import { requireCourse } from '../../../../../../../lib/courses/course-store';
import { createLesson } from '../../../../../../../lib/courses/course-structure-store';

/** Body: { section_id, title, slug?, summary?, duration_minutes?, is_trial?, doc? }. */
export const POST = memberRoute(async ({ request, params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const course = await requireCourse(d1, params.course ?? '');
  return jsonOk(adminLessonView(await createLesson(d1, course, await requireJsonBody(request))), 201, NO_STORE);
});
