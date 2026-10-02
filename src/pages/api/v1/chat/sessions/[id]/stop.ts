import { requireChatUser } from '../../../../../../lib/ai/chat-service';
import { requestStop } from '../../../../../../lib/ai/chat-store';
import { jsonOk } from '../../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../../lib/members/account';

/** Stop the reply currently streaming in this session (works from any tab or device). */
export const POST = memberRoute(async ({ params }, { d1, principal }) => {
  const userId = requireChatUser(principal);
  const stopping = await requestStop(d1, userId, params.id ?? '');
  return jsonOk({ stopping }, 200, NO_STORE);
});
