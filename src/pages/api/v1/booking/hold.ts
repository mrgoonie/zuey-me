import type { APIRoute } from 'astro';
import { AppError, errorResponse, jsonOk, readJsonObject } from '../../../../lib/http';
import { createHold, parseHoldInput, requireDb } from '../../../../lib/booking/store';

/** Public: hold a slot for 15 minutes while the guest pays. */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.runtime?.env ?? {};
    const d1 = requireDb(env);
    const body = await readJsonObject(request);
    if (!body) throw new AppError(400, 'invalid_body', 'Expected a JSON object body');
    const result = await createHold(d1, env, parseHoldInput(body));
    return jsonOk(result, 201);
  } catch (err) {
    return errorResponse(err);
  }
};
