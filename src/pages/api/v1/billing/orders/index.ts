import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../lib/members/account';
import { createMemberCheckout, listOrders, toOrderView } from '../../../../../lib/members/billing';
import { requireUserId } from '../../../../../lib/members/policy';

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
  return jsonOk(await createMemberCheckout(d1, env, userId, await requireJsonBody(request), request), 201, NO_STORE);
});
