import type { RuntimeEnv } from '../../env';
import type { Principal } from '../members/policy';
import { requireCan, resolvePrincipal } from '../members/policy';

/** Stable actor string recorded in revision history and the taxonomy audit log. */
export function principalActor(p: Principal): string {
  if (p.email) return p.email;
  if (p.via === 'studio_session') return 'studio-session';
  if (p.via === 'admin_api_key') return 'admin-api-key';
  return p.via;
}

/**
 * Resolves the caller through the central membership policy and requires the admin role
 * (Studio session, verified allowlisted member session with same-origin check, or admin API key).
 * Throws AppError 401/403 otherwise. Personal `zk_` keys are never admin.
 */
export async function requireAdminActor(request: Request, env: RuntimeEnv): Promise<{ principal: Principal; actor: string }> {
  const principal = await resolvePrincipal(request, env);
  requireCan(principal, 'admin');
  return { principal, actor: principalActor(principal) };
}
