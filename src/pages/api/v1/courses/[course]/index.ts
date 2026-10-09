import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../lib/members/account';
import { courseDetail } from '../../../../../lib/courses/course-views';

/** Course page data: outline (lesson bodies excluded), personal price, ownership and progress. */
export const GET = memberRoute(async ({ params }, { d1, env, principal }) => jsonOk(await courseDetail(d1, env, principal, params.course ?? ''), 200, NO_STORE));
