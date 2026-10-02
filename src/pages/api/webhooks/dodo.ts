import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk } from '../../../lib/http';
import { requireMembersDb, membersRuntime } from '../../../lib/members/runtime';
import { parseDodoEvent, verifyDodoSignature } from '../../../lib/payments/dodo';
import { applyDodoEvent } from '../../../lib/payments/dodo-billing';
import { standardWebhookHeaders } from '../../../lib/payments/standard-webhooks';

/**
 * Dodo Payments webhook (Standard Webhooks signature, 5-minute replay window). Subscription and
 * payment events drive card memberships; the `webhook-id` makes every delivery idempotent.
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
    const event = parseDodoEvent(payload);
    if (!event) return jsonOk({ outcome: 'ignored' });
    return jsonOk(await applyDodoEvent(requireMembersDb(env), env, headers.id, event));
  } catch (err) {
    return errorResponse(err);
  }
};
