import { runtimeWaitUntil } from '../../../../lib/blocks/articles';
import { CLEAR_LINK_TOKEN_COOKIE, isSpentTokenError } from '../../../../lib/channel-access/connect-flow';
import type { LinkOutcome } from '../../../../lib/channel-access/identities';
import { redeemLinkToken } from '../../../../lib/channel-access/identities';
import { deferChannelAccessPush, invalidateSenders } from '../../../../lib/channel-access/invalidate';
import { AppError, errorResponse, jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody, requireUser } from '../../../../lib/members/account';
import { requireCan } from '../../../../lib/members/policy';
import { logActivity } from '../../../../lib/members/users';
import { isAdminIdentity } from '../../../../lib/members/admins';

/** Links the chat account named by a dewee link token to the signed-in member (browser session only). */
export const POST = memberRoute(async ({ request, locals }, { d1, env, principal }) => {
  requireCan(principal, 'account:security');
  const user = requireUser(principal);
  const body = await requireJsonBody(request);
  let outcome: LinkOutcome;
  try {
    outcome = await redeemLinkToken(d1, env, body.token, user.id, isAdminIdentity(user.email, user.email_verified_at, env));
  } catch (err) {
    if (!(err instanceof AppError) || !isSpentTokenError(err.code)) throw err;
    // The token can never succeed: drop the /connect cookie that still holds it.
    const res = errorResponse(err);
    res.headers.set('Set-Cookie', CLEAR_LINK_TOKEN_COOKIE);
    return res;
  }
  if (!outcome.already_linked) {
    await logActivity(d1, user.id, 'channel.linked', { provider: outcome.provider, external_id: outcome.external_id }, request);
  }
  // dewee may have cached link_required for this sender: let it re-check now.
  await deferChannelAccessPush(invalidateSenders(env, [outcome.external_id]), runtimeWaitUntil(locals.runtime));
  return jsonOk(outcome, 200, { ...NO_STORE, 'Set-Cookie': CLEAR_LINK_TOKEN_COOKIE });
});
