import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../lib/members/account';
import { reconcileSepay } from '../../../../lib/members/billing';
import { requireCan } from '../../../../lib/members/policy';

/** Admin: match recent SePay transactions (user API, SEPAY_API_TOKEN) against ZSB orders; webhook fallback. */
export const POST = memberRoute(async (_ctx, { d1, env, principal }) => {
  requireCan(principal, 'admin');
  return jsonOk(await reconcileSepay(d1, env), 200, NO_STORE);
});
