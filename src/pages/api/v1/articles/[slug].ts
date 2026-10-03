import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../lib/http';
import { deleteArticle, getArticleView, parseArticleInput, resolveReader, toSummary, updateArticle } from '../../../../lib/blocks/articles';
import { localeParam } from '../../../../lib/blocks/params';
import { requireAdminActor } from '../../../../lib/taxonomy/admin';

/**
 * One edition of a published article (?lang=, default primary), paywalled for non-entitled viewers.
 * Admins may request ?draft=1 for the edition's draft.
 */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    const { viewer, principal } = await resolveReader(request, env.DB, env);
    if (principal.credentialError) {
      return jsonError(principal.credentialError.status, principal.credentialError.code, principal.credentialError.message);
    }
    const url = new URL(request.url);
    const draft = url.searchParams.get('draft') === '1';
    if (draft && !viewer.isAdmin) return jsonError(401, 'unauthorized', 'Draft access requires an admin session or key');
    const view = await getArticleView(env.DB, params.slug ?? '', viewer, { draft, locale: localeParam(url) });
    if (!view) return jsonError(404, 'not_found', 'Article not found');
    return jsonOk(view, 200, { 'Cache-Control': 'private, no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};

/**
 * Admin: update one edition's draft (body.locale, default primary; a missing edition is created and
 * needs a title) plus article-wide metadata. Body: { expected_revision, locale?, document?, title?, tags?, category?, ... }.
 */
export const PUT: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    const { actor } = await requireAdminActor(request, env);
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
    const rec = await updateArticle(env.DB, params.slug ?? '', parseArticleInput(body, 'update'), body.expected_revision, { actor, env });
    return jsonOk({ ...toSummary(rec), document: rec.draft });
  } catch (err) {
    return errorResponse(err);
  }
};

/** Admin: soft delete (all editions; search rows are removed immediately). */
export const DELETE: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    const { actor } = await requireAdminActor(request, env);
    await deleteArticle(env.DB, params.slug ?? '', { actor, env });
    return jsonOk({ deleted: true });
  } catch (err) {
    return errorResponse(err);
  }
};
