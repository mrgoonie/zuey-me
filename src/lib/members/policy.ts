import { getApiKeyRole, verifySession } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { extractApiToken, extractSessionCookie } from '../auth';
import type { Viewer } from '../blocks/paywall';
import { AppError } from '../http';
import { isAdminIdentity } from './admins';
import type { UserKeyScope } from './api-keys';
import { USER_KEY_PREFIX, verifyUserKey } from './api-keys';
import type { Entitlement, PlanId } from './plans';
import { ENTITLEMENTS } from './plans';
import { isSameOriginRequest, resolveMemberSession } from './session';
import { getEntitlements } from './subscriptions';
import type { UserRecord } from './users';
import { getUserById } from './users';

export type PrincipalKind = 'anonymous' | 'member' | 'admin';
/** How the caller authenticated; `oauth_token` is an OAuth access token presented to /mcp. */
export const CREDENTIAL_VIAS = ['none', 'studio_session', 'admin_api_key', 'read_api_key', 'member_session', 'user_api_key', 'oauth_token'] as const;
export type CredentialVia = (typeof CREDENTIAL_VIAS)[number];

export interface CredentialError {
  status: 401 | 403;
  code: string;
  message: string;
}

/** Who is calling, resolved once per request and shared by REST, MCP, HTML and Markdown routes. */
export interface Principal {
  kind: PrincipalKind;
  via: CredentialVia;
  userId: string | null;
  email: string | null;
  user: UserRecord | null;
  /** Ceiling of a user API key; null when the credential is not scope-restricted (sessions). */
  scopes: UserKeyScope[] | null;
  plans: PlanId[];
  entitlements: Entitlement[];
  sessionId: string | null;
  keyId: string | null;
  /** Set when the request presented a credential that was rejected (bad/expired/revoked key, CSRF). */
  credentialError: CredentialError | null;
}

export type Action =
  | 'articles:read_full'
  | 'chat:use'
  | 'community:access'
  | 'account:read'
  | 'account:write'
  | 'billing:read'
  | 'checkout:write'
  | 'keys:manage'
  | 'account:security'
  | 'admin';

/** Actions that only a signed-in browser session may perform (never a personal API key). */
const SESSION_ONLY: Action[] = ['keys:manage', 'account:security'];

const ACTION_SCOPE: Partial<Record<Action, UserKeyScope>> = {
  'articles:read_full': 'articles:read',
  'chat:use': 'chat:write',
  'account:read': 'account:read',
  'account:write': 'account:write',
  'billing:read': 'billing:read',
  'checkout:write': 'checkout:write',
};

const ACTION_ENTITLEMENT: Partial<Record<Action, Entitlement>> = {
  'articles:read_full': 'read_full',
  'chat:use': 'ai_chat',
  'community:access': 'community',
};

function anonymous(credentialError: CredentialError | null = null, via: CredentialVia = 'none'): Principal {
  return {
    kind: 'anonymous', via, userId: null, email: null, user: null, scopes: null, plans: [], entitlements: [],
    sessionId: null, keyId: null, credentialError,
  };
}

/** A signed-out caller, for public renderings (Markdown, feeds) that must never include paid content. */
export function anonymousPrincipal(): Principal {
  return anonymous();
}

function studioAdmin(via: 'studio_session' | 'admin_api_key'): Principal {
  return { ...anonymous(null, via), kind: 'admin', entitlements: [...ENTITLEMENTS] };
}

const KEY_ERRORS: Record<'invalid' | 'expired' | 'revoked', CredentialError> = {
  invalid: { status: 401, code: 'invalid_api_key', message: 'Invalid API key' },
  expired: { status: 401, code: 'api_key_expired', message: 'This API key has expired' },
  revoked: { status: 401, code: 'api_key_revoked', message: 'This API key has been revoked' },
};

/**
 * Resolves the caller. Order: member session (same-origin) → Studio session → bearer/X-API-Key
 * (user `zk_` key or Studio key). The member session wins over the Studio cookie because only it
 * carries an account; a valid Studio cookie in the same browser still makes that member an admin.
 * User keys are never admin.
 */
