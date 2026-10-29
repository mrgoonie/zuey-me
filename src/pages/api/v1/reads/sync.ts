import type { APIRoute } from 'astro';
import { authenticateAdmin } from '../../../../lib/auth';
import { AppError, errorResponse, jsonError, jsonOk } from '../../../../lib/http';
import { syncReadsFromEnv } from '../../../../lib/reads/sync';

const MAX_BATCH_LIMIT = 100;

/** Reads optional `offset` / `limit` batch fields from the JSON body; an empty or non-object body means "everything". */
async function readBatch(request: Request): Promise<{ offset?: number; limit?: number }> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null) return {};
  const batch: { offset?: number; limit?: number } = {};
  if ('offset' in body) {
    if (typeof body.offset !== 'number' || !Number.isInteger(body.offset) || body.offset < 0) {
      throw new AppError(400, 'invalid_offset', 'offset must be a non-negative integer');
    }
    batch.offset = body.offset;
  }
  if ('limit' in body) {
    if (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > MAX_BATCH_LIMIT) {
      throw new AppError(400, 'invalid_limit', `limit must be an integer between 1 and ${MAX_BATCH_LIMIT}`);
    }
    batch.limit = body.limit;
  }
  return batch;
}

/** Admin-only: pull the AnyMD library and refresh Zuey Reads. Studio syncs everything in one call; the scheduled workflow loops batches via `limit` + `next_offset`. */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? {};
  const auth = await authenticateAdmin(request, env.DB);
  if (!auth.authenticated) {
    return auth.role
      ? jsonError(403, 'forbidden', auth.error ?? 'Admin role required')
      : jsonError(401, 'unauthorized', auth.error ?? 'Unauthorized');
  }
  try {
    return jsonOk(await syncReadsFromEnv(env, undefined, await readBatch(request)), 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};
