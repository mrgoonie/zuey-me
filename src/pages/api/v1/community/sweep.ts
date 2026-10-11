import type { APIRoute } from 'astro';
import { isCronCaller } from '../../../../lib/cron-auth';
import { errorResponse, jsonError, jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRequest } from '../../../../lib/members/account';
import { requireCan } from '../../../../lib/members/policy';
import { requireMembersDb } from '../../../../lib/members/runtime';
import { sweepCommunity } from '../../../../lib/experience/community';

/**
 * Admin or the scheduler worker (`Authorization: Bearer CRON_SECRET`): remove members whose $29 entitlement
 * lapsed and retire stale invite links. Idempotent, so a doubled or missed tick is harmless.
 */
export const POST: APIRoute = async context => {
  const env = context.locals.runtime?.env ?? {};
  try {
    if (!(await isCronCaller(context.request, env.CRON_SECRET))) {
      const { principal } = await memberRequest(context);
      requireCan(principal, 'admin');
    }
    return jsonOk(await sweepCommunity(requireMembersDb(env), env), 200, NO_STORE);
  } catch (err) {
    return errorResponse(err);
  }
};

export const GET: APIRoute = () => jsonError(405, 'method_not_allowed', 'Use POST');
