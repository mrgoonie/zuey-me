import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute, requireUser } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';
import { listMemberSessions, revokeOtherMemberSessions } from '../../../../../lib/members/session';
import { logActivity } from '../../../../../lib/members/users';

/** Own signed-in sessions (devices); `current` marks the calling session. */
export const GET = memberRoute(async (_ctx, { d1, principal }) => {
  requireCan(principal, 'account:read');
  const user = requireUser(principal);
  const sessions = await listMemberSessions(d1, user.id);
  return jsonOk(sessions.map(s => ({ ...s, current: s.id === principal.sessionId })), 200, NO_STORE);
});

/** Sign out every other device. Session only. */
export const DELETE = memberRoute(async ({ request }, { d1, principal }) => {
  requireCan(principal, 'account:security');
  const user = requireUser(principal);
  const revoked = await revokeOtherMemberSessions(d1, user.id, principal.sessionId ?? '');
  await logActivity(d1, user.id, 'sessions.revoked_others', { count: revoked }, request);
  return jsonOk({ revoked }, 200, NO_STORE);
});
