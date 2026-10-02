import { jsonOk } from '../../../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../../../lib/members/account';
import { adminLabel, parseResolveInput, resolveBillingOrder } from '../../../../../../../lib/members/billing-attention';
import { requireCan } from '../../../../../../../lib/members/policy';

/** Admin: activate (grant the plan like a paid order) or dismiss (close without access) a flagged SePay order. Idempotent. */
export const POST = memberRoute(async ({ request, params }, { d1, env, principal }) => {
  requireCan(principal, 'admin');
  const input = parseResolveInput(await requireJsonBody(request));
  const result = await resolveBillingOrder(d1, env, params.code ?? '', input, adminLabel(principal), request);
  return jsonOk(result, 200, NO_STORE);
});
