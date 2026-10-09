import { AppError, jsonOk } from '../../../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../../../lib/members/account';
import { completeLesson } from '../../../../../../../lib/courses/course-learning';
import { requireReadableLesson } from '../../../../../../../lib/courses/course-views';

/** Mark a lesson completed: XP once, streak, and a certificate when the whole course is done. */
export const POST = memberRoute(async ({ params }, { d1, env, principal }) => {
  const { course, lesson } = await requireReadableLesson(d1, principal, params.course ?? '', params.lesson ?? '');
  if (!principal.userId) throw new AppError(401, 'unauthorized', 'Sign in to track progress');
  return jsonOk(await completeLesson(d1, env, principal.userId, course, lesson), 200, NO_STORE);
});
