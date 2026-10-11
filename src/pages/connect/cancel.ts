import type { APIRoute } from 'astro';
import { CLEAR_LINK_TOKEN_COOKIE } from '../../lib/channel-access/connect-flow';

/** "Huỷ" on /connect: forgets the parked link token server-side and returns to the account page. */
export const POST: APIRoute = async () => new Response(null, {
  status: 303,
  headers: { Location: '/account#email', 'Set-Cookie': CLEAR_LINK_TOKEN_COOKIE, 'Cache-Control': 'private, no-store' },
});
