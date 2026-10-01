import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk, readJsonObject } from '../../../lib/http';
import { applyPayment, requireDb } from '../../../lib/booking/store';
import { parseSepayPayload, verifySepayAuthorization } from '../../../lib/payments/sepay';

/** SePay bank-transfer webhook (`Authorization: Apikey <key>`); matches the ZBK<code> transfer content. */
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
    if (transfer.direction !== 'in' || !transfer.bookingCode) return jsonOk({ outcome: 'ignored' });
    const d1 = requireDb(env);
    const result = await applyPayment(d1, env, {
      provider: 'sepay',
      eventId: transfer.eventId,
      rawType: 'transfer_in',
      amount: transfer.amount,
      currency: 'VND',
      paymentRef: transfer.referenceCode ?? transfer.eventId,
      bookingId: null,
      bookingCode: transfer.bookingCode,
    });
    return jsonOk(result);
  } catch (err) {
    return errorResponse(err);
  }
};
