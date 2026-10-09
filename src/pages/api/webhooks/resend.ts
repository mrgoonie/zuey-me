import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk } from '../../../lib/http';
import { requireDb } from '../../../lib/booking/store';
import { membersRuntime } from '../../../lib/members/runtime';
import { optOutArticleEmailsByAddress, suppressionReason } from '../../../lib/notifications/article-email-subscription';
import { verifyStandardWebhook } from '../../../lib/payments/standard-webhooks';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Resend webhook (Svix-signed: `svix-id`, `svix-timestamp`, `svix-signature`, secret `whsec_…`). Hard bounces and spam
 * complaints stop article emails to that address, protecting the sender reputation. Other events are acknowledged.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    if (!env.RESEND_WEBHOOK_SECRET) return jsonError(503, 'webhook_unconfigured', 'RESEND_WEBHOOK_SECRET is not configured');
    const raw = await request.text();
    const valid = await verifyStandardWebhook(env.RESEND_WEBHOOK_SECRET, {
      id: request.headers.get('svix-id'),
      timestamp: request.headers.get('svix-timestamp'),
      signature: request.headers.get('svix-signature'),
    }, raw, membersRuntime.now());
    if (!valid) return jsonError(401, 'invalid_signature', 'Invalid webhook signature');
    let event: unknown;
    try { event = JSON.parse(raw); } catch { return jsonError(400, 'invalid_json', 'Body must be JSON'); }
    if (!isObj(event)) return jsonError(400, 'invalid_body', 'Unrecognised Resend payload');
    const reason = suppressionReason(event);
    if (!reason) return jsonOk({ outcome: 'ignored' });
    const data = isObj(event.data) ? event.data : {};
    const recipients = Array.isArray(data.to) ? data.to.filter((t): t is string => typeof t === 'string') : [];
    const db = requireDb(env);
    let suppressed = 0;
    for (const to of recipients) suppressed += await optOutArticleEmailsByAddress(db, to, reason);
    return jsonOk({ outcome: 'suppressed', reason, suppressed });
  } catch (err) {
    return errorResponse(err);
  }
};
