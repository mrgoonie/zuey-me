import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../lib/members/account';
import { subscriptionSummary } from '../../../../lib/members/billing';
import { requireUserId } from '../../../../lib/members/policy';

/** Your plans with period end dates, card subscriptions and the entitlements currently in effect. */
export const GET = memberRoute(async (_ctx, { d1, env, principal }) => {
  const userId = requireUserId(principal, 'billing:read');
  return jsonOk(await subscriptionSummary(d1, env, userId), 200, NO_STORE);
});
