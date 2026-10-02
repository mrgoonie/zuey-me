import type { APIRoute } from 'astro';
import { AppError, errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../../lib/http';
import { deleteEdition, getArticle, toSummary } from '../../../../../lib/blocks/articles';
import { localeField } from '../../../../../lib/blocks/params';
import { requireAdminActor } from '../../../../../lib/taxonomy/admin';

/** Admin: every locale edition (draft and published state). Readers use available_locales on the article. */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    await requireAdminActor(request, env);
    const rec = await getArticle(env.DB, params.slug ?? '');
    if (!rec) return jsonError(404, 'not_found', 'Article not found');
    return jsonOk({ slug: rec.slug, primary_locale: rec.primary_locale, revision: rec.revision, editions: rec.editions });
  } catch (err) {
    return errorResponse(err);
  }
};

/** Admin: delete one non-primary edition. Body: { locale, expected_revision }. */
export const DELETE: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    const { actor } = await requireAdminActor(request, env);
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
    const locale = localeField(body);
    if (!locale) throw new AppError(400, 'invalid_field', 'locale is required', { field: 'locale' });
    const rec = await deleteEdition(env.DB, params.slug ?? '', locale, body.expected_revision, { actor, env });
    return jsonOk(toSummary(rec));
  } catch (err) {
    return errorResponse(err);
  }
};
