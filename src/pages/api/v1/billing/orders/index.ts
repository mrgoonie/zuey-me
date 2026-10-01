import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../lib/members/account';
import { createOrder, listOrders, toOrderView } from '../../../../../lib/members/billing';
import { requireUserId } from '../../../../../lib/members/policy';

/** Your membership orders, newest first. */
export const GET = memberRoute(async (_ctx, { d1, env, principal }) => {
  const userId = requireUserId(principal, 'billing:read');
  return jsonOk((await listOrders(d1, userId)).map(o => toOrderView(o, env)), 200, NO_STORE);
});

/** Create a SePay prepay order. Body: { plan, months: 1|3|6|12 }. Returns VietQR transfer details. */
export const POST = memberRoute(async ({ request }, { d1, env, principal }) => {
  const userId = requireUserId(principal, 'checkout:write');
  const order = await createOrder(d1, env, userId, await requireJsonBody(request), request);
  return jsonOk(toOrderView(order, env), 201, NO_STORE);
});
