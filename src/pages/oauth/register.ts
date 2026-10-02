import type { APIRoute } from 'astro';
import { registerClient, registrationResponse } from '../../lib/oauth/clients';
import { OAuthError, oauthErrorResponse, oauthJson } from '../../lib/oauth/errors';

/** RFC 7591 Dynamic Client Registration (kept for MCP clients without Client ID Metadata Document support). */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    if (!env.DB) throw new OAuthError(503, 'temporarily_unavailable', 'Client registration requires the database');
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new OAuthError(400, 'invalid_client_metadata', 'Body must be a JSON object');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError(400, 'invalid_client_metadata', 'Body must be a JSON object');
    const result = await registerClient(env.DB, env, request, Object.fromEntries(Object.entries(body)));
    return oauthJson(registrationResponse(result), 201);
  } catch (err) {
    return oauthErrorResponse(err);
  }
};
