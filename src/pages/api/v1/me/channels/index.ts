import { listMemberBindings } from '../../../../../lib/channel-access/dewee-identity';
import { consumeRateLimit } from '../../../../../lib/courses/course-abuse-guards';
import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute, requireUser } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';

/**
 * Your chat accounts linked in Dewee for the Zuey AI agent gate (sender ids shown only as a hint). Browser session
 * only and throttled per member: each call opens a Dewee identity session, which makes Dewee keep a record for
 * the member, so it runs only when the member asks for the list.
 */
export const GET = memberRoute(async (_ctx, { d1, env, principal }) => {
  requireCan(principal, 'account:security');
  const user = requireUser(principal);
  await consumeRateLimit(d1, 'channelBindings', user.id);
  return jsonOk(await listMemberBindings(env, user.id), 200, NO_STORE);
});
