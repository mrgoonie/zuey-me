import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody, requireUser } from '../../../../../lib/members/account';
import { createUserKey, listUserKeys, parseKeyInput, toKeyView } from '../../../../../lib/members/api-keys';
import { requireCan } from '../../../../../lib/members/policy';
import { membersRuntime } from '../../../../../lib/members/runtime';
import { logActivity } from '../../../../../lib/members/users';

/** Own personal API keys (metadata only, never the secret). Session only. */
export const GET = memberRoute(async (_ctx, { d1, principal }) => {
  requireCan(principal, 'keys:manage');
  const user = requireUser(principal);
  const now = membersRuntime.now();
  return jsonOk((await listUserKeys(d1, user.id)).map(k => toKeyView(k, now)), 200, NO_STORE);
});

/** Create a key. Body: { name, scopes[], expires_in_days? }. The secret is returned exactly once. Session only. */
export const POST = memberRoute(async ({ request }, { d1, principal }) => {
  requireCan(principal, 'keys:manage');
  const user = requireUser(principal);
  const { secret, key } = await createUserKey(d1, user.id, parseKeyInput(await requireJsonBody(request)));
  await logActivity(d1, user.id, 'api_key.created', { key_id: key.id, prefix: key.prefix, scopes: key.scopes }, request);
  return jsonOk({ secret, key: toKeyView(key, membersRuntime.now()) }, 201, NO_STORE);
});
