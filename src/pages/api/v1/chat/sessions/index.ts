import { quotaFor, requireChatUser } from '../../../../../lib/ai/chat-service';
import { createSession, listSessions, normalizeTitle } from '../../../../../lib/ai/chat-store';
import { jsonOk, readJsonObject } from '../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../lib/members/account';

/** Your chat sessions, newest first, plus this month's quota. ?limit=1..100&offset=0 */
export const GET = memberRoute(async ({ request }, { d1, env, principal }) => {
  const userId = requireChatUser(principal);
  const sp = new URL(request.url).searchParams;
  const sessions = await listSessions(d1, userId, Number(sp.get('limit') ?? 50), Number(sp.get('offset') ?? 0));
  return jsonOk({ sessions, quota: await quotaFor(d1, env, principal, userId) }, 200, NO_STORE);
});

/** Start a new chat session. Body (optional): {title}. */
export const POST = memberRoute(async ({ request }, { d1, principal }) => {
  const userId = requireChatUser(principal);
  const body = (await readJsonObject(request)) ?? {};
  const session = await createSession(d1, userId, normalizeTitle(body.title));
  return jsonOk(session, 201, NO_STORE);
});
