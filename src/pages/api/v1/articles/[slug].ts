import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../lib/http';
import {
  adminGuard, deleteArticle, getArticleView, parseArticleInput, resolveViewer, toSummary, updateArticle,
} from '../../../../lib/blocks/articles';

/** Published article (paywalled for non-entitled viewers); admins may request ?draft=1. */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  try {
    const viewer = await resolveViewer(request, d1);
    const draft = new URL(request.url).searchParams.get('draft') === '1';
    if (draft && !viewer.isAdmin) return jsonError(401, 'unauthorized', 'Draft access requires an admin session or key');
    const view = await getArticleView(d1, params.slug ?? '', viewer, { draft });
    if (!view) return jsonError(404, 'not_found', 'Article not found');
    return jsonOk(view, 200, { 'Cache-Control': 'private, no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};

/** Admin: update draft and metadata. Body: { expected_revision, document?, title?, ... }. */
export const PUT: APIRoute = async ({ params, request, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  try {
    const denied = await adminGuard(request, d1);
    if (denied) return denied;
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
    const rec = await updateArticle(d1, params.slug ?? '', parseArticleInput(body, 'update'), body.expected_revision);
    return jsonOk({ ...toSummary(rec), document: rec.draft });
  } catch (err) {
    return errorResponse(err);
  }
};

/** Admin: soft delete. */
export const DELETE: APIRoute = async ({ params, request, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  try {
    const denied = await adminGuard(request, d1);
    if (denied) return denied;
    await deleteArticle(d1, params.slug ?? '');
    return jsonOk({ deleted: true });
  } catch (err) {
    return errorResponse(err);
  }
};
