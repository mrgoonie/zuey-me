import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk } from '../../../../../lib/http';
import { isCronCaller } from '../../../../../lib/cron-auth';
import { membersRuntime, requireMembersDb } from '../../../../../lib/members/runtime';
import { runReferralJobs } from '../../../../../lib/referrals/jobs';
import { requireAdminActor } from '../../../../../lib/taxonomy/admin';

/** Cron/admin: mature commissions, refresh tiers, and on day 1 (Asia/Saigon) close payouts. Idempotent. */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    if (!(await isCronCaller(request, env.CRON_SECRET))) await requireAdminActor(request, env);
    return jsonOk(await runReferralJobs(requireMembersDb(env), env, membersRuntime.now()), 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};

export const GET: APIRoute = () => jsonError(405, 'method_not_allowed', 'Use POST');
