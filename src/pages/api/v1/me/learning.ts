import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../lib/members/account';
import { requireUserId } from '../../../../lib/members/policy';
import { setLeaderboardOptOut } from '../../../../lib/courses/course-gamification';
import { myLearning } from '../../../../lib/courses/course-my-learning';

/** Your courses with progress, XP, streak, badges and certificates. */
export const GET = memberRoute(async (_ctx, { d1, env, principal }) => {
  const userId = requireUserId(principal, 'account:read');
  return jsonOk(await myLearning(d1, env, userId), 200, NO_STORE);
});

/** Body: { leaderboard_opt_out: boolean }. */
export const PATCH = memberRoute(async ({ request }, { d1, principal }) => {
  const userId = requireUserId(principal, 'account:write');
  const body = await requireJsonBody(request);
  return jsonOk({ leaderboard_opt_out: await setLeaderboardOptOut(d1, userId, body.leaderboard_opt_out) }, 200, NO_STORE);
});
