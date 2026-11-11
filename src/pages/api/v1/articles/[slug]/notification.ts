import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../../lib/http';
import { setArticleNotification } from '../../../../../lib/notifications/article-notification-action';
import { requireAdminActor } from '../../../../../lib/taxonomy/admin';

/**
 * Admin: schedule, cancel or retry only the member email of the current published edition. Body: { notify: boolean }.
 * Idempotent against the single notification row; never touches the edition or its revision.
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    const { actor } = await requireAdminActor(request, env);
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
    const result = await setArticleNotification(env.DB, params.slug ?? '', body.notify, { actor });
    return jsonOk(result, 200, { 'Cache-Control': 'private, no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};
