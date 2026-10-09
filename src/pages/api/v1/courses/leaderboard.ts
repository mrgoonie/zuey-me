import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../lib/members/account';
import { leaderboard } from '../../../../lib/courses/course-gamification';

/** Top learners by XP (`?period=month` default, or `all`). Names are masked; opted-out learners are hidden. */
export const GET = memberRoute(async ({ request }, { d1, principal }) => {
  const period = new URL(request.url).searchParams.get('period') === 'all' ? 'all' : 'month';
  return jsonOk({ period, entries: await leaderboard(d1, period, principal.userId) }, 200, NO_STORE);
});
