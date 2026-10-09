import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../../lib/http';
import { consumeMagicLink } from '../../../../../lib/members/login-tokens';
import { requireMembersDb } from '../../../../../lib/members/runtime';
import { isSameOriginRequest, memberCookie } from '../../../../../lib/members/session';
import { bindReferrerOnSignup } from '../../../../../lib/referrals/attribution';

/**
 * Consumes a magic-link token (POSTed by the /login/verify page, so mail scanners that only
 * GET the URL cannot burn it) and opens a `zuey_member` session.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    if (!isSameOriginRequest(request)) return jsonError(403, 'csrf_rejected', 'Cross-site request rejected');
    const env = locals.runtime?.env ?? {};
    const d1 = requireMembersDb(env);
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
    const result = await consumeMagicLink(d1, request, body.token);
    const response = jsonOk({ next: result.next, created: result.created }, 200, {
      'Cache-Control': 'no-store',
      'Set-Cookie': memberCookie(result.sessionToken),
    });
    const clearRef = result.created ? await bindReferrerOnSignup(d1, result.user, request, env) : null;
    if (clearRef) response.headers.append('Set-Cookie', clearRef);
    return response;
  } catch (err) {
    return errorResponse(err);
  }
};
