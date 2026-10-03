import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute, requireUser } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';
import { clearMemberCookie, revokeMemberSession } from '../../../../../lib/members/session';
import { logActivity } from '../../../../../lib/members/users';

/** Revoke one of your own sessions (404 for anyone else's). Session only. */
export const DELETE = memberRoute(async ({ params, request }, { d1, principal }) => {
  requireCan(principal, 'account:security');
  const user = requireUser(principal);
  const id = params.id ?? '';
  await revokeMemberSession(d1, user.id, id);
  await logActivity(d1, user.id, 'session.revoked', { session_id: id }, request);
  const headers: Record<string, string> = { ...NO_STORE };
  if (id === principal.sessionId) headers['Set-Cookie'] = clearMemberCookie();
  return jsonOk({ revoked: true, current: id === principal.sessionId }, 200, headers);
});
