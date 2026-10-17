import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../../lib/http';
import { publishArticle, toSummary, runtimeWaitUntil } from '../../../../../lib/blocks/articles';
import { parseResponseMode } from '../../../../../lib/blocks/read-modes';
import { localeField } from '../../../../../lib/blocks/params';
import { requireAdminActor } from '../../../../../lib/taxonomy/admin';

/** Admin: publish one edition's current draft. Body: { expected_revision, confirm: true, locale?, published_at?, notify? }. */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    const { actor } = await requireAdminActor(request, env);
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
    const responseMode = parseResponseMode(body.response_mode);
    const rec = await publishArticle(env.DB, params.slug ?? '', body.expected_revision, body.confirm, { actor, env, waitUntil: runtimeWaitUntil(locals.runtime), locale: localeField(body), publishedAt: body.published_at, notify: body.notify });
    if (responseMode === 'summary') return jsonOk({ ...toSummary(rec), document_blocks: rec.published?.blocks.length ?? 0 });
    return jsonOk({ ...toSummary(rec), document: rec.published });
  } catch (err) {
    return errorResponse(err);
  }
};
