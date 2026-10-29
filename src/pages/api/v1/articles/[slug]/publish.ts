import type { APIRoute } from 'astro';
import { errorResponse, jsonError, readJsonObject } from '../../../../../lib/http';
import { publishArticle, submittedPublishFields, toSummary, toWriteReceipt, runtimeWaitUntil } from '../../../../../lib/blocks/articles';
import { parseResponseMode } from '../../../../../lib/blocks/read-modes';
import { localeField } from '../../../../../lib/blocks/params';
import { requireAdminActor } from '../../../../../lib/taxonomy/admin';
import { idempotentJson } from '../../../../../lib/idempotency/rest';

/** Admin: publish one edition's current draft. Body: { expected_revision, confirm: true, locale?, published_at?, notify? }. */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    const { actor } = await requireAdminActor(request, env);
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
    const responseMode = parseResponseMode(body.response_mode);
    return await idempotentJson({ request, d1: env.DB, actor, operation: 'article_publish', params: { slug: params.slug }, body }, async () => {
      const rec = await publishArticle(env.DB, params.slug ?? '', body.expected_revision, body.confirm, { actor, env, waitUntil: runtimeWaitUntil(locals.runtime), locale: localeField(body), publishedAt: body.published_at, notify: body.notify });
      const summary = { ...toSummary(rec), receipt: toWriteReceipt(rec, 'publish', submittedPublishFields(body)) };
      if (responseMode === 'summary') return { ...summary, document_blocks: rec.published?.blocks.length ?? 0 };
      return { ...summary, document: rec.published };
    });
  } catch (err) {
    return errorResponse(err);
  }
};
