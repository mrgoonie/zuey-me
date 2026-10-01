import type { APIRoute } from 'astro';
import { AppError, errorResponse, getString, jsonOk, readJsonObject } from '../../../../lib/http';
import {
  adminUpdateBooking, listBookings, parseAdminAction, parseStatusFilter, requireAdmin, requireDb,
} from '../../../../lib/booking/store';

function isoParam(value: string | null, name: string): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new AppError(400, 'invalid_filter', `${name} must be an ISO date-time`);
  return new Date(ms).toISOString();
}

/** Admin: list bookings filtered by status and slot range. */
export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const d1 = requireDb(locals.runtime?.env ?? {});
    await requireAdmin(request, d1);
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
      throw new AppError(400, 'invalid_filter', 'limit must be an integer 1-500');
    }
    const bookings = await listBookings(d1, {
      status: parseStatusFilter(url.searchParams.get('status')),
      from: isoParam(url.searchParams.get('from'), 'from'),
      to: isoParam(url.searchParams.get('to'), 'to'),
      limit,
    });
    return jsonOk({ bookings }, 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};

/** Admin: cancel (no automatic refund), resolve (manual confirm), mark_attention or note. */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.runtime?.env ?? {};
    const d1 = requireDb(env);
    await requireAdmin(request, d1);
    const body = await readJsonObject(request);
    if (!body) throw new AppError(400, 'invalid_body', 'Expected a JSON object body');
    const id = getString(body, 'id');
    if (!id) throw new AppError(400, 'invalid_id', 'id is required');
    const booking = await adminUpdateBooking(d1, env, id, parseAdminAction(body.action), getString(body, 'note') ?? null);
    return jsonOk(booking);
  } catch (err) {
    return errorResponse(err);
  }
};
