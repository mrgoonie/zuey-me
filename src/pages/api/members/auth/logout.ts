import type { APIRoute } from 'astro';
import { destroySession } from '../../../../db/store';
import { extractSessionCookie } from '../../../../lib/auth';
import { errorResponse, jsonError, jsonOk } from '../../../../lib/http';
import { logActivity } from '../../../../lib/members/users';
import {
  MEMBER_COOKIE, clearMemberCookie, destroyMemberSessionByToken, isSameOriginRequest, lookupMemberSession, readCookie,
} from '../../../../lib/members/session';

/** Ends the current member session and any Studio session in this browser, and clears both cookies. */
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
    // The Studio cookie also grants admin to this browser; signing out must not leave it behind.
    const studioToken = extractSessionCookie(request.headers.get('cookie') || '');
    if (studioToken) await destroySession(studioToken, d1);
    const res = jsonOk({ signed_out: true }, 200, { 'Cache-Control': 'no-store', 'Set-Cookie': clearMemberCookie() });
    if (studioToken) res.headers.append('Set-Cookie', 'zuey_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    return res;
  } catch (err) {
    return errorResponse(err);
  }
};
