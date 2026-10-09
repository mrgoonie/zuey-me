import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../lib/members/account';
import { requireUserId } from '../../../../../lib/members/policy';
import { getPayoutProfile, savePayoutProfile } from '../../../../../lib/referrals/payout-profiles';

/** Member: payout details and review status (ID images are never returned, only has_id_front/back). */
export const GET = memberRoute(async (_context, { d1, principal }) => {
  const userId = requireUserId(principal, 'account:read');
  return jsonOk({ profile: await getPayoutProfile(d1, userId) }, 200, NO_STORE);
});

/** Member (browser session only): save VN bank or PayPal details; any change needs a new admin review. */
export const PUT = memberRoute(async (context, { d1, env, principal }) => {
  const userId = requireUserId(principal, 'account:security');
  const profile = await savePayoutProfile(d1, env, userId, await requireJsonBody(context.request));
  return jsonOk({ profile }, 200, NO_STORE);
});
