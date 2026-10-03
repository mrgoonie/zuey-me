import type { APIRoute } from 'astro';
import { authenticateClient } from '../../lib/oauth/clients';
import { OAuthError, oauthErrorResponse, readFormBody } from '../../lib/oauth/errors';
import { revokeTokenForClient } from '../../lib/oauth/tokens';

/** RFC 7009 token revocation. Unknown or foreign tokens still answer 200 so token validity is not leaked. */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    if (!env.DB) throw new OAuthError(503, 'temporarily_unavailable', 'Revocation requires the database');
    const form = await readFormBody(request);
    if (!form.token) throw new OAuthError(400, 'invalid_request', 'token is required');
    const client = await authenticateClient(env.DB, request, form);
    await revokeTokenForClient(env.DB, client, form.token);
    return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return oauthErrorResponse(err);
  }
};
