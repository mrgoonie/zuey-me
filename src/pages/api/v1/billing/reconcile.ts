import { jsonOk } from '../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../lib/members/account';
import { reconcileSepay } from '../../../../lib/members/billing';
import { requireCan } from '../../../../lib/members/policy';
import { applyCourseSepayPayment } from '../../../../lib/courses/course-payment-webhooks';
import { announceOrder } from '../../../../lib/notifications/order-notify';
import { SEPAY_BILLING_PREFIX } from '../../../../lib/payments/sepay';

/**
 * Admin: match recent SePay transactions (user API, SEPAY_API_TOKEN) against ZSB membership and ZSC course orders; webhook fallback.
 * Orders it pays or flags are announced like webhook payments; transfers the webhook already applied come back as duplicates and stay silent.
 */
export const POST = memberRoute(async ({ locals }, { d1, env, principal }) => {
  requireCan(principal, 'admin');
  const result = await reconcileSepay(d1, env, n => applyCourseSepayPayment(d1, env, n));
  for (const r of result.results) {
    await announceOrder(locals.runtime, env, {
      kind: r.order_code.startsWith(SEPAY_BILLING_PREFIX) ? 'membership' : 'course',
      source: 'sepay_reconcile',
      code: r.order_code,
      amount: r.amount,
      currency: 'VND',
      outcome: r.outcome,
      paymentRef: r.payment_ref,
    });
  }
  return jsonOk(result, 200, NO_STORE);
});
