import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../lib/members/account';
import { listMembers } from '../../../../lib/members/directory';
import { requireCan } from '../../../../lib/members/policy';

/** Admin: list/search members. ?q=email-or-name&limit=1..200&offset=0 */
export const GET = memberRoute(async ({ request }, { d1, env, principal }) => {
  requireCan(principal, 'admin');
  const sp = new URL(request.url).searchParams;
  const result = await listMembers(d1, env, { q: sp.get('q'), limit: Number(sp.get('limit') ?? 50), offset: Number(sp.get('offset') ?? 0) });
  return jsonOk(result, 200, NO_STORE);
});
