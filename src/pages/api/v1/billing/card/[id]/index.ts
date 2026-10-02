import { jsonOk } from '../../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../../lib/members/account';
import { can, requireCan } from '../../../../../../lib/members/policy';
import { getCardFor, toCardView } from '../../../../../../lib/payments/dodo-billing';

/** One of your card subscriptions (admins may read any). Poll after checkout until it leaves `pending`. */
export const GET = memberRoute(async ({ params }, { d1, env, principal }) => {
  const isAdmin = can(principal, 'admin');
  if (!isAdmin) requireCan(principal, 'billing:read');
  const card = await getCardFor(d1, params.id ?? '', { userId: principal.userId, isAdmin });
  return jsonOk(toCardView(card, env), 200, NO_STORE);
});
