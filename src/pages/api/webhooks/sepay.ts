import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../lib/http';
import { applyPayment, requireDb } from '../../../lib/booking/store';
import { applyBillingPayment } from '../../../lib/members/billing';
import { applyCourseSepayPayment } from '../../../lib/courses/course-payment-webhooks';
import { parseSepayPayload, verifySepayAuthorization } from '../../../lib/payments/sepay';
import { notifyOrder } from '../../../lib/notifications/order-notify';
import type { OrderKind } from '../../../lib/notifications/order-notify';
import { runtimeWaitUntil } from '../../../lib/blocks/articles';

/**
 * SePay bank-transfer webhook (`Authorization: Apikey <key>`). Routes by transfer content:
 * `ZSB<code>` → membership order, `ZSC<code>` → course order, `ZBK<code>` → consultation booking. Idempotent per SePay transaction id.
 * Paid orders and transfers needing attention are announced to the admin Telegram group and Discord channel after the response.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.runtime?.env ?? {};
    if (!env.SEPAY_WEBHOOK_API_KEY) return jsonError(503, 'payment_unconfigured', 'SEPAY_WEBHOOK_API_KEY is not configured');
    if (!(await verifySepayAuthorization(env, request.headers.get('authorization')))) {
      return jsonError(401, 'invalid_api_key', 'Invalid SePay API key');
    }
    const body = await readJsonObject(request);
    const transfer = body ? parseSepayPayload(body) : null;
    if (!transfer) return jsonError(400, 'invalid_body', 'Unrecognised SePay payload');
    if (transfer.direction !== 'in') return jsonOk({ outcome: 'ignored' });
    const d1 = requireDb(env);
    const paymentRef = transfer.referenceCode ?? transfer.eventId;
    const waitUntil = runtimeWaitUntil(locals.runtime);
    const announce = async (kind: OrderKind, code: string, outcome: string) => {
      const sent = notifyOrder(env, { kind, code, amountVnd: transfer.amount, outcome, paymentRef });
      if (waitUntil) waitUntil(sent);
      else await sent;
    };
    if (transfer.billingCode) {
      const result = await applyBillingPayment(d1, env, {
        eventId: transfer.eventId,
        amount: transfer.amount,
        orderCode: transfer.billingCode,
        paymentRef,
        rawType: 'transfer_in',
        payerText: transfer.content,
        transactedAt: transfer.transactedAt,
      });
      await announce('membership', transfer.billingCode, result.outcome);
      return jsonOk(result);
    }
    if (transfer.courseCode) {
      const result = await applyCourseSepayPayment(d1, env, {
        eventId: transfer.eventId,
        amount: transfer.amount,
        orderCode: transfer.courseCode,
        paymentRef,
        rawType: 'transfer_in',
        payerText: transfer.content,
        transactedAt: transfer.transactedAt,
      });
      await announce('course', transfer.courseCode, result.outcome);
      return jsonOk(result);
    }
    if (!transfer.bookingCode) return jsonOk({ outcome: 'ignored' });
    const result = await applyPayment(d1, env, {
      provider: 'sepay',
      eventId: transfer.eventId,
      rawType: 'transfer_in',
      amount: transfer.amount,
      currency: 'VND',
      paymentRef,
      bookingId: null,
      bookingCode: transfer.bookingCode,
      payerText: transfer.content,
    });
    await announce('booking', transfer.bookingCode, result.outcome);
    return jsonOk(result);
  } catch (err) {
    return errorResponse(err);
  }
};
