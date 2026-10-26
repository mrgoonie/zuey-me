/**
 * Who may read the presence Worker diagnostics: any admin (Studio session, admin member session, admin API
 * key) and read-only Studio keys, since the endpoint never changes anything. Unlike owner status this is not
 * owner-only. Everyone else gets the precise 401/403 of the shared policy.
 */
import type { Principal } from '../members/policy';
import { requireCan } from '../members/policy';

export function requirePresenceDiagnosticsReader(p: Principal): void {
  if (p.kind === 'admin' || p.via === 'read_api_key') return;
  requireCan(p, 'admin');
}
