import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../../../lib/http';
import { prepareLocalization } from '../../../../../../lib/blocks/localization-service';
import { requireAdminActor } from '../../../../../../lib/taxonomy/admin';

/** Admin: translatable manifest of one edition. Body: { locales?, source_locale?, source_revision? }. */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    await requireAdminActor(request, env);
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
    return jsonOk(await prepareLocalization(env.DB, params.slug ?? '', body));
  } catch (err) {
    return errorResponse(err);
  }
};
