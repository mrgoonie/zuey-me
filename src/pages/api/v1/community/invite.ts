import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute, requireJsonBody } from '../../../../lib/members/account';
import { requestInvite } from '../../../../lib/experience/community';

/** Member with the `community` entitlement: one-hour, single-use invite link. Body: { chat: "en" | "vi" }. */
export const POST = memberRoute(async ({ request }, { d1, env, principal }) => {
  const body = await requireJsonBody(request);
  return jsonOk(await requestInvite(d1, env, principal, body.chat), 201, NO_STORE);
});
