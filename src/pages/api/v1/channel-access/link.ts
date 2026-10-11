import { linkChannelForMember } from '../../../../lib/channel-access/link-handler';
import { memberRoute, requireJsonBody } from '../../../../lib/members/account';

/** Scripted variant of `POST /connect/link`: the dewee link token comes in the JSON body (browser session only). */
export const POST = memberRoute(async (context, m) => {
  const body = await requireJsonBody(context.request);
  return linkChannelForMember(context, m, body.token);
});
