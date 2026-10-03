import type { APIRoute } from 'astro';
import { AppError, errorResponse, jsonOk } from '../../../../lib/http';
import { listSlots, requireDb } from '../../../../lib/booking/store';
import { SLOT_HORIZON_DAYS } from '../../../../lib/booking/availability';

/** Public: open consultation slots (UTC ISO) for the next `days` days starting at `from`. */
export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const d1 = requireDb(locals.runtime?.env ?? {});
    const url = new URL(request.url);
    const fromRaw = url.searchParams.get('from');
    const daysRaw = url.searchParams.get('days');
    const from = fromRaw ? Date.parse(fromRaw) : undefined;
    if (from !== undefined && Number.isNaN(from)) throw new AppError(400, 'invalid_from', 'from must be an ISO date-time');
    const days = daysRaw ? Number(daysRaw) : SLOT_HORIZON_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > SLOT_HORIZON_DAYS) {
      throw new AppError(400, 'invalid_days', `days must be an integer 1-${SLOT_HORIZON_DAYS}`);
    }
    const slots = await listSlots(d1, { from, days });
    return jsonOk({ slots }, 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};
