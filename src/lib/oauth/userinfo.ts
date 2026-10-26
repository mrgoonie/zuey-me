import type { RuntimeEnv } from '../../env';
import type { UserRecord } from '../members/users';
import { getUserById } from '../members/users';
import type { OAuthScope } from './config';
import { ACCESS_TOKEN_PREFIX } from './config';
import { oauthJson } from './errors';
import { validateAccessToken } from './tokens';

/** Claims returned by `/oauth/userinfo`; each optional group appears only with its scope. */
export interface UserinfoClaims {
  /** Stable opaque member id (never the email), the key relying parties store. */
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string | null;
  picture?: string | null;
  locale?: 'vi' | 'en' | null;
}

function httpsOrNull(v: string | null): string | null {
  if (!v) return null;
  try {
    return new URL(v).protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
}

/** Builds the claim set for a member, filtered by the token's identity scopes (`openid` is checked by the caller). */
export function userinfoClaims(user: UserRecord, scopes: OAuthScope[]): UserinfoClaims {
  const claims: UserinfoClaims = { sub: user.id };
  if (scopes.includes('email')) {
    claims.email = user.email;
    claims.email_verified = user.email_verified_at !== null;
  }
  if (scopes.includes('profile')) {
    claims.name = user.name;
    claims.picture = httpsOrNull(user.avatar_url);
    claims.locale = user.locale === 'vi' || user.locale === 'en' ? user.locale : null;
  }
  return claims;
}

/** RFC 6750 §3 error: 401 `invalid_token` or 403 `insufficient_scope`, JSON body + `WWW-Authenticate`. */
function bearerError(status: 401 | 403, error: 'invalid_token' | 'insufficient_scope', description: string): Response {
  const scope = error === 'insufficient_scope' ? ', scope="openid"' : '';
  return oauthJson({ error, error_description: description }, status, {
    'WWW-Authenticate': `Bearer error="${error}", error_description="${description}"${scope}`,
  });
}

/** Only the `Authorization: Bearer` header is honoured: no cookies, no query or form tokens. */
function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const m = /^Bearer[ ]+(\S+)\s*$/i.exec(header);
  return m ? m[1] : null;
}

/**
 * `GET`/`POST /oauth/userinfo` ("Sign in with zuey.me"). Accepts any live zuey.me access token that carries
 * `openid`, whatever its audience: identity-only tokens are bound to this endpoint, and MCP tokens that were
 * also granted `openid` work here too. Revoked/expired tokens, revoked consent and deleted members get 401.
 */
export async function handleUserinfo(request: Request, env: RuntimeEnv): Promise<Response> {
  const token = bearerToken(request);
  if (!token || !token.startsWith(ACCESS_TOKEN_PREFIX)) {
    return bearerError(401, 'invalid_token', 'A zuey.me access token is required (Authorization: Bearer)');
  }
  const d1 = env.DB;
  if (!d1) return oauthJson({ error: 'temporarily_unavailable', error_description: 'userinfo requires the database' }, 503);

  const check = await validateAccessToken(d1, token, null);
  if (!check.ok) {
    const description = { invalid: 'The access token is invalid', expired: 'The access token expired', revoked: 'The access token was revoked', audience: 'The access token is invalid' }[check.reason];
    return bearerError(401, 'invalid_token', description);
  }
  if (!check.token.scopes.includes('openid')) return bearerError(403, 'insufficient_scope', 'The access token was not granted the openid scope');
  const user = await getUserById(d1, check.token.user_id);
  if (!user) return bearerError(401, 'invalid_token', 'The access token is invalid');
  return oauthJson(userinfoClaims(user, check.token.scopes));
}
