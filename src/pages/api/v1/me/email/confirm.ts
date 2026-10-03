import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../../lib/http';
import { confirmEmailChange } from '../../../../../lib/members/login-tokens';
import { requireMembersDb } from '../../../../../lib/members/runtime';
import { isSameOriginRequest } from '../../../../../lib/members/session';

/** Confirm an email change with the token from the verification email. Body: { token }. */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    if (!isSameOriginRequest(request)) return jsonError(403, 'csrf_rejected', 'Cross-site request rejected');
    const env = locals.runtime?.env ?? {};
    const d1 = requireMembersDb(env);
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
    const user = await confirmEmailChange(d1, env, request, body.token);
    return jsonOk({ email: user.email, email_verified: true }, 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};
