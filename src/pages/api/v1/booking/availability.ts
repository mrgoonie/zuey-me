import type { APIRoute } from 'astro';
import { AppError, errorResponse, jsonOk, readJsonObject } from '../../../../lib/http';
import { getAvailability, parseAvailabilityInput, requireAdmin, requireDb, setAvailability } from '../../../../lib/booking/store';

/** Admin: read weekly rules and blocked ranges. */
export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const d1 = requireDb(locals.runtime?.env ?? {});
    await requireAdmin(request, d1);
    return jsonOk(await getAvailability(d1));
  } catch (err) {
    return errorResponse(err);
  }
};

/** Admin: replace all rules and exceptions. */
export const PUT: APIRoute = async ({ request, locals }) => {
  try {
    const d1 = requireDb(locals.runtime?.env ?? {});
    await requireAdmin(request, d1);
    const body = await readJsonObject(request);
    if (!body) throw new AppError(400, 'invalid_body', 'Expected a JSON object body');
    return jsonOk(await setAvailability(d1, parseAvailabilityInput(body)));
  } catch (err) {
    return errorResponse(err);
  }
};
