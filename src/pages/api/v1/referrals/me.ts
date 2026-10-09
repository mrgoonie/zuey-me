import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../lib/members/account';
import { requireUserId } from '../../../../lib/members/policy';
import { buildReferralMe, updateReferralMe } from '../../../../lib/referrals/member-api';

/** Member: referral link, rate and tier, split, balances, recent commissions and payouts, next close date. */
export const GET = memberRoute(async (_context, { d1, env, principal }) => {
  const userId = requireUserId(principal, 'account:read');
  return jsonOk(await buildReferralMe(d1, env, userId), 200, NO_STORE);
});

/** Member: set the referee discount (0 ≤ d ≤ R) and/or the leaderboard opt-out. */
export const PATCH = memberRoute(async (context, { d1, env, principal }) => {
  const userId = requireUserId(principal, 'account:write');
  return jsonOk(await updateReferralMe(d1, env, userId, await requireJsonBody(context.request)), 200, NO_STORE);
});
