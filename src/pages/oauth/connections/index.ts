import { jsonOk } from '../../../lib/http';
import { NO_STORE, memberRoute } from '../../../lib/members/account';
import { requireUserId } from '../../../lib/members/policy';
import { listConnectedApps } from '../../../lib/oauth/tokens';

/** Apps (MCP clients) the member authorized through OAuth, with scopes and last use. No token material. */
export const GET = memberRoute(async (_ctx, { d1, principal }) => {
  const userId = requireUserId(principal, 'account:read');
  return jsonOk(await listConnectedApps(d1, userId), 200, NO_STORE);
});
