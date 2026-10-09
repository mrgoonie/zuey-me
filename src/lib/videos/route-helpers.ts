/** Small helpers shared by the /api/v1/videos routes. */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { authenticateAdmin } from '../auth';
import { AppError, jsonError } from '../http';

/** Returns an error Response when the caller is not an admin, otherwise null. */
export async function adminGuard(request: Request, env: RuntimeEnv): Promise<Response | null> {
  const auth = await authenticateAdmin(request, env.DB, env);
  if (auth.authenticated) return null;
  return auth.role
    ? jsonError(403, 'forbidden', auth.error ?? 'Admin role required')
    : jsonError(401, 'unauthorized', auth.error ?? 'Unauthorized');
}

export function videosDb(env: RuntimeEnv): D1DatabaseLike {
  if (!env.DB) throw new AppError(503, 'db_unavailable', 'Database binding is not configured');
  return env.DB;
}

export function siteOrigin(env: RuntimeEnv, request: Request): string {
  return (env.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
}
