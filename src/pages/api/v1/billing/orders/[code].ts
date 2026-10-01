import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../lib/members/account';
import { getOrderFor, toOrderView } from '../../../../../lib/members/billing';
import { can, requireCan } from '../../../../../lib/members/policy';

/** One of your orders (admins may read any). Poll this until status is paid. */
export const GET = memberRoute(async ({ params }, { d1, env, principal }) => {
  const isAdmin = can(principal, 'admin');
  if (!isAdmin) requireCan(principal, 'billing:read');
  const order = await getOrderFor(d1, params.code ?? '', { userId: principal.userId, isAdmin });
  return jsonOk(toOrderView(order, env), 200, NO_STORE);
});
