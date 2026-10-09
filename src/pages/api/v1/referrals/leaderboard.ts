import type { APIRoute } from 'astro';
import { errorResponse, jsonOk } from '../../../../lib/http';
import { membersRuntime, requireMembersDb } from '../../../../lib/members/runtime';
import { monthlyLeaderboard, parseLeaderboardMonth } from '../../../../lib/referrals/leaderboard';

/** Public: top 10 referrers of a month (Asia/Saigon), masked names and counts only. */
export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const d1 = requireMembersDb(locals.runtime?.env ?? {});
    const month = parseLeaderboardMonth(new URL(request.url).searchParams.get('month'), membersRuntime.now());
    return jsonOk(await monthlyLeaderboard(d1, month), 200, { 'Cache-Control': 'public, max-age=300' });
  } catch (err) {
    return errorResponse(err);
  }
};
