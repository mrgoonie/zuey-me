import type { APIContext } from 'astro';
import { runtimeWaitUntil } from '../blocks/articles';
import { AppError, errorResponse, jsonOk } from '../http';
import type { MemberRequest } from '../members/account';
import { NO_STORE, requireUser } from '../members/account';
import { isAdminIdentity } from '../members/admins';
import { requireCan } from '../members/policy';
import { logActivity } from '../members/users';
import { CLEAR_LINK_TOKEN_COOKIE, isSpentTokenError } from './connect-flow';
import type { LinkOutcome } from './identities';
import { redeemLinkToken } from './identities';
import { deferChannelAccessPush, invalidateSenders } from './invalidate';

/**
 * Links the chat account named by a dewee link token to the signed-in member (browser session only, so a
 * personal API key can never take over a Telegram id). Shared by `POST /connect/link` (token from the
 * HttpOnly cookie, never seen by the page) and `POST /api/v1/channel-access/link` (token in the JSON body).
 * The /connect cookie is cleared once the token is spent or unusable.
 */
export async function linkChannelForMember(context: Pick<APIContext, 'request' | 'locals'>, m: MemberRequest, token: unknown): Promise<Response> {
  requireCan(m.principal, 'account:security');
  const user = requireUser(m.principal);
  let outcome: LinkOutcome;
  try {
    outcome = await redeemLinkToken(m.d1, m.env, token, user.id, isAdminIdentity(user.email, user.email_verified_at, m.env));
  } catch (err) {
    if (!(err instanceof AppError) || !isSpentTokenError(err.code)) throw err;
    const res = errorResponse(err);
    res.headers.set('Set-Cookie', CLEAR_LINK_TOKEN_COOKIE);
    return res;
  }
  if (!outcome.already_linked) {
    await logActivity(m.d1, user.id, 'channel.linked', { provider: outcome.provider, external_id: outcome.external_id }, context.request);
  }
  // dewee may have cached link_required for this sender: let it re-check now.
  await deferChannelAccessPush(invalidateSenders(m.env, [outcome.external_id]), runtimeWaitUntil(context.locals.runtime));
  return jsonOk(outcome, 200, { ...NO_STORE, 'Set-Cookie': CLEAR_LINK_TOKEN_COOKIE });
}
