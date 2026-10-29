import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk } from '../../../lib/http';
import { requireMembersDb, membersRuntime } from '../../../lib/members/runtime';
import { parseDodoEvent, parseDodoReversalEvent, verifyDodoSignature } from '../../../lib/payments/dodo';
import { applyDodoEvent, applyDodoReversal } from '../../../lib/payments/dodo-billing';
import { runtimeWaitUntil } from '../../../lib/blocks/articles';
import { standardWebhookHeaders } from '../../../lib/payments/standard-webhooks';
import { applyDodoCourseWebhook } from '../../../lib/courses/course-payment-webhooks';
import { announceOrder, shouldNotifyOrder } from '../../../lib/notifications/order-notify';

/**
 * Dodo Payments webhook (Standard Webhooks signature, 5-minute replay window). Subscription and
 * payment events drive card memberships, course payments, refunds and disputes; the `webhook-id` makes every delivery idempotent.
 * refund.succeeded / dispute.opened / dispute.accepted / dispute.lost / dispute.expired of a card charge (first or renewal) are logged once; on the first payment they also reverse the referral commission.
 * One for a payment with no recorded charge is looked up at Dodo (matched by subscription id or the checkout's card reference): a renewal of a known card is applied at once, and one on a card
 * with no first payment yet answers 409 so Dodo redelivers it after the charge. A lookup that hits a Dodo outage answers 502 for a redelivery.
 * A course order it pays, a card subscription it activates, and anything it flags are announced to the admin channels.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.runtime?.env ?? {};
    if (!env.DODO_WEBHOOK_SECRET) return jsonError(503, 'payment_unconfigured', 'DODO_WEBHOOK_SECRET is not configured', { missing: ['DODO_WEBHOOK_SECRET'] });
    const body = await request.text();
    const headers = standardWebhookHeaders(request);
    if (!headers.id || !(await verifyDodoSignature(env.DODO_WEBHOOK_SECRET, headers, body, membersRuntime.now()))) {
      return jsonError(401, 'invalid_signature', 'Webhook signature verification failed');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return jsonError(400, 'invalid_body', 'Webhook body is not JSON');
    }
    const d1 = requireMembersDb(env);
    const course = await applyDodoCourseWebhook(d1, env, headers.id, payload);
    if (course) {
      const capture = course.new_capture;
      if (course.order_code && capture) {
        // A new capture on a refunded or disputed order: the order row still holds the closed payment, so the notice
        // names the captured one.
        const closed = capture.reason === 'payment_after_refund' ? 'đã hoàn tiền' : 'đang tranh chấp hoặc đã bị chargeback';
        await announceOrder(locals.runtime, env, {
          kind: 'course', source: 'dodo', code: course.order_code, outcome: course.outcome,
          amount: capture.amount, currency: capture.currency ?? 'USD', paymentRef: capture.payment_id,
          note: `Khoản thanh toán MỚI trên đơn ${closed}. Đơn giữ nguyên trạng thái, không cấp quyền truy cập; cần hoàn tiền thủ công trên Dodo hoặc quyết định xử lý.`,
        });
      } else if (course.order_code && shouldNotifyOrder(course.outcome)) {
        const row = await d1.prepare('SELECT amount_paid, currency_paid, amount_usd_cents, provider_payment_id FROM course_orders WHERE code = ?')
          .bind(course.order_code).first<Record<string, unknown>>();
        const paid = typeof row?.amount_paid === 'number' ? row.amount_paid : null;
        await announceOrder(locals.runtime, env, {
          kind: 'course', source: 'dodo', code: course.order_code, outcome: course.outcome,
          amount: paid ?? (typeof row?.amount_usd_cents === 'number' ? row.amount_usd_cents : null),
          currency: typeof row?.currency_paid === 'string' && paid !== null ? row.currency_paid : 'USD',
          paymentRef: typeof row?.provider_payment_id === 'string' ? row.provider_payment_id : null,
        });
      }
      return jsonOk(course);
    }
    const reversal = parseDodoReversalEvent(payload);
    if (reversal) return jsonOk(await applyDodoReversal(d1, reversal, env));
    const event = parseDodoEvent(payload);
    if (!event) return jsonOk({ outcome: 'ignored' });
    const result = await applyDodoEvent(d1, env, headers.id, event, runtimeWaitUntil(locals.runtime));
    if (shouldNotifyOrder(result.outcome)) {
      const card = result.card_subscription_id
        ? await d1.prepare('SELECT plan FROM card_subscriptions WHERE id = ?').bind(result.card_subscription_id).first<Record<string, unknown>>()
        : null;
      const plan = typeof card?.plan === 'string' ? card.plan : 'không rõ gói';
      await announceOrder(locals.runtime, env, {
        kind: 'membership', source: 'dodo', outcome: result.outcome,
        code: `${plan} · ${event.data.subscriptionId ?? result.card_subscription_id ?? 'chưa có mã'}`,
        amount: event.kind === 'subscription' ? event.data.amountCents : event.data.totalAmount,
        currency: event.data.currency ?? 'USD',
        paymentRef: event.kind === 'payment' ? event.data.paymentId : event.data.subscriptionId,
      });
    }
    return jsonOk(result);
  } catch (err) {
    return errorResponse(err);
  }
};
