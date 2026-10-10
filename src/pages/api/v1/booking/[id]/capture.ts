import type { APIRoute } from 'astro';
import { errorResponse, getString, jsonOk, readJsonObject } from '../../../../../lib/http';
import { capturePaypalBooking, requireDb } from '../../../../../lib/booking/store';
import { announceOrder } from '../../../../../lib/notifications/order-notify';

/**
 * Guest: after approving on PayPal, capture the order. Returns the booking as the server sees it plus
 * `capture_status`; the page shows that state rather than trusting the PayPal redirect.
 * A booking this confirms or flags is announced to the admin channels (the webhook then sees a duplicate).
 */
export const POST: APIRoute = async ({ request, params, locals }) => {
  try {
    const env = locals.runtime?.env ?? {};
    const d1 = requireDb(env);
    const body = (await readJsonObject(request)) ?? {};
    const token = getString(body, 'token') ?? new URL(request.url).searchParams.get('token');
    const { applied, ...result } = await capturePaypalBooking(d1, env, params.id ?? '', token);
    if (applied) {
      await announceOrder(locals.runtime, env, {
        kind: 'booking', source: 'paypal', code: result.booking.code, amount: applied.amount, currency: applied.currency, outcome: applied.outcome, paymentRef: applied.ref,
      });
    }
    return jsonOk(result, 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};
