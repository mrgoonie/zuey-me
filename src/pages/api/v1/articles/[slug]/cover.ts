import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../../lib/http';
import { setArticleCover, toSummary } from '../../../../../lib/blocks/articles';
import { requireAdminActor } from '../../../../../lib/taxonomy/admin';

/**
 * Admin: set the cover (a managed media asset), its per-locale alt text and the social preview mode without
 * touching any document. Body: { expected_revision, cover_asset_id?, alt?, social_preview? }.
 */
export const PUT: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    await requireAdminActor(request, env);
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
    const { expected_revision: expectedRevision, ...change } = body;
    return jsonOk(toSummary(await setArticleCover(env.DB, params.slug ?? '', change, expectedRevision)));
  } catch (err) {
    return errorResponse(err);
  }
};
