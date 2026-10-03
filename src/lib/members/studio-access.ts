import type { RuntimeEnv } from '../../env';
import { can, resolvePrincipal } from './policy';

export type StudioSessionKind = 'studio_session' | 'member_session';

export interface StudioAccess {
  /** True for an owner Studio session or a member session of a verified ADMIN_EMAILS address. */
  authenticated: boolean;
  /** Which browser session opened Studio; decides which logout endpoint the UI calls. */
  via: StudioSessionKind | null;
  email: string | null;
  /** Email of a signed-in member who is not an admin, so the login screen can explain the refusal. */
  deniedEmail: string | null;
}

/**
 * Gate for the /studio page. Only browser sessions open Studio (API keys sent as headers do not),
 * and the admin decision is the shared policy's `can(principal, 'admin')`.
 */
export async function resolveStudioAccess(request: Request, env: RuntimeEnv): Promise<StudioAccess> {
  const p = await resolvePrincipal(request, env);
  const session = p.via === 'studio_session' || p.via === 'member_session' ? p.via : null;
  if (session && can(p, 'admin')) return { authenticated: true, via: session, email: p.email, deniedEmail: null };
  return { authenticated: false, via: null, email: null, deniedEmail: session === 'member_session' ? p.email : null };
}
