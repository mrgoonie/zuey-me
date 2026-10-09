import { AppError, jsonOk } from '../../../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../../../lib/members/account';
import { consumeRateLimit } from '../../../../../../../lib/courses/course-abuse-guards';
import { gradeQuiz, submitQuiz } from '../../../../../../../lib/courses/course-learning';
import { requireReadableLesson } from '../../../../../../../lib/courses/course-views';
import { findQuiz, parseStoredLesson } from '../../../../../../../lib/courses/lesson-blocks';

/**
 * Grade a quiz. Body: { block_id, answers: { [questionId]: optionId | optionId[] } }. Correct answers
 * and explanations are returned only here, after submission. Callers without an account (admin keys,
 * visitors on a trial lesson) are graded but nothing is stored; admins grade the draft of unpublished lessons.
 */
export const POST = memberRoute(async ({ request, params }, { d1, principal }) => {
  const body = await requireJsonBody(request);
  if (typeof body.block_id !== 'string') throw new AppError(400, 'invalid_field', 'block_id is required', { field: 'block_id' });
  const { lesson } = await requireReadableLesson(d1, principal, params.course ?? '', params.lesson ?? '');
  const draft = principal.kind === 'admin' && lesson.status !== 'published';
  if (!principal.userId || draft) {
    const doc = parseStoredLesson(draft ? lesson.draft_json : lesson.published_json);
    const quiz = doc ? findQuiz(doc, body.block_id) : null;
    if (!quiz) throw new AppError(404, 'quiz_not_found', 'Quiz not found in this lesson');
    return jsonOk({ ...gradeQuiz(quiz, body.answers), xp_awarded: 0, preview: true }, 200, NO_STORE);
  }
  await consumeRateLimit(d1, 'quiz', principal.userId);
  return jsonOk(await submitQuiz(d1, principal.userId, lesson, body.block_id, body.answers), 200, NO_STORE);
});
