import { jsonOk } from '../../../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../../../lib/members/account';
import { signLessonMedia } from '../../../../../../../lib/courses/course-views';

/** Short-lived URL for a lesson video, audio or file. Body: { asset_id }. */
export const POST = memberRoute(async ({ request, params }, { d1, env, principal }) => {
  const body = await requireJsonBody(request);
  return jsonOk(await signLessonMedia(d1, env, principal, params.course ?? '', params.lesson ?? '', body.asset_id), 200, NO_STORE);
});
