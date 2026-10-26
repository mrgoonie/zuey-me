import type { APIRoute } from 'astro';
import { oauthErrorResponse } from '../../lib/oauth/errors';
import { handleUserinfo } from '../../lib/oauth/userinfo';

/** OIDC-style userinfo for "Sign in with zuey.me": Bearer token with the `openid` scope, claims filtered by scope. */
const userinfo: APIRoute = async ({ request, locals }) => {
  try {
    return await handleUserinfo(request, locals.runtime?.env ?? {});
  } catch (err) {
    return oauthErrorResponse(err);
  }
};

export const GET = userinfo;
export const POST = userinfo;
