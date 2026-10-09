import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../lib/members/account';
import { courseCatalog } from '../../../../lib/courses/course-views';

/** Published courses with the caller's personal price (subscriber discount) and ownership. */
export const GET = memberRoute(async (_ctx, { d1, env, principal }) => jsonOk(await courseCatalog(d1, env, principal), 200, NO_STORE));
