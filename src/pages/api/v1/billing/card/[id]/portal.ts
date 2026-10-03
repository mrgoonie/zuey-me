import { jsonOk } from '../../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../../lib/members/account';
import { requireUserId } from '../../../../../../lib/members/policy';
import { cardPortalLink } from '../../../../../../lib/payments/dodo-billing';

/** Signed-in session only: a one-time Dodo customer portal link (card, invoices, cancellation). */
export const POST = memberRoute(async ({ params }, { d1, env, principal }) => {
  const userId = requireUserId(principal, 'account:security');
  return jsonOk(await cardPortalLink(d1, env, userId, params.id ?? ''), 200, NO_STORE);
});
