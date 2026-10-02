import { jsonOk } from '../../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../../lib/members/account';
import { requireUserId } from '../../../../../../lib/members/policy';
import { cancelCardSubscription } from '../../../../../../lib/payments/dodo-billing';

/** Signed-in session only: stop renewing at the end of the paid period (access continues until then). */
export const POST = memberRoute(async ({ params, request }, { d1, env, principal }) => {
  const userId = requireUserId(principal, 'account:security');
  return jsonOk(await cancelCardSubscription(d1, env, userId, params.id ?? '', request), 200, NO_STORE);
});
