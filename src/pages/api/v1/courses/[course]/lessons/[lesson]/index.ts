import { jsonOk } from '../../../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../../../lib/members/account';
import { lessonView } from '../../../../../../../lib/courses/course-views';

/** One lesson. `document` is null with a `denial` reason when the caller may not read it. */
export const GET = memberRoute(async ({ params, request }, { d1, env, principal }) =>
  jsonOk(await lessonView(d1, env, principal, params.course ?? '', params.lesson ?? '', request), 200, NO_STORE));
