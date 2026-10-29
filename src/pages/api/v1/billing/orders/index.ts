import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../lib/members/account';
import { createMemberCheckout, listOrders, toOrderView } from '../../../../../lib/members/billing';
import { requireUserId } from '../../../../../lib/members/policy';
import { analyticsEnvFrom } from '../../../../../lib/analytics/destinations/posthog';
import { rememberGa4Client } from '../../../../../lib/analytics/ga4-attribution';

/** Your membership orders, newest first. */
export const GET = memberRoute(async (_ctx, { d1, env, principal }) => {
  const userId = requireUserId(principal, 'billing:read');
  return jsonOk((await listOrders(d1, userId)).map(o => toOrderView(o, env)), 200, NO_STORE);
});

/**
 * Start a purchase. Body: { plan, months?: 1|3|6|12, provider?: 'sepay'|'dodo' }. SePay returns a
 * prepaid order with VietQR details; Dodo returns a pending card subscription with `checkout_url`.
 */
export const POST = memberRoute(async ({ request }, { d1, env, principal }) => {
  const userId = requireUserId(principal, 'checkout:write');
  const checkout = await createMemberCheckout(d1, env, userId, await requireJsonBody(request), request);
  // The browser's GA ids (only present when GA4 ran with consent) attribute the later server purchase.
  await rememberGa4Client(d1, analyticsEnvFrom(env).PUBLIC_GA4_MEASUREMENT_ID, userId, request);
  return jsonOk(checkout, 201, NO_STORE);
});
