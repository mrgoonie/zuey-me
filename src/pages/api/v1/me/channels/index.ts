import { listMemberBindings } from '../../../../../lib/channel-access/dewee-identity';
import { consumeRateLimit } from '../../../../../lib/courses/course-abuse-guards';
import { AppError, jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute, requireUser } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';

/**
 * Your chat accounts linked in Dewee for the Zuey AI agent gate (sender ids shown only as a hint). Browser session
 * only and throttled per member: each call opens a Dewee identity session, which makes Dewee keep a record for
 * the member, so it runs only when the member asks for the list. A GET is not covered by the Origin check, so a
 * request the browser marks as coming from another site (e.g. a cross-site top-level navigation) is refused.
 */
export const GET = memberRoute(async ({ request }, { d1, env, principal }) => {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new AppError(403, 'cross_site_request', 'This request must come from zuey.me');
  }
  requireCan(principal, 'account:security');
  const user = requireUser(principal);
  await consumeRateLimit(d1, 'channelBindings', user.id);
  return jsonOk(await listMemberBindings(env, user.id), 200, NO_STORE);
});
