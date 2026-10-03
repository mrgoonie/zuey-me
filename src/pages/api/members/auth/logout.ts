import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk } from '../../../../lib/http';
import { logActivity } from '../../../../lib/members/users';
import {
  MEMBER_COOKIE, clearMemberCookie, destroyMemberSessionByToken, isSameOriginRequest, lookupMemberSession, readCookie,
} from '../../../../lib/members/session';

/** Ends the current member session and clears the cookie. */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    if (!isSameOriginRequest(request)) return jsonError(403, 'csrf_rejected', 'Cross-site request rejected');
    const d1 = locals.runtime?.env?.DB;
    const token = readCookie(request, MEMBER_COOKIE);
    if (d1 && token) {
      const current = await lookupMemberSession(d1, token);
      await destroyMemberSessionByToken(d1, token);
      if (current) await logActivity(d1, current.user.id, 'logout', null, request);
    }
    return jsonOk({ signed_out: true }, 200, { 'Cache-Control': 'no-store', 'Set-Cookie': clearMemberCookie() });
  } catch (err) {
    return errorResponse(err);
  }
};
