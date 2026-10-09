import { jsonOk } from '../../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../../lib/members/account';
import { requireCan } from '../../../../../../lib/members/policy';
import { courseOrderView } from '../../../../../../lib/courses/course-orders';
import { resolveCourseOrder } from '../../../../../../lib/courses/course-order-payments';

/** Admin: { action: 'grant'|'dismiss'|'refund', reason? }. Refund records a manual refund and revokes access. */
export const POST = memberRoute(async ({ request, params }, { d1, env, principal }) => {
  requireCan(principal, 'admin');
  const body = await requireJsonBody(request);
  const order = await resolveCourseOrder(d1, env, params.code ?? '', body.action, body.reason);
  return jsonOk(await courseOrderView(d1, env, order), 200, NO_STORE);
});
