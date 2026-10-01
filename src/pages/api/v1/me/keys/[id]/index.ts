import { jsonOk } from '../../../../../../lib/http';
import { NO_STORE, memberRoute, requireUser } from '../../../../../../lib/members/account';
import { revokeUserKey, toKeyView } from '../../../../../../lib/members/api-keys';
import { requireCan } from '../../../../../../lib/members/policy';
import { membersRuntime } from '../../../../../../lib/members/runtime';
import { logActivity } from '../../../../../../lib/members/users';

/** Revoke one of your keys immediately (404 for anyone else's). Session only. */
export const DELETE = memberRoute(async ({ params, request }, { d1, principal }) => {
  requireCan(principal, 'keys:manage');
  const user = requireUser(principal);
  const key = await revokeUserKey(d1, user.id, params.id ?? '');
  await logActivity(d1, user.id, 'api_key.revoked', { key_id: key.id, prefix: key.prefix }, request);
  return jsonOk(toKeyView(key, membersRuntime.now()), 200, NO_STORE);
});
