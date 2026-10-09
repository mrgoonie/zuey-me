import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../lib/http';
import { adminGuard, siteOrigin, videosDb } from '../../../../lib/videos/route-helpers';
import { applyVideoPatch, removeVideoOrEdition } from '../../../../lib/videos/video-admin-operations';
import { getVideoDetail } from '../../../../lib/videos/video-detail';

/** Public: one video with transcripts and automatically related articles. */
export const GET: APIRoute = async ({ request, params, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    const detail = await getVideoDetail(videosDb(env), params.id ?? '', siteOrigin(env, request));
    if (!detail) return jsonError(404, 'video_not_found', 'Video not found');
    return jsonOk(detail, 200, { 'Cache-Control': 'public, max-age=120' });
  } catch (err) {
    return errorResponse(err);
  }
};

export const PATCH: APIRoute = async ({ request, params, locals }) => {
  const env = locals.runtime?.env ?? {};
  const denied = await adminGuard(request, env);
  if (denied) return denied;
  try {
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Expected a JSON object body');
    return jsonOk(await applyVideoPatch(videosDb(env), params.id ?? '', body), 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};

export const DELETE: APIRoute = async ({ request, params, locals }) => {
  const env = locals.runtime?.env ?? {};
  const denied = await adminGuard(request, env);
  if (denied) return denied;
  try {
    return jsonOk(await removeVideoOrEdition(videosDb(env), params.id ?? ''), 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};
