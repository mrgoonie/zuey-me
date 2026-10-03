import { adminChatRead } from '../../../../../../lib/ai/admin-chat';
import { jsonOk } from '../../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../../lib/members/account';

/** Admin: read one member's chat session. Requires ?reason= (or X-Admin-Reason); audited. */
export const GET = memberRoute(async ({ params, request }, { d1, principal }) => {
  const reason = new URL(request.url).searchParams.get('reason') ?? request.headers.get('x-admin-reason');
  return jsonOk(await adminChatRead(d1, principal, params.id ?? '', reason), 200, NO_STORE);
});
