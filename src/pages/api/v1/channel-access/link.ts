import { runtimeWaitUntil } from '../../../../lib/blocks/articles';
import { redeemLinkToken } from '../../../../lib/channel-access/identities';
import { deferChannelAccessPush, invalidateSenders } from '../../../../lib/channel-access/invalidate';
import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody, requireUser } from '../../../../lib/members/account';
import { requireCan } from '../../../../lib/members/policy';
import { logActivity } from '../../../../lib/members/users';

/** Links the chat account named by a dewee link token to the signed-in member (browser session only). */
export const POST = memberRoute(async ({ request, locals }, { d1, env, principal }) => {
  requireCan(principal, 'account:security');
  const user = requireUser(principal);
  const body = await requireJsonBody(request);
  const outcome = await redeemLinkToken(d1, env, body.token, user.id, principal.kind === 'admin');
  if (!outcome.already_linked) {
    await logActivity(d1, user.id, 'channel.linked', { provider: outcome.provider, external_id: outcome.external_id }, request);
  }
  // dewee may have cached link_required for this sender: let it re-check now.
  await deferChannelAccessPush(invalidateSenders(env, [outcome.external_id]), runtimeWaitUntil(locals.runtime));
  return jsonOk(outcome, 200, NO_STORE);
});
