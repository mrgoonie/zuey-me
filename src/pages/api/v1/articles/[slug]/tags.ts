import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../../lib/http';
import { setTagsForArticle, toSummary, runtimeWaitUntil } from '../../../../../lib/blocks/articles';
import { requireAdminActor } from '../../../../../lib/taxonomy/admin';

/** Admin: replace the article's topic tags with existing tags. Body: { tags: [id|slug|alias|name], expected_revision }. */
export const PUT: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    const { actor } = await requireAdminActor(request, env);
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
    const rec = await setTagsForArticle(env.DB, params.slug ?? '', body.tags, body.expected_revision, { actor, env, waitUntil: runtimeWaitUntil(locals.runtime) });
    return jsonOk(toSummary(rec));
  } catch (err) {
    return errorResponse(err);
  }
};
