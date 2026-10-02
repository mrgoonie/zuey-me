import type { APIRoute } from 'astro';
import { authenticateClient } from '../../lib/oauth/clients';
import { OAuthError, oauthErrorResponse, oauthJson, readFormBody } from '../../lib/oauth/errors';
import { exchangeAuthorizationCode, refreshTokens } from '../../lib/oauth/tokens';

/** OAuth 2.1 token endpoint: authorization_code (+PKCE) and refresh_token (rotating) grants. */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    if (!env.DB) throw new OAuthError(503, 'temporarily_unavailable', 'The token endpoint requires the database');
    const form = await readFormBody(request);
    const client = await authenticateClient(env.DB, request, form);
    if (form.grant_type === 'authorization_code') return oauthJson(await exchangeAuthorizationCode(env.DB, client, form));
    if (form.grant_type === 'refresh_token') return oauthJson(await refreshTokens(env.DB, client, form));
    throw new OAuthError(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  } catch (err) {
    return oauthErrorResponse(err);
  }
};
