import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../lib/members/account';
import { requireCan } from '../../../../lib/members/policy';
import { sweepCommunity } from '../../../../lib/experience/community';

/** Admin/cron: remove members whose $29 entitlement lapsed and retire stale invite links. */
export const POST = memberRoute(async (_context, { d1, env, principal }) => {
  requireCan(principal, 'admin');
  return jsonOk(await sweepCommunity(d1, env), 200, NO_STORE);
});
