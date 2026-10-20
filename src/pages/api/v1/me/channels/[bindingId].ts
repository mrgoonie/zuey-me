import { parseBindingId, unlinkMemberBinding } from '../../../../../lib/channel-access/dewee-identity';
import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute, requireUser } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';
import { logActivity } from '../../../../../lib/members/users';

/** Unlinks one of your chat accounts in Dewee (browser session only); Dewee stops admitting that sender at once. */
export const DELETE = memberRoute(async ({ params, request }, { d1, env, principal }) => {
  requireCan(principal, 'account:security');
  const user = requireUser(principal);
  const bindingId = parseBindingId(params.bindingId);
  await unlinkMemberBinding(env, user.id, bindingId);
  try {
    await logActivity(d1, user.id, 'channel.unlinked', { binding_id: bindingId }, request);
  } catch (err) {
    // The unlink already happened in Dewee: a missing activity row must not turn it into an error.
    console.warn('channel.unlinked activity not recorded:', err instanceof Error ? err.message : 'unknown');
  }
  return jsonOk({ unlinked: true }, 200, NO_STORE);
});
