import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk } from '../../../lib/http';
import { applyPayment, applyPaypalReversal, bookingRuntime, getBookingRow, requireDb } from '../../../lib/booking/store';
import { announceOrder, shouldNotifyOrder } from '../../../lib/notifications/order-notify';
import {
  missingPaypalConfig, parsePaypalCaptureEvent, parsePaypalReversalEvent, paypalWebhookHeaders, verifyPaypalWebhook,
} from '../../../lib/payments/paypal';

/**
 * PayPal webhook, authenticated through PayPal's verify-webhook-signature API. Only
 * PAYMENT.CAPTURE.COMPLETED affects bookings. It uses the capture id as idempotency key, shared with
 * the capture-on-return path, so whichever of the two arrives second is a no-op.
 * PAYMENT.CAPTURE.REFUNDED / .REVERSED and CUSTOMER.DISPUTE.CREATED reverse the booking's referral commission.
 * A booking it confirms or flags is announced to the admin channels.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.runtime?.env ?? {};
    const missing = missingPaypalConfig(env);
    if (missing.length > 0) return jsonError(503, 'payment_unconfigured', `PayPal is not configured: missing ${missing.join(', ')}`, { missing });
    const raw = await request.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return jsonError(400, 'invalid_body', 'Webhook body is not JSON');
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return jsonError(400, 'invalid_body', 'Webhook body must be a JSON object');
    }
    if (!(await verifyPaypalWebhook(env, paypalWebhookHeaders(request), raw, bookingRuntime.fetch, bookingRuntime.now()))) {
      return jsonError(401, 'invalid_signature', 'PayPal webhook signature verification failed');
    }
    const reversal = parsePaypalReversalEvent(payload);
    if (reversal) return jsonOk(await applyPaypalReversal(requireDb(env), reversal));
    const event = parsePaypalCaptureEvent(payload);
    if (!event || event.eventType !== 'PAYMENT.CAPTURE.COMPLETED' || event.status !== 'COMPLETED') return jsonOk({ outcome: 'ignored' });
    if (event.amountCents === null || !event.currency) return jsonError(400, 'invalid_body', 'Capture has no readable amount');
    const d1 = requireDb(env);
    const result = await applyPayment(d1, env, {
      provider: 'paypal',
      eventId: event.captureId,
      rawType: event.eventType,
      amount: event.amountCents,
      currency: event.currency,
      paymentRef: event.captureId,
      bookingId: event.customId,
      checkoutId: event.orderId,
    });
    const booking = result.booking_id && shouldNotifyOrder(result.outcome) ? await getBookingRow(d1, result.booking_id) : null;
    if (booking) {
      await announceOrder(locals.runtime, env, {
        kind: 'booking', source: 'paypal', code: booking.code, amount: event.amountCents, currency: event.currency, outcome: result.outcome, paymentRef: event.captureId,
      });
    }
    return jsonOk(result);
  } catch (err) {
    return errorResponse(err);
  }
};
