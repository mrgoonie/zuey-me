import { jsonOk } from '../../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody, requireUser } from '../../../../../lib/members/account';
import { requestEmailChange } from '../../../../../lib/members/login-tokens';
import { requireCan } from '../../../../../lib/members/policy';

/** Request an email change. Body: { new_email }. A verification link is sent to the NEW address. Session only. */
export const POST = memberRoute(async ({ request }, { d1, env, principal }) => {
  requireCan(principal, 'account:security');
  const user = requireUser(principal);
  const body = await requireJsonBody(request);
  return jsonOk(await requestEmailChange(d1, env, request, user, body.new_email), 202, NO_STORE);
});
