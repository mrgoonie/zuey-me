import { AppError, jsonOk } from '../../../../../../../lib/http';
import { ADMIN_NO_STORE, optionalJsonBody, referralAdminRoute } from '../../../../../../../lib/referrals/admin-route';
import { PROFILE_DECISIONS, decidePayoutProfile } from '../../../../../../../lib/referrals/payout-profile-review';

/** Admin: approve | reject (with `reason`) a payout profile; both ID images are deleted from R2 first. */
export const POST = referralAdminRoute(async (context, { d1, env, actor }) => {
  const decision = PROFILE_DECISIONS.find(d => d === context.params.action);
  if (!decision) throw new AppError(404, 'not_found', 'Unknown action');
  const body = await optionalJsonBody(context.request);
  return jsonOk(await decidePayoutProfile(d1, env, context.params.userId ?? '', decision, actor, body.reason), 200, ADMIN_NO_STORE);
});
