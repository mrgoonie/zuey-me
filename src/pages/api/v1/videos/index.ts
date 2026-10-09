import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../lib/http';
import { adminGuard, siteOrigin, videosDb, ingestDeps } from '../../../../lib/videos/route-helpers';
import { listVideos } from '../../../../lib/videos/store';
import { parseAddVideoInput } from '../../../../lib/videos/video-admin-operations';
import { addVideo } from '../../../../lib/videos/video-ingest-service';
import { searchVideos } from '../../../../lib/videos/video-search';

function intParam(params: URLSearchParams, key: string): number | undefined {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Public: curated list, or transcript-aware search with `?q=`. */
export const GET: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    const db = videosDb(env);
    const params = new URL(request.url).searchParams;
    const q = (params.get('q') ?? '').trim();
    if (q) {
      const results = await searchVideos(db, q, { limit: intParam(params, 'limit') ?? 8, origin: siteOrigin(env, request), locale: params.get('locale') });
      return jsonOk({ query: q, results }, 200, { 'Cache-Control': 'public, max-age=60' });
    }
    const data = await listVideos(db, { limit: intParam(params, 'limit'), offset: intParam(params, 'offset') });
    return jsonOk(data, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch (err) {
    return errorResponse(err);
  }
};

/** Admin: add a YouTube link; the transcript is fetched once and a failure is reported, not thrown. */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? {};
  const denied = await adminGuard(request, env);
  if (denied) return denied;
  try {
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Expected a JSON object body');
    const result = await addVideo(ingestDeps(env), parseAddVideoInput(body));
    return jsonOk(result, 201, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};
