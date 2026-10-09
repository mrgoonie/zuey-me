import { jsonOk } from '../../../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../../../lib/members/account';
import { requireCan } from '../../../../../../../lib/members/policy';
import { requireCourse } from '../../../../../../../lib/courses/course-store';
import { deleteSection, updateSection } from '../../../../../../../lib/courses/course-structure-store';

export const PATCH = memberRoute(async ({ request, params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const course = await requireCourse(d1, params.course ?? '');
  return jsonOk(await updateSection(d1, course, params.section ?? '', await requireJsonBody(request)), 200, NO_STORE);
});

/** Refused while the section still has lessons. */
export const DELETE = memberRoute(async ({ params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const course = await requireCourse(d1, params.course ?? '');
  return jsonOk(await deleteSection(d1, course, params.section ?? ''), 200, NO_STORE);
});
