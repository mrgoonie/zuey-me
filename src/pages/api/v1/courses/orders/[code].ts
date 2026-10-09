import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';
import { courseOrderView, getCourseOrderFor } from '../../../../../lib/courses/course-orders';

/** One course order (yours, or any for admins) with its payment status and VietQR while payable. */
export const GET = memberRoute(async ({ params }, { d1, env, principal }) => {
  if (principal.kind !== 'admin') requireCan(principal, 'billing:read');
  const order = await getCourseOrderFor(d1, params.code ?? '', { userId: principal.userId, isAdmin: principal.kind === 'admin' });
  return jsonOk(await courseOrderView(d1, env, order), 200, NO_STORE);
});
