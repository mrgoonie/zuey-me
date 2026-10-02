import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../lib/members/account';
import { communityStatus } from '../../../../lib/experience/community';

/** Community status for the caller: configuration, entitlement and own invites/memberships. */
export const GET = memberRoute(async (_context, { d1, env, principal }) => {
  return jsonOk(await communityStatus(d1, env, principal), 200, NO_STORE);
});
