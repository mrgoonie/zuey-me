import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../lib/members/account';
import { reconcileSepay } from '../../../../lib/members/billing';
import { requireCan } from '../../../../lib/members/policy';
import { applyCourseSepayPayment } from '../../../../lib/courses/course-payment-webhooks';

/** Admin: match recent SePay transactions (user API, SEPAY_API_TOKEN) against ZSB membership and ZSC course orders; webhook fallback. */
export const POST = memberRoute(async (_ctx, { d1, env, principal }) => {
  requireCan(principal, 'admin');
  return jsonOk(await reconcileSepay(d1, env, n => applyCourseSepayPayment(d1, env, n)), 200, NO_STORE);
});
