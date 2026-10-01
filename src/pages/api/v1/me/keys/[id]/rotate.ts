import { jsonOk, readJsonObject } from '../../../../../../lib/http';
import { NO_STORE, memberRoute, requireUser } from '../../../../../../lib/members/account';
import { rotateUserKey, toKeyView } from '../../../../../../lib/members/api-keys';
import { requireCan } from '../../../../../../lib/members/policy';
import { membersRuntime } from '../../../../../../lib/members/runtime';
import { logActivity } from '../../../../../../lib/members/users';

/**
 * Issue a replacement key (same or narrower scopes; optional { name, scopes, expires_in_days }).
 * The old key keeps working until you revoke it. The new secret is returned once. Session only.
 */
export const POST = memberRoute(async ({ params, request }, { d1, principal }) => {
  requireCan(principal, 'keys:manage');
  const user = requireUser(principal);
  const body = (await readJsonObject(request)) ?? {};
  const { secret, key, previous } = await rotateUserKey(d1, user.id, params.id ?? '', body);
  await logActivity(d1, user.id, 'api_key.rotated', { key_id: previous.id, replacement_id: key.id, prefix: key.prefix }, request);
  const now = membersRuntime.now();
  return jsonOk({ secret, key: toKeyView(key, now), previous: toKeyView(previous, now) }, 201, NO_STORE);
});
