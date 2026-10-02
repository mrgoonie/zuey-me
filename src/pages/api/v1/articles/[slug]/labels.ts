import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../../lib/http';
import { requireArticleId } from '../../../../../lib/blocks/articles';
import { requireAdminActor } from '../../../../../lib/taxonomy/admin';
import { getLabelState, listLabelHistory, setArticleLabels } from '../../../../../lib/taxonomy/labels';

/** Admin: current label assignments with evidence, plus label revision history. */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    await requireAdminActor(request, env);
    const articleId = await requireArticleId(env.DB, params.slug ?? '');
    return jsonOk({ ...(await getLabelState(env.DB, articleId)), history: await listLabelHistory(env.DB, articleId) });
  } catch (err) {
    return errorResponse(err);
  }
};

/**
 * Admin: replace all label assignments as a new label revision.
 * Body: { assignments: [{ label_id|label, scope, locale?, block_id?, evidence? }], expected_label_revision, reason? }.
 */
export const PUT: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    const { actor } = await requireAdminActor(request, env);
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
    const articleId = await requireArticleId(env.DB, params.slug ?? '');
    return jsonOk(await setArticleLabels(env.DB, articleId, body.assignments, body.expected_label_revision, actor, body.reason));
  } catch (err) {
    return errorResponse(err);
  }
};
