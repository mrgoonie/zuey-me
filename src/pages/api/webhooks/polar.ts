import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk } from '../../../lib/http';
import { applyPayment, bookingRuntime, requireDb } from '../../../lib/booking/store';
import { parsePolarOrderPaid, verifyPolarSignature } from '../../../lib/payments/polar';

/** Polar webhook (Standard Webhooks signature). Only `order.paid` affects bookings. */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.runtime?.env ?? {};
    if (!env.POLAR_WEBHOOK_SECRET) return jsonError(503, 'payment_unconfigured', 'POLAR_WEBHOOK_SECRET is not configured');
    const body = await request.text();
    const headers = {
      id: request.headers.get('webhook-id'),
      timestamp: request.headers.get('webhook-timestamp'),
      signature: request.headers.get('webhook-signature'),
    };
    if (!(await verifyPolarSignature(env.POLAR_WEBHOOK_SECRET, headers, body, bookingRuntime.now()))) {
      return jsonError(401, 'invalid_signature', 'Webhook signature verification failed');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return jsonError(400, 'invalid_body', 'Webhook body is not JSON');
    }
    const order = parsePolarOrderPaid(payload);
    if (!order) return jsonOk({ outcome: 'ignored' });
    const d1 = requireDb(env);
    const result = await applyPayment(d1, env, {
      provider: 'polar',
      eventId: headers.id ?? order.orderId,
      rawType: 'order.paid',
      amount: order.amount,
      currency: order.currency,
      paymentRef: order.orderId,
      bookingId: order.bookingId,
      checkoutId: order.checkoutId,
    });
    return jsonOk(result);
  } catch (err) {
    return errorResponse(err);
  }
};
