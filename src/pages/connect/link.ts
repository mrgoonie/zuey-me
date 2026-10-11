import { LINK_TOKEN_COOKIE } from '../../lib/channel-access/connect-flow';
import { linkChannelForMember } from '../../lib/channel-access/link-handler';
import { AppError } from '../../lib/http';
import { memberRoute } from '../../lib/members/account';
import { readCookie } from '../../lib/members/session';

/**
 * Confirm button of /connect. The link token is read only from the HttpOnly cookie scoped to /connect, so it
 * never reaches the page, its island props or analytics. Same session, permission and origin rules as
 * `POST /api/v1/channel-access/link`.
 */
export const POST = memberRoute(async (context, m) => {
  const token = readCookie(context.request, LINK_TOKEN_COOKIE);
  if (!token) throw new AppError(400, 'missing_token', 'Open the link the bot sent you again');
  return linkChannelForMember(context, m, token);
});
