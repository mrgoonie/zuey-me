import type { APIRoute } from 'astro';
import { errorResponse, getString, jsonOk, readJsonObject } from '../../../../../lib/http';
import { capturePaypalBooking, requireDb } from '../../../../../lib/booking/store';

/**
 * Guest: after approving on PayPal, capture the order. Returns the booking as the server sees it plus
 * `capture_status`; the page shows that state rather than trusting the PayPal redirect.
 */
export const POST: APIRoute = async ({ request, params, locals }) => {
  try {
    const env = locals.runtime?.env ?? {};
    const d1 = requireDb(env);
    const body = (await readJsonObject(request)) ?? {};
    const token = getString(body, 'token') ?? new URL(request.url).searchParams.get('token');
    return jsonOk(await capturePaypalBooking(d1, env, params.id ?? '', token), 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};
