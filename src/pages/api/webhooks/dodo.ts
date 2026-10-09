import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk } from '../../../lib/http';
import { requireMembersDb, membersRuntime } from '../../../lib/members/runtime';
import { parseDodoEvent, parseDodoReversalEvent, verifyDodoSignature } from '../../../lib/payments/dodo';
import { applyDodoEvent, applyDodoReversal } from '../../../lib/payments/dodo-billing';
import { standardWebhookHeaders } from '../../../lib/payments/standard-webhooks';
import { applyDodoCourseWebhook } from '../../../lib/courses/course-payment-webhooks';

/**
 * Dodo Payments webhook (Standard Webhooks signature, 5-minute replay window). Subscription and
 * payment events drive card memberships, course payments, refunds and disputes; the `webhook-id` makes every delivery idempotent.
 * refund.succeeded / dispute.opened / dispute.lost reverse the referral commission of the refunded first payment.
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
    if (course) return jsonOk(course);
    const reversal = parseDodoReversalEvent(payload);
    if (reversal) return jsonOk(await applyDodoReversal(d1, reversal));
    const event = parseDodoEvent(payload);
    if (!event) return jsonOk({ outcome: 'ignored' });
    return jsonOk(await applyDodoEvent(d1, env, headers.id, event));
  } catch (err) {
    return errorResponse(err);
  }
};
