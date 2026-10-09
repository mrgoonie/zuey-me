import { jsonOk } from '../../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../../lib/members/account';
import { requireUserId } from '../../../../../../lib/members/policy';
import { parseIdImageSide, uploadIdImage } from '../../../../../../lib/referrals/payout-profiles';

/** Member (browser session only): upload the front or back of the national ID (raw JPEG/PNG/WebP body, ≤ 5 MB). */
export const PUT = memberRoute(async (context, { d1, env, principal }) => {
  const userId = requireUserId(principal, 'account:security');
  const profile = await uploadIdImage(d1, env, userId, parseIdImageSide(context.params.side), context.request);
  return jsonOk({ profile }, 200, NO_STORE);
});
