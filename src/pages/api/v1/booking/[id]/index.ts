import type { APIRoute } from 'astro';
import { authenticateAdmin } from '../../../../../lib/auth';
import { AppError, errorResponse, jsonOk } from '../../../../../lib/http';
import {
  bookingRuntime, getBookingForGuest, getBookingRow, requireDb, toAdminView, toGuestView,
} from '../../../../../lib/booking/store';

/** Guest (with ?token= manage token) sees their booking; admins without a token see the full record. */
export const GET: APIRoute = async ({ request, params, locals }) => {
  try {
    const env = locals.runtime?.env ?? {};
    const d1 = requireDb(env);
    const id = params.id ?? '';
    const token = new URL(request.url).searchParams.get('token');
    if (!token) {
      const auth = await authenticateAdmin(request, d1);
      if (auth.authenticated) {
        const row = await getBookingRow(d1, id);
        if (!row) throw new AppError(404, 'booking_not_found', 'Booking not found');
        return jsonOk(toAdminView(row), 200, { 'Cache-Control': 'no-store' });
      }
    }
    const row = await getBookingForGuest(d1, id, token);
    return jsonOk(toGuestView(row, env, bookingRuntime.now()), 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};
