import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../../../lib/http';
import { runtimeWaitUntil } from '../../../../../../lib/blocks/articles';
import { applyLocalization } from '../../../../../../lib/blocks/localization-service';
import { requireAdminActor } from '../../../../../../lib/taxonomy/admin';

/** Admin: merge translations keyed by manifest key into one target edition draft (see the OpenAPI spec for the body). */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    const { actor } = await requireAdminActor(request, env);
    const body = await readJsonObject(request);
    if (!body) return jsonError(400, 'invalid_json', 'Body must be a JSON object');
    return jsonOk(await applyLocalization(env.DB, params.slug ?? '', body, { actor, env, waitUntil: runtimeWaitUntil(locals.runtime) }));
  } catch (err) {
    return errorResponse(err);
  }
};
