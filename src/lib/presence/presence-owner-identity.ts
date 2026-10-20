/**
 * Who counts as the site owner in presence: a member id listed in PRESENCE_OWNER_MEMBER_IDS, never the
 * admin role. Shared by the ticket issuer (owner flag in the connect ticket), the owner status REST
 * endpoint, the owner MCP tools and Studio, so every interface makes the same decision.
 */
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { UserKeyScope } from '../members/api-keys';
import type { Principal } from '../members/policy';

/** Trimmed, de-duplicated member ids from PRESENCE_OWNER_MEMBER_IDS (comma-separated). */
export function presenceOwnerIds(env: RuntimeEnv): Set<string> {
  return new Set((env.PRESENCE_OWNER_MEMBER_IDS ?? '').split(',').map(id => id.trim()).filter(id => id.length > 0));
}

/** Owner status reads need `account:read`, changes `account:write` (scope-limited keys and OAuth tokens only). */
export type PresenceOwnerAccess = 'read' | 'write';

export const PRESENCE_OWNER_SCOPE: Record<PresenceOwnerAccess, UserKeyScope> = {
  read: 'account:read',
  write: 'account:write',
};

/**
 * True when the principal is a member account listed as owner. Studio sessions and Studio admin/read
 * keys carry no member id, so they are never the owner, whatever their role.
 */
export function isPresenceOwner(p: Principal, ownerIds: ReadonlySet<string>): boolean {
  return p.userId !== null && ownerIds.has(p.userId);
}

/**
 * Throws the precise 401/403 unless the caller is the owner and (for scope-limited credentials: `zk_`
 * keys, OAuth tokens) holds the scope for `access`. Sessions are not scope-limited.
 */
export function requirePresenceOwner(p: Principal, env: RuntimeEnv, access: PresenceOwnerAccess): void {
  if (p.credentialError) throw new AppError(p.credentialError.status, p.credentialError.code, p.credentialError.message);
  if (p.via === 'none') {
    throw new AppError(401, 'unauthorized', 'Sign in (zuey_member session) or send Authorization: Bearer <API key>');
  }
  if (!isPresenceOwner(p, presenceOwnerIds(env))) {
    throw new AppError(403, 'not_owner', 'Only the site owner can manage presence status');
  }
  const scope = PRESENCE_OWNER_SCOPE[access];
  if (p.scopes && !p.scopes.includes(scope)) {
    throw new AppError(403, 'insufficient_scope', `This credential lacks the ${scope} scope`, { required_scope: scope });
  }
}
