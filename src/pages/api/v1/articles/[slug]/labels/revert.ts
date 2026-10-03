import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../../../lib/http';
import { requireArticleId } from '../../../../../../lib/blocks/articles';
import { requireAdminActor } from '../../../../../../lib/taxonomy/admin';
import { revertLabels } from '../../../../../../lib/taxonomy/labels';

/** Admin: restore an earlier label set as a NEW label revision. Body: { to_label_revision, expected_label_revision, reason? }. */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    const { actor } = await requireAdminActor(request, env);
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
    const articleId = await requireArticleId(env.DB, params.slug ?? '');
    return jsonOk(await revertLabels(env.DB, articleId, body.to_label_revision, body.expected_label_revision, actor, body.reason));
  } catch (err) {
    return errorResponse(err);
  }
};
