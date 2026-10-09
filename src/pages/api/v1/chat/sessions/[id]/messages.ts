import { chatSseResponse, requireChatUser, startChatTurn } from '../../../../../../lib/ai/chat-service';
import { isLocale, resolveLocale } from '../../../../../../lib/i18n/locales';
import { memberRoute, requireJsonBody } from '../../../../../../lib/members/account';
import { lessonTutorRetriever, parseTutorLessonRef } from '../../../../../../lib/courses/course-tutor-context';

/**
 * Ask Zuey AI in this session. Body: {message, locale?, course_lesson?: {course, lesson}}; with
 * `course_lesson` the tutor answers from that lesson first (the caller must be able to read it). Responds with an SSE stream
 * (`sources`, `delta`*, then `done` or `error`). Precondition failures return JSON errors:
 * 401/403 (sign-in, entitlement, scope), 404, 409 `chat_run_in_progress`, 429 `ai_quota_exceeded` / `ai_budget_exceeded`,
 * 503 `ai_unconfigured`. Disconnecting aborts the gateway run.
 */
export const POST = memberRoute(async ({ params, request }, { d1, env, principal }) => {
  requireChatUser(principal);
  const body = await requireJsonBody(request);
  const lessonRef = parseTutorLessonRef(body.course_lesson);
  const retriever = lessonRef ? await lessonTutorRetriever(d1, env, principal, lessonRef) : undefined;
  const abort = new AbortController();
  if (request.signal.aborted) abort.abort();
  request.signal.addEventListener('abort', () => abort.abort(), { once: true });
  const events = await startChatTurn({
    d1,
    env,
    principal,
    sessionId: params.id ?? '',
    message: body.message,
    locale: isLocale(body.locale) ? body.locale : resolveLocale(request),
    signal: abort.signal,
    retriever,
  });
  return chatSseResponse(events, abort);
});
