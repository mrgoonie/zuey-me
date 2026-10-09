import { jsonOk } from '../../../../../../../lib/http';
import { decideCommission, parseCommissionDecision } from '../../../../../../../lib/referrals/admin-api';
import { ADMIN_NO_STORE, optionalJsonBody, referralAdminRoute } from '../../../../../../../lib/referrals/admin-route';

/** Admin: approve | reject | reverse one commission, with an optional `note`. */
export const POST = referralAdminRoute(async (context, { d1, actor }) => {
  const decision = parseCommissionDecision(context.params.action);
  const body = await optionalJsonBody(context.request);
  return jsonOk(await decideCommission(d1, context.params.id ?? '', decision, actor, body.note), 200, ADMIN_NO_STORE);
});
