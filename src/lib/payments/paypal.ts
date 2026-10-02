import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { FetchLike } from '../integrations/google-calendar';

/**
 * PayPal Business (Orders v2) for the one-off $1,999 consultation. PayPal is not a merchant of record,
 * so it accepts consulting services that MoR providers refuse. Fetch-only client for the edge runtime.
 */
export const PAYPAL_DEFAULT_API_BASE = 'https://api-m.paypal.com';
export const PAYPAL_SANDBOX_API_BASE = 'https://api-m.sandbox.paypal.com';
/** Refresh the OAuth token this long before PayPal says it expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function missingPaypalConfig(env: RuntimeEnv): string[] {
  const missing: string[] = [];
  if (!env.PAYPAL_CLIENT_ID) missing.push('PAYPAL_CLIENT_ID');
  if (!env.PAYPAL_CLIENT_SECRET) missing.push('PAYPAL_CLIENT_SECRET');
  if (!env.PAYPAL_WEBHOOK_ID) missing.push('PAYPAL_WEBHOOK_ID');
  return missing;
}

function requireConfigured(env: RuntimeEnv): { base: string; clientId: string; clientSecret: string; webhookId: string } {
  const missing = missingPaypalConfig(env);
  if (missing.length > 0 || !env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET || !env.PAYPAL_WEBHOOK_ID) {
    throw new AppError(503, 'payment_unconfigured', `PayPal payments are not configured: missing ${missing.join(', ')}`, { missing });
  }
  return {
    base: (env.PAYPAL_API_BASE || PAYPAL_DEFAULT_API_BASE).replace(/\/+$/, ''),
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    webhookId: env.PAYPAL_WEBHOOK_ID,
  };
}

/** Converts a PayPal decimal string ("1999.00") to integer cents; null when malformed. */
export function decimalToCents(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{1,9}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function centsToDecimal(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// OAuth client credentials (token cached in memory per isolate)
// ---------------------------------------------------------------------------

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Clears cached access tokens (tests, or after PayPal rejects a token). */
export function resetPaypalTokenCache(): void {
  tokenCache.clear();
}

async function accessToken(env: RuntimeEnv, fetchImpl: FetchLike, nowMs: number): Promise<string> {
  const cfg = requireConfigured(env);
  const cacheKey = `${cfg.base}|${cfg.clientId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) return cached.token;
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
  } catch {
    throw new AppError(502, 'payment_provider_error', 'Could not reach PayPal to authenticate');
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || !isRecord(body) || typeof body.access_token !== 'string') {
    throw new AppError(502, 'payment_provider_error', `PayPal authentication failed (HTTP ${res.status})`);
  }
  const ttlMs = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in * 1000 : 0;
  tokenCache.set(cacheKey, { token: body.access_token, expiresAt: nowMs + Math.max(0, ttlMs - TOKEN_REFRESH_MARGIN_MS) });
  return body.access_token;
}

interface PaypalResponse {
  status: number;
  body: unknown;
}

/** Authenticated JSON call; a 401 drops the cached token and retries once with a fresh one. */
async function paypalRequest(
  env: RuntimeEnv, path: string, init: { method: string; body?: string; requestId?: string }, fetchImpl: FetchLike, nowMs: number
): Promise<PaypalResponse> {
  const cfg = requireConfigured(env);
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken(env, fetchImpl, nowMs);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
    if (init.requestId) headers['PayPal-Request-Id'] = init.requestId;
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.base}${path}`, { method: init.method, headers, body: init.body });
    } catch {
      throw new AppError(502, 'payment_provider_error', 'Could not reach PayPal');
    }
    if (res.status === 401 && attempt === 0) {
      tokenCache.delete(`${cfg.base}|${cfg.clientId}`);
      continue;
    }
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  throw new AppError(502, 'payment_provider_error', 'PayPal rejected the access token');
}

// ---------------------------------------------------------------------------
// Orders v2
// ---------------------------------------------------------------------------

export interface PaypalOrderInput {
  bookingId: string;
  bookingCode: string;
  amountCents: number;
  returnUrl: string;
  cancelUrl: string;
}

