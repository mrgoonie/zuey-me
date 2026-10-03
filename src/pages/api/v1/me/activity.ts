import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute, requireUser } from '../../../../lib/members/account';
import { requireCan } from '../../../../lib/members/policy';
import { listActivity } from '../../../../lib/members/users';

/** Own account activity (sign-ins, profile, keys, billing), newest first. ?limit=1..200 */
export const GET = memberRoute(async ({ request }, { d1, principal }) => {
  requireCan(principal, 'account:read');
  const user = requireUser(principal);
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? 50);
  return jsonOk(await listActivity(d1, user.id, limit), 200, NO_STORE);
});
