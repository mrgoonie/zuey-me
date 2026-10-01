import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { FetchLike } from '../integrations/google-calendar';

export const POLAR_DEFAULT_API_BASE = 'https://api.polar.sh';
/** $1,999.00 in cents. */
export const CONSULTATION_PRICE_USD_CENTS = 199_900;
const MAX_WEBHOOK_SKEW_SECONDS = 5 * 60;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function missingPolarCheckoutConfig(env: RuntimeEnv): string[] {
  const missing: string[] = [];
  if (!env.POLAR_ACCESS_TOKEN) missing.push('POLAR_ACCESS_TOKEN');
  if (!env.POLAR_CONSULTATION_PRODUCT_ID) missing.push('POLAR_CONSULTATION_PRODUCT_ID');
  if (!env.POLAR_WEBHOOK_SECRET) missing.push('POLAR_WEBHOOK_SECRET');
  return missing;
}

export interface PolarCheckoutInput {
  bookingId: string;
  customerEmail: string;
  successUrl: string;
}

/** Creates a Polar checkout session for the consultation product and returns its hosted URL. */
export async function createPolarCheckout(
  env: RuntimeEnv, input: PolarCheckoutInput, fetchImpl: FetchLike
): Promise<{ id: string; url: string }> {
  const missing = missingPolarCheckoutConfig(env);
  if (missing.length > 0) {
    throw new AppError(503, 'payment_unconfigured', `Polar payments are not configured: missing ${missing.join(', ')}`, { missing });
  }
  const base = (env.POLAR_API_BASE || POLAR_DEFAULT_API_BASE).replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetchImpl(`${base}/v1/checkouts/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        products: [env.POLAR_CONSULTATION_PRODUCT_ID],
        customer_email: input.customerEmail,
        success_url: input.successUrl,
        metadata: { booking_id: input.bookingId },
      }),
    });
  } catch {
    throw new AppError(502, 'payment_provider_error', 'Could not reach Polar to create a checkout session');
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || !isRecord(body) || typeof body.url !== 'string' || typeof body.id !== 'string') {
    throw new AppError(502, 'payment_provider_error', `Polar checkout creation failed (HTTP ${res.status})`);
  }
  return { id: body.id, url: body.url };
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Candidate HMAC keys for a Polar secret. Newer secrets follow Standard Webhooks
 * (`whsec_` + base64 key bytes); older ones use the UTF-8 bytes of the full secret string.
 * Polar's own SDKs try both, so we do too.
 */
function candidateKeys(secret: string): Uint8Array<ArrayBuffer>[] {
  const keys: Uint8Array<ArrayBuffer>[] = [];
  if (secret.startsWith('whsec_')) {
    const decoded = base64ToBytes(secret.slice('whsec_'.length));
    if (decoded && decoded.length > 0) keys.push(decoded);
  }
  keys.push(new TextEncoder().encode(secret));
  return keys;
}

export interface WebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/** Verifies a Standard Webhooks signature using crypto.subtle (constant-time HMAC verify). */
export async function verifyPolarSignature(
  secret: string, headers: WebhookHeaders, body: string, nowMs: number
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowMs / 1000 - ts) > MAX_WEBHOOK_SKEW_SECONDS) return false;
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
  const signatures = signature
    .split(' ')
    .map(s => s.trim())
    .filter(s => s.startsWith('v1,'))
    .map(s => base64ToBytes(s.slice(3)))
    .filter((s): s is Uint8Array<ArrayBuffer> => s !== null);
  if (signatures.length === 0) return false;
  for (const keyBytes of candidateKeys(secret)) {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    for (const sig of signatures) {
      if (await crypto.subtle.verify('HMAC', key, sig, signed)) return true;
    }
  }
  return false;
}

/** Signs a payload like Polar does (Standard Webhooks key derivation); used by tests and tooling. */
export async function signPolarPayload(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const [keyBytes] = candidateKeys(secret);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  let bin = '';
  for (const b of mac) bin += String.fromCharCode(b);
  return `v1,${btoa(bin)}`;
}

export interface PolarOrderPaid {
  bookingId: string | null;
  checkoutId: string | null;
  orderId: string;
  amount: number;
  currency: string;
}

/**
 * Extracts the booking reference and paid amount from an `order.paid` event.
 * The booking id is read from order metadata, then from an embedded checkout's metadata;
 * callers fall back to matching `checkout_id` against the stored checkout reference.
 */
export function parsePolarOrderPaid(payload: unknown): PolarOrderPaid | null {
  if (!isRecord(payload) || payload.type !== 'order.paid' || !isRecord(payload.data)) return null;
  const data = payload.data;
  if (typeof data.id !== 'string') return null;
  const amount = typeof data.total_amount === 'number' ? data.total_amount : typeof data.amount === 'number' ? data.amount : null;
  if (amount === null || typeof data.currency !== 'string') return null;
  let bookingId: string | null = null;
  if (isRecord(data.metadata) && typeof data.metadata.booking_id === 'string') bookingId = data.metadata.booking_id;
  if (!bookingId && isRecord(data.checkout) && isRecord(data.checkout.metadata) && typeof data.checkout.metadata.booking_id === 'string') {
    bookingId = data.checkout.metadata.booking_id;
  }
  return {
    bookingId,
    checkoutId: typeof data.checkout_id === 'string' ? data.checkout_id : null,
    orderId: data.id,
    amount,
    currency: data.currency.toUpperCase(),
  };
}
