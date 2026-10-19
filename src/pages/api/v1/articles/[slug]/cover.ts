import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../../lib/http';
import { setArticleCover } from '../../../../../lib/blocks/article-cover';
import { requireDb } from '../../../../../lib/taxonomy/common';
import { requireAdminActor } from '../../../../../lib/taxonomy/admin';

/**
 * Admin: set the managed cover and social preview from a media asset id. Body: { expected_revision, asset_id?,
 * alt?, alts?, social_preview?: { mode, asset_id? } }. Returns a receipt; no article body is read or rewritten.
 */
export const PUT: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    await requireAdminActor(request, env);
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
    return jsonOk(await setArticleCover(requireDb(env.DB), {
      slug: params.slug ?? '', expectedRevision: body.expected_revision, assetId: body.asset_id, alt: body.alt, alts: body.alts, socialPreview: body.social_preview,
    }));
  } catch (err) {
    return errorResponse(err);
  }
};
