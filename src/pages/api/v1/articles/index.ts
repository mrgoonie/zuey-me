import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../lib/http';
import { adminGuard, createArticle, listArticles, parseArticleInput, toSummary } from '../../../../lib/blocks/articles';

/** Public list of published articles; admins may add ?include_drafts=1. */
export const GET: APIRoute = async ({ request, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  try {
    const includeDrafts = new URL(request.url).searchParams.get('include_drafts') === '1';
    if (includeDrafts) {
      const denied = await adminGuard(request, d1);
      if (denied) return denied;
    }
    return jsonOk(await listArticles(d1, { includeDrafts }));
  } catch (err) {
    return errorResponse(err);
  }
};

/** Admin: create a draft article with a validated block document. */
export const POST: APIRoute = async ({ request, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  try {
    const denied = await adminGuard(request, d1);
    if (denied) return denied;
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
    const rec = await createArticle(d1, parseArticleInput(body, 'create'));
    return jsonOk({ ...toSummary(rec), document: rec.draft }, 201);
  } catch (err) {
    return errorResponse(err);
  }
};
