import { requireChatUser } from '../../../../lib/ai/chat-service';
import { exportSessions } from '../../../../lib/ai/chat-store';
import { NO_STORE, memberRoute } from '../../../../lib/members/account';

/** Download all of your stored chat sessions, messages, sources, artifacts and usage as JSON. */
export const GET = memberRoute(async (_ctx, { d1, principal }) => {
  const userId = requireChatUser(principal);
  const data = await exportSessions(d1, userId);
  return new Response(JSON.stringify({ success: true, data }, null, 2), {
    headers: {
      ...NO_STORE,
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="zuey-ai-chats-${userId}.json"`,
    },
  });
});
