import { jsonOk } from '../../../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../../../lib/members/account';
import { requireCan } from '../../../../../../../lib/members/policy';
import { deleteAsset, updateAsset } from '../../../../../../../lib/courses/course-asset-store';
import { requireCourse } from '../../../../../../../lib/courses/course-store';

export const PATCH = memberRoute(async ({ request, params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const course = await requireCourse(d1, params.course ?? '');
  return jsonOk(await updateAsset(d1, course, params.asset ?? '', await requireJsonBody(request)), 200, NO_STORE);
});

/** Deletes the record and the R2 object (Stream videos are left in Stream). */
export const DELETE = memberRoute(async ({ params }, { d1, env, principal }) => {
  requireCan(principal, 'admin');
  const course = await requireCourse(d1, params.course ?? '');
  return jsonOk(await deleteAsset(d1, env, course, params.asset ?? ''), 200, NO_STORE);
});
