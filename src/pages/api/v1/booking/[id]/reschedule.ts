import type { APIRoute } from 'astro';
import { AppError, errorResponse, getString, jsonOk, readJsonObject } from '../../../../../lib/http';
import { requireDb, rescheduleBooking } from '../../../../../lib/booking/store';

/** Guest: move a confirmed booking once, at least 48h ahead, to another open slot. */
export const POST: APIRoute = async ({ request, params, locals }) => {
  try {
    const env = locals.runtime?.env ?? {};
    const d1 = requireDb(env);
    const body = await readJsonObject(request);
    if (!body) throw new AppError(400, 'invalid_body', 'Expected a JSON object body');
    const slotStart = getString(body, 'slot_start');
    if (!slotStart) throw new AppError(400, 'invalid_slot', 'slot_start is required');
    return jsonOk(await rescheduleBooking(d1, env, params.id ?? '', getString(body, 'token') ?? null, slotStart));
  } catch (err) {
    return errorResponse(err);
  }
};
