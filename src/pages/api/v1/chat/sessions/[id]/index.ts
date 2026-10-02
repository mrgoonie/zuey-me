import { requireChatUser } from '../../../../../../lib/ai/chat-service';
import { deleteSession, normalizeTitle, renameSession, requireOwnedSession, sessionDetail } from '../../../../../../lib/ai/chat-store';
import { AppError, jsonOk } from '../../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../../../lib/members/account';

/** One of your sessions with its messages, sources and artifacts (404 for anyone else's). */
export const GET = memberRoute(async ({ params }, { d1, principal }) => {
  const userId = requireChatUser(principal);
  const session = await requireOwnedSession(d1, userId, params.id ?? '');
  return jsonOk(await sessionDetail(d1, session), 200, NO_STORE);
});

/** Rename a session. Body: {title}. */
export const PATCH = memberRoute(async ({ params, request }, { d1, principal }) => {
  const userId = requireChatUser(principal);
  const body = await requireJsonBody(request);
  const title = normalizeTitle(body.title);
  if (!title) throw new AppError(400, 'invalid_field', 'title must not be empty', { field: 'title' });
  return jsonOk(await renameSession(d1, userId, params.id ?? '', title), 200, NO_STORE);
});

/** Delete a session: its messages and artifacts are removed, the row is tombstoned. */
export const DELETE = memberRoute(async ({ params }, { d1, principal }) => {
  const userId = requireChatUser(principal);
  await deleteSession(d1, userId, params.id ?? '');
  return jsonOk({ deleted: true }, 200, NO_STORE);
});
