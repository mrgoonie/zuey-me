import type { RuntimeEnv } from '../../env';
import { extractApiToken } from '../auth';
import { isAdminIdentity } from '../members/admins';
import type { UserKeyScope } from '../members/api-keys';
import { ENTITLEMENTS } from '../members/plans';
import type { Principal } from '../members/policy';
import { resolvePrincipal } from '../members/policy';
import { getEntitlements } from '../members/subscriptions';
import { getUserById } from '../members/users';
import type { OAuthScope } from './config';
import { ACCESS_TOKEN_PREFIX, isMemberScope } from './config';
import { validateAccessToken } from './tokens';

export interface OAuthGrantInfo {
  tokenId: string;
  clientId: string;
  scopes: OAuthScope[];
  /** The user is an allowlisted admin even if this token lacks the `admin` scope (step-up hint). */
  adminIdentity: boolean;
}

export type McpCaller =
  | { ok: true; principal: Principal; oauth: OAuthGrantInfo | null }
  | { ok: false; error: 'missing' | 'invalid_token'; description: string };

/** The `/mcp` endpoint is bearer-only: cookies are stripped so browser sessions can never be replayed cross-site. */
function withoutCookies(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete('cookie');
  return new Request(request.url, { method: request.method, headers });
}

/**
 * Resolves the `/mcp` caller from `Authorization: Bearer` (or `X-API-Key`): an OAuth access token
 * issued for exactly `audience`, a member `zk_` key, or a Studio admin/read key. OAuth scopes map onto
 * the same Principal shape as personal keys, so `can()` decides identically on every interface.
 */
export async function resolveMcpCaller(request: Request, env: RuntimeEnv, audience: string): Promise<McpCaller> {
  const token = extractApiToken(request);
  if (!token) return { ok: false, error: 'missing', description: 'Authorization: Bearer <token> is required' };

  if (!token.startsWith(ACCESS_TOKEN_PREFIX)) {
    const principal = await resolvePrincipal(withoutCookies(request), env);
    if (principal.credentialError) return { ok: false, error: 'invalid_token', description: principal.credentialError.message };
    if (principal.via === 'none') return { ok: false, error: 'invalid_token', description: 'Unknown credential' };
    return { ok: true, principal, oauth: null };
  }

  const d1 = env.DB;
  if (!d1) return { ok: false, error: 'invalid_token', description: 'OAuth tokens are unavailable without the database' };
  const check = await validateAccessToken(d1, token, audience);
  if (!check.ok) {
    const description = {
      invalid: 'The access token is invalid',
      expired: 'The access token expired',
      revoked: 'The access token was revoked',
      audience: 'The access token was not issued for this resource',
    }[check.reason];
    return { ok: false, error: 'invalid_token', description };
  }
  const user = await getUserById(d1, check.token.user_id);
  if (!user) return { ok: false, error: 'invalid_token', description: 'The access token is invalid' };

  const adminIdentity = isAdminIdentity(user.email, user.email_verified_at, env);
  const admin = adminIdentity && check.token.scopes.includes('admin');
  const { plans, entitlements } = await getEntitlements(d1, user.id);
  const memberScopes: UserKeyScope[] = check.token.scopes.filter(isMemberScope);
  const principal: Principal = {
    kind: admin ? 'admin' : 'member',
    // A scope-limited bearer credential acting for one member: same policy path as a personal key.
    via: 'user_api_key',
    userId: user.id,
    email: user.email,
    user,
    scopes: memberScopes,
    plans,
    entitlements: admin ? [...ENTITLEMENTS] : entitlements,
    sessionId: null,
    keyId: null,
    credentialError: null,
  };
  return {
    ok: true,
    principal,
    oauth: { tokenId: check.token.id, clientId: check.token.client_id, scopes: check.token.scopes, adminIdentity },
  };
}
