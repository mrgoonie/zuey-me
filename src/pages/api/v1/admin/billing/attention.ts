import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../lib/members/account';
import { listBillingAttention } from '../../../../../lib/members/billing-attention';
import { requireCan } from '../../../../../lib/members/policy';

/** Admin: SePay orders and Dodo card subscriptions flagged `needs_attention`, oldest first. */
export const GET = memberRoute(async (_ctx, { d1, principal }) => {
  requireCan(principal, 'admin');
  return jsonOk(await listBillingAttention(d1), 200, NO_STORE);
});