/** Builds the Orders v2 create payload: USD capture, custom_id = booking id, no shipping. */
export function paypalOrderPayload(input: PaypalOrderInput): Record<string, unknown> {
  return {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: input.bookingCode,
      custom_id: input.bookingId,
      description: 'Zuey for Business: one-off 90-minute consultation',
      amount: { currency_code: 'USD', value: centsToDecimal(input.amountCents) },
    }],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'Zuey',
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
        },
      },
    },
  };
}

function approvalUrl(body: Record<string, unknown>): string | null {
  const links = Array.isArray(body.links) ? body.links.filter(isRecord) : [];
  const link = links.find(l => l.rel === 'payer-action') ?? links.find(l => l.rel === 'approve');
  return link && typeof link.href === 'string' ? link.href : null;
}

/**
 * Creates an order and returns the PayPal approval URL. The PayPal-Request-Id makes the call idempotent
 * per booking, so a retried checkout returns the same order instead of creating a second one.
 */
export async function createPaypalOrder(
  env: RuntimeEnv, input: PaypalOrderInput, fetchImpl: FetchLike, nowMs: number
): Promise<{ id: string; approveUrl: string }> {
  const res = await paypalRequest(env, '/v2/checkout/orders', {
    method: 'POST', body: JSON.stringify(paypalOrderPayload(input)), requestId: `zuey-order-${input.bookingId}`,
  }, fetchImpl, nowMs);
  const url = isRecord(res.body) ? approvalUrl(res.body) : null;
  if (res.status >= 300 || !isRecord(res.body) || typeof res.body.id !== 'string' || !url) {
    throw new AppError(502, 'payment_provider_error', `PayPal order creation failed (HTTP ${res.status})`);
  }
  return { id: res.body.id, approveUrl: url };
}

export interface PaypalCapture {
  id: string;
  status: string;
  amountCents: number | null;
  currency: string | null;
  customId: string | null;
}

export interface PaypalOrderState {
  orderId: string;
  /** Order status (COMPLETED, APPROVED, PAYER_ACTION_REQUIRED, …) or NOT_APPROVED when the payer never approved. */
  status: string;
  capture: PaypalCapture | null;
}

function parseCapture(v: unknown, fallbackCustomId: string | null): PaypalCapture | null {
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.status !== 'string') return null;
  const amount = isRecord(v.amount) ? v.amount : {};
  return {
    id: v.id,
    status: v.status,
    amountCents: decimalToCents(amount.value),
    currency: typeof amount.currency_code === 'string' ? amount.currency_code.toUpperCase() : null,
    customId: typeof v.custom_id === 'string' ? v.custom_id : fallbackCustomId,
  };
}

/** Reads the first capture of the first purchase unit from an order body. */
export function parsePaypalOrder(body: unknown): PaypalOrderState | null {
  if (!isRecord(body) || typeof body.id !== 'string') return null;
  const unit = Array.isArray(body.purchase_units) ? body.purchase_units.find(isRecord) : undefined;
  const unitCustomId = unit && typeof unit.custom_id === 'string' ? unit.custom_id : null;
  const captures = unit && isRecord(unit.payments) && Array.isArray(unit.payments.captures) ? unit.payments.captures : [];
  return {
    orderId: body.id,
    status: typeof body.status === 'string' ? body.status : 'UNKNOWN',
    capture: captures.length > 0 ? parseCapture(captures[0], unitCustomId) : null,
  };
}

function issueOf(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.details)) return null;
  const first = body.details.find(isRecord);
  return first && typeof first.issue === 'string' ? first.issue : null;
}

/**
 * Captures an approved order (idempotent per order via PayPal-Request-Id). An order captured earlier
 * is read back instead; an order the payer has not approved yields status NOT_APPROVED.
 */
