import type { APIRoute } from 'astro';
import { errorResponse, jsonOk } from '../../../../../lib/http';
import { adminGuard, videosDb } from '../../../../../lib/videos/route-helpers';
import { refetchTranscript } from '../../../../../lib/videos/video-ingest-service';

/** Admin: fetch one edition's transcript again (bypassing the AnyMD cache). */
export const POST: APIRoute = async ({ request, params, locals }) => {
  const env = locals.runtime?.env ?? {};
  const denied = await adminGuard(request, env);
  if (denied) return denied;
  try {
    return jsonOk(await refetchTranscript({ db: videosDb(env), anymdApiKey: env.ANYMD_API_KEY }, params.id ?? ''), 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};
