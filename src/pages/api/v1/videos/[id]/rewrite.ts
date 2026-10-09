import type { APIRoute } from 'astro';
import { errorResponse, jsonOk } from '../../../../../lib/http';
import { adminGuard, ingestDeps } from '../../../../../lib/videos/route-helpers';
import { rewriteEditionTranscript } from '../../../../../lib/videos/video-ingest-service';

/** Admin: clean up one edition's stored raw transcript with Workers AI again (no AnyMD call). */
export const POST: APIRoute = async ({ request, params, locals }) => {
  const env = locals.runtime?.env ?? {};
  const denied = await adminGuard(request, env);
  if (denied) return denied;
  try {
    return jsonOk(await rewriteEditionTranscript(ingestDeps(env), params.id ?? ''), 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};
