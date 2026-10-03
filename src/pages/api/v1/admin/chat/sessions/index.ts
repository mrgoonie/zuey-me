import { adminChatList } from '../../../../../../lib/ai/admin-chat';
import { jsonOk } from '../../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../../lib/members/account';

/**
 * Admin: list/search stored chat sessions of every member, with aggregate stats.
 * Requires ?reason= (or X-Admin-Reason); every call is written to admin_access_audit.
 * ?q=text-or-email&user_id=&limit=1..100&offset=0
 */
export const GET = memberRoute(async ({ request }, { d1, principal }) => {
  const sp = new URL(request.url).searchParams;
  const result = await adminChatList(d1, principal, {
    reason: sp.get('reason') ?? request.headers.get('x-admin-reason'),
    q: sp.get('q'),
    userId: sp.get('user_id'),
    limit: Number(sp.get('limit') ?? 50),
    offset: Number(sp.get('offset') ?? 0),
  });
  return jsonOk(result, 200, NO_STORE);
});
