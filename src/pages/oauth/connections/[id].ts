import { jsonOk } from '../../../lib/http';
import { NO_STORE, memberRoute } from '../../../lib/members/account';
import { requireUserId } from '../../../lib/members/policy';
import { logActivity } from '../../../lib/members/users';
import { revokeConnectedApp } from '../../../lib/oauth/tokens';

/** Disconnects an app: revokes the consent and every access/refresh token it holds. Browser session only. */
export const DELETE = memberRoute(async ({ params, request }, { d1, principal }) => {
  const userId = requireUserId(principal, 'account:security');
  const revoked = await revokeConnectedApp(d1, userId, params.id ?? '');
  await logActivity(d1, userId, 'oauth.revoked', revoked, request);
  return jsonOk({ revoked: true, ...revoked }, 200, NO_STORE);
});
