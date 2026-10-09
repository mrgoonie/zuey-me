import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../lib/members/account';
import { requireUserId } from '../../../../lib/members/policy';
import { bindReferralCode } from '../../../../lib/referrals/member-api';

/** Member: bind a referrer by code (only for accounts without one that have never paid). Permanent. */
export const POST = memberRoute(async (context, { d1, principal }) => {
  const userId = requireUserId(principal, 'account:write');
  const body = await requireJsonBody(context.request);
  return jsonOk(await bindReferralCode(d1, userId, body.code), 200, NO_STORE);
});