export async function capturePaypalOrder(env: RuntimeEnv, orderId: string, fetchImpl: FetchLike, nowMs: number): Promise<PaypalOrderState> {
  const path = `/v2/checkout/orders/${encodeURIComponent(orderId)}`;
  const res = await paypalRequest(env, `${path}/capture`, { method: 'POST', body: '{}', requestId: `zuey-capture-${orderId}` }, fetchImpl, nowMs);
  if (res.status < 300) {
    const parsed = parsePaypalOrder(res.body);
    if (!parsed) throw new AppError(502, 'payment_provider_error', 'PayPal returned an unreadable capture response');
    return parsed;
  }
  const issue = issueOf(res.body);
  if (res.status === 422 && issue === 'ORDER_NOT_APPROVED') return { orderId, status: 'NOT_APPROVED', capture: null };
  if (res.status === 422 && issue === 'ORDER_ALREADY_CAPTURED') {
    const current = await paypalRequest(env, path, { method: 'GET' }, fetchImpl, nowMs);
    const parsed = current.status < 300 ? parsePaypalOrder(current.body) : null;
    if (!parsed) throw new AppError(502, 'payment_provider_error', `PayPal order lookup failed (HTTP ${current.status})`);
    return parsed;
  }
  throw new AppError(502, 'payment_provider_error', `PayPal capture failed (HTTP ${res.status}${issue ? `, ${issue}` : ''})`);
}

// ---------------------------------------------------------------------------
// Webhooks: verified by PayPal's verify-webhook-signature API (postback)
// ---------------------------------------------------------------------------

export interface PaypalWebhookHeaders {
  authAlgo: string | null;
  certUrl: string | null;
  transmissionId: string | null;
  transmissionSig: string | null;
  transmissionTime: string | null;
}

export function paypalWebhookHeaders(request: Request): PaypalWebhookHeaders {
  return {
    authAlgo: request.headers.get('paypal-auth-algo'),
    certUrl: request.headers.get('paypal-cert-url'),
    transmissionId: request.headers.get('paypal-transmission-id'),
    transmissionSig: request.headers.get('paypal-transmission-sig'),
    transmissionTime: request.headers.get('paypal-transmission-time'),
  };
}

/**
 * Asks PayPal whether the notification is authentic. The raw event body is embedded verbatim so the
 * signed bytes are exactly what PayPal sent (re-serialising could change them and fail verification).
 */
export async function verifyPaypalWebhook(
  env: RuntimeEnv, headers: PaypalWebhookHeaders, rawBody: string, fetchImpl: FetchLike, nowMs: number
): Promise<boolean> {
  const cfg = requireConfigured(env);
  const { authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime } = headers;
  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) return false;
  const fields = JSON.stringify({
    auth_algo: authAlgo, cert_url: certUrl, transmission_id: transmissionId, transmission_sig: transmissionSig,
    transmission_time: transmissionTime, webhook_id: cfg.webhookId,
  });
  const body = `${fields.slice(0, -1)},"webhook_event":${rawBody.trim()}}`;
  const res = await paypalRequest(env, '/v1/notifications/verify-webhook-signature', { method: 'POST', body }, fetchImpl, nowMs);
  if (res.status >= 300) {
    throw new AppError(502, 'payment_provider_error', `PayPal webhook verification call failed (HTTP ${res.status})`);
  }
  return isRecord(res.body) && res.body.verification_status === 'SUCCESS';
}

export interface PaypalCaptureEvent {
  eventId: string;
  eventType: string;
  captureId: string;
  status: string;
  amountCents: number | null;
  currency: string | null;
  customId: string | null;
  orderId: string | null;
}

/** Extracts the capture from a PAYMENT.CAPTURE.* event; null for other events or malformed payloads. */
export function parsePaypalCaptureEvent(payload: unknown): PaypalCaptureEvent | null {
  if (!isRecord(payload) || typeof payload.id !== 'string' || typeof payload.event_type !== 'string') return null;
  if (!payload.event_type.startsWith('PAYMENT.CAPTURE.')) return null;
  const capture = parseCapture(payload.resource, null);
  if (!capture) return null;
  const resource = isRecord(payload.resource) ? payload.resource : {};
  const related = isRecord(resource.supplementary_data) && isRecord(resource.supplementary_data.related_ids)
    ? resource.supplementary_data.related_ids : {};
  return {
    eventId: payload.id,
    eventType: payload.event_type,
    captureId: capture.id,
    status: capture.status,
    amountCents: capture.amountCents,
    currency: capture.currency,
    customId: capture.customId,
    orderId: typeof related.order_id === 'string' ? related.order_id : null,
  };
}
