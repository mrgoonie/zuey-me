import { jsonOk } from '../../../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../../../lib/members/account';
import { requireCan } from '../../../../../../../lib/members/policy';
import { requireCourse } from '../../../../../../../lib/courses/course-store';
import { createSection } from '../../../../../../../lib/courses/course-structure-store';

export const POST = memberRoute(async ({ request, params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const course = await requireCourse(d1, params.course ?? '');
  return jsonOk(await createSection(d1, course, await requireJsonBody(request)), 201, NO_STORE);
});
