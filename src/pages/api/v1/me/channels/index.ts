import { listMemberBindings } from '../../../../../lib/channel-access/dewee-identity';
import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute, requireUser } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';

/** Your chat accounts linked in Dewee for the Zuey AI agent gate (sender ids shown only as a hint). */
export const GET = memberRoute(async (_ctx, { env, principal }) => {
  requireCan(principal, 'account:read');
  const user = requireUser(principal);
  return jsonOk(await listMemberBindings(env, user.id), 200, NO_STORE);
});
