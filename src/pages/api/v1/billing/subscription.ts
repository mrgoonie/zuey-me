import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../lib/members/account';
import { requireUserId } from '../../../../lib/members/policy';
import { getEntitlements, listSubscriptions } from '../../../../lib/members/subscriptions';

/** Your plans with period end dates and the entitlements currently in effect. */
export const GET = memberRoute(async (_ctx, { d1, principal }) => {
  const userId = requireUserId(principal, 'billing:read');
  const [subscriptions, effective] = await Promise.all([listSubscriptions(d1, userId), getEntitlements(d1, userId)]);
  return jsonOk({ subscriptions, active_plans: effective.plans, entitlements: effective.entitlements }, 200, NO_STORE);
});
