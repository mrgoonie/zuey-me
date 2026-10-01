import type { APIRoute } from 'astro';
import { authenticateAdmin } from '../../../../lib/auth';
import { errorResponse, jsonError, jsonOk } from '../../../../lib/http';
import { syncReadsFromEnv } from '../../../../lib/reads/sync';

/** Admin-only: pull the AnyMD library and refresh Zuey Reads. Triggered by Studio and the scheduled GitHub workflow. */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? {};
  const auth = await authenticateAdmin(request, env.DB);
  if (!auth.authenticated) {
    return auth.role
      ? jsonError(403, 'forbidden', auth.error ?? 'Admin role required')
      : jsonError(401, 'unauthorized', auth.error ?? 'Unauthorized');
  }
  try {
    return jsonOk(await syncReadsFromEnv(env), 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};
