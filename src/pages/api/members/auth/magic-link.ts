import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../lib/http';
import { requestMagicLink } from '../../../../lib/members/login-tokens';
import { requireMembersDb } from '../../../../lib/members/runtime';

/** Emails a single-use 15-minute sign-in link. Body: { email, next? }. */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.runtime?.env ?? {};
    const d1 = requireMembersDb(env);
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
    const result = await requestMagicLink(d1, env, request, body);
    return jsonOk({ sent: true, ...result }, 202, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};
