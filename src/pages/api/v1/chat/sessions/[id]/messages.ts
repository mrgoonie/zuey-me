import { chatSseResponse, requireChatUser, startChatTurn } from '../../../../../../lib/ai/chat-service';
import { isLocale, resolveLocale } from '../../../../../../lib/i18n/locales';
import { memberRoute, requireJsonBody } from '../../../../../../lib/members/account';

/**
 * Ask Zuey AI in this session. Body: {message, locale?}. Responds with an SSE stream
 * (`sources`, `delta`*, then `done` or `error`). Precondition failures return JSON errors:
 * 401/403 (sign-in, entitlement, scope), 404, 409 `chat_run_in_progress`, 429 `ai_quota_exceeded`,
 * 503 `ai_unconfigured`. Disconnecting aborts the gateway run.
 */
export const POST = memberRoute(async ({ params, request }, { d1, env, principal }) => {
  requireChatUser(principal);
  const body = await requireJsonBody(request);
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
  });
  return chatSseResponse(events, abort);
});
