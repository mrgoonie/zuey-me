import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';
import { resolveAccountFlag } from '../../../../../lib/members/account-flags';

/** Admin: { action: 'dismiss' | 'lock' }. Lock pauses course access and signs the account out everywhere. */
export const POST = memberRoute(async ({ request, params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const body = await requireJsonBody(request);
  return jsonOk(await resolveAccountFlag(d1, params.id ?? '', body.action), 200, NO_STORE);
});