export async function resolvePrincipal(request: Request, env: RuntimeEnv): Promise<Principal> {
  const d1 = env.DB;

  const studioToken = extractSessionCookie(request.headers.get('cookie') || '');
  const hasStudioSession = Boolean(studioToken && (await verifySession(studioToken, d1)));

  let csrfError: CredentialError | null = null;
  const member = d1 ? await resolveMemberSession(request, d1) : null;
  if (member) {
    if (isSameOriginRequest(request)) {
      const { plans, entitlements } = d1 ? await getEntitlements(d1, member.user.id) : { plans: [], entitlements: [] };
      const admin = hasStudioSession || isAdminIdentity(member.user.email, member.user.email_verified_at, env);
      return {
        kind: admin ? 'admin' : 'member',
        via: 'member_session',
        userId: member.user.id,
        email: member.user.email,
        user: member.user,
        scopes: null,
        plans,
        entitlements: admin ? [...ENTITLEMENTS] : entitlements,
        sessionId: member.session.id,
        keyId: null,
        credentialError: null,
      };
    }
    csrfError = { status: 403, code: 'csrf_rejected', message: 'Cross-site request rejected: send same-origin requests (Origin header) when using the session cookie' };
  }

  if (hasStudioSession) return studioAdmin('studio_session');

  const token = extractApiToken(request);
  if (!token) return anonymous(csrfError);

  if (token.startsWith(USER_KEY_PREFIX)) {
    if (!d1) return anonymous({ status: 401, code: 'invalid_api_key', message: 'API keys are unavailable without the database' });
    const verified = await verifyUserKey(d1, token);
    if (!verified.ok) return anonymous(KEY_ERRORS[verified.reason]);
    const { key } = verified;
    const { plans, entitlements } = await getEntitlements(d1, key.user_id);
    const user = await getUserById(d1, key.user_id);
    if (!user) return anonymous(KEY_ERRORS.invalid);
    return {
      kind: 'member',
      via: 'user_api_key',
      userId: user.id,
      email: user.email,
      user,
      scopes: key.scopes,
      plans,
      entitlements,
      sessionId: null,
      keyId: key.id,
      credentialError: null,
    };
  }

  const role = await getApiKeyRole(token, d1);
  if (role === 'admin') return studioAdmin('admin_api_key');
  if (role === 'read') return anonymous(null, 'read_api_key');
  return anonymous(KEY_ERRORS.invalid);
}

/** Pure authorization decision shared by every interface. */
export function can(p: Principal, action: Action): boolean {
  if (action === 'admin') return p.kind === 'admin';
  if (SESSION_ONLY.includes(action)) return p.userId !== null && p.via === 'member_session';
  const entitlement = ACTION_ENTITLEMENT[action];
  if (p.kind === 'admin' && entitlement) return true;
  if (!p.userId) return false;
  if (p.scopes) {
    const scope = ACTION_SCOPE[action];
    if (!scope || !p.scopes.includes(scope)) return false;
  }
  return entitlement ? p.entitlements.includes(entitlement) : true;
}

/** Throws the precise 401/403 for a denied action. */
export function requireCan(p: Principal, action: Action): void {
  if (can(p, action)) return;
  if (p.credentialError) throw new AppError(p.credentialError.status, p.credentialError.code, p.credentialError.message);
  if (p.kind === 'anonymous' && p.via === 'none') {
    throw new AppError(401, 'unauthorized', 'Sign in (zuey_member session) or send Authorization: Bearer <API key>');
  }
  if (action === 'admin') throw new AppError(403, 'forbidden', 'Admin role required');
  if (SESSION_ONLY.includes(action)) {
    throw new AppError(403, 'session_required', 'This action requires a signed-in browser session at /account (API keys cannot perform it)');
  }
  if (!p.userId) throw new AppError(403, 'member_account_required', 'This action requires a member account');
  const scope = ACTION_SCOPE[action];
  if (p.scopes && (!scope || !p.scopes.includes(scope))) {
    throw new AppError(403, 'insufficient_scope', `This API key lacks the ${scope ?? action} scope`, { required_scope: scope ?? null });
  }
  const entitlement = ACTION_ENTITLEMENT[action];
  throw new AppError(403, 'entitlement_required', `Your plan does not include ${entitlement ?? action}`, {
    entitlement: entitlement ?? null,
    upgrade_url: '/pricing',
  });
}

/** Requires a member account (session or key) and returns its user id. */
export function requireUserId(p: Principal, action: Action): string {
  requireCan(p, action);
  if (!p.userId) throw new AppError(403, 'member_account_required', 'This action requires a member account');
  return p.userId;
}

/** Converts a principal into the paywall viewer used by HTML, Markdown, REST and MCP article reads. */
export function viewerFromPrincipal(p: Principal): Viewer {
  return {
    isAdmin: p.kind === 'admin',
    entitlements: can(p, 'articles:read_full') ? ['read_full'] : [],
    personalized: p.via !== 'none' && p.via !== 'read_api_key',
  };
}
