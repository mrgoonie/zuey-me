import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../../lib/http';
import { adminGuard, publishArticle, toSummary } from '../../../../../lib/blocks/articles';

/** Admin: publish the current draft. Body: { expected_revision, confirm: true }. */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  try {
    const denied = await adminGuard(request, d1);
    if (denied) return denied;
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
    const rec = await publishArticle(d1, params.slug ?? '', body.expected_revision, body.confirm);
    return jsonOk({ ...toSummary(rec), document: rec.published });
  } catch (err) {
    return errorResponse(err);
  }
};
