import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { FetchLike } from '../integrations/google-calendar';
import type { PlanId } from '../members/plans';
import { PLAN_IDS } from '../members/plans';
import { signStandardWebhook, verifyStandardWebhook } from './standard-webhooks';

/**
 * Dodo Payments (merchant of record) for the four monthly memberships. Fetch-only REST client;
 * webhooks follow Standard Webhooks (see ./standard-webhooks).
 */
export const DODO_LIVE_API_BASE = 'https://live.dodopayments.com';
export const DODO_TEST_API_BASE = 'https://test.dodopayments.com';

export const verifyDodoSignature = verifyStandardWebhook;
/** Signs a payload like Dodo does; used by tests and tooling. */
export const signDodoPayload = signStandardWebhook;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const PRODUCT_ENV: Record<PlanId, 'DODO_PRODUCT_KNOWLEDGES' | 'DODO_PRODUCT_AI' | 'DODO_PRODUCT_COMBO' | 'DODO_PRODUCT_COMMUNITY'> = {
  knowledges: 'DODO_PRODUCT_KNOWLEDGES',
  ai: 'DODO_PRODUCT_AI',
  combo: 'DODO_PRODUCT_COMBO',
  community: 'DODO_PRODUCT_COMMUNITY',
};

/** API key and webhook secret: without both, no plan can be sold by card. */
export function missingDodoConfig(env: RuntimeEnv): string[] {
  const missing: string[] = [];
  if (!env.DODO_API_KEY) missing.push('DODO_API_KEY');
  if (!env.DODO_WEBHOOK_SECRET) missing.push('DODO_WEBHOOK_SECRET');
  return missing;
}

export function dodoProductEnvName(plan: PlanId): string {
  return PRODUCT_ENV[plan];
}

export function dodoProductId(env: RuntimeEnv, plan: PlanId): string | null {
  const value = env[PRODUCT_ENV[plan]];
  return value && value.trim() ? value.trim() : null;
}

/** Plans purchasable by card right now (credentials present and the plan's product configured). */
export function dodoCardPlans(env: RuntimeEnv): PlanId[] {
  if (missingDodoConfig(env).length > 0) return [];
  return PLAN_IDS.filter(p => dodoProductId(env, p) !== null);
}

/** Maps a Dodo product id back to the plan it is configured for. */
export function planForDodoProduct(env: RuntimeEnv, productId: string | null): PlanId | null {
  if (!productId) return null;
  return PLAN_IDS.find(p => dodoProductId(env, p) === productId) ?? null;
}

/** Throws 503 `payment_unconfigured` (listing env names) unless the plan can be sold by card. */
export function requireDodoPlan(env: RuntimeEnv, plan: PlanId): { base: string; apiKey: string; productId: string } {
  const missing = missingDodoConfig(env);
  const productId = dodoProductId(env, plan);
  if (!productId) missing.push(PRODUCT_ENV[plan]);
  if (missing.length > 0 || !env.DODO_API_KEY || !productId) {
    throw new AppError(503, 'payment_unconfigured', `Card payments (Dodo) are not configured: missing ${missing.join(', ')}`, { missing });
  }
  return { base: dodoBase(env), apiKey: env.DODO_API_KEY, productId };
}

export function dodoBase(env: RuntimeEnv): string {
  return (env.DODO_API_BASE || DODO_LIVE_API_BASE).replace(/\/+$/, '');
}

function requireApiKey(env: RuntimeEnv): string {
  if (!env.DODO_API_KEY) {
    throw new AppError(503, 'payment_unconfigured', 'Card payments (Dodo) are not configured: missing DODO_API_KEY', { missing: ['DODO_API_KEY'] });
  }
  return env.DODO_API_KEY;
}

async function dodoRequest(
  env: RuntimeEnv, path: string, init: { method: string; body?: unknown }, fetchImpl: FetchLike, what: string
): Promise<Record<string, unknown>> {
  const apiKey = requireApiKey(env);
  let res: Response;
  try {
    res = await fetchImpl(`${dodoBase(env)}${path}`, {
      method: init.method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new AppError(502, 'payment_provider_error', `Could not reach Dodo Payments (${what})`);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || !isRecord(body)) throw new AppError(502, 'payment_provider_error', `Dodo Payments ${what} failed (HTTP ${res.status})`);
  return body;
}

export interface DodoCheckoutInput {
  plan: PlanId;
  customerEmail: string;
  customerName: string | null;
  returnUrl: string;
  /** Echoed back on the subscription and payment webhooks. */
  metadata: Record<string, string>;
  /** Server-created discount codes to pre-apply (referral checkouts only). */
  discountCodes?: string[];
}

/**
 * Hosted checkout feature flags. Dodo rejects `discount_codes` with 422 ("Discount code is not allowed if
 * allow_discount_code is false"), verified in test mode, so the code input is enabled only when a server-created
 * referral code is pre-applied (it shows pre-filled). Plain checkouts keep the input hidden.
 */
export function dodoFeatureFlags(hasDiscountCodes = false): Record<string, boolean> {
  return { allow_discount_code: hasDiscountCodes, allow_currency_selection: false };
}

/** Builds the checkout session request: one subscription product, optional pre-applied codes, fixed currency. */
export function dodoCheckoutPayload(productId: string, input: DodoCheckoutInput): Record<string, unknown> {
  const customer: Record<string, string> = { email: input.customerEmail };
  if (input.customerName) customer.name = input.customerName;
  const payload: Record<string, unknown> = {
    product_cart: [{ product_id: productId, quantity: 1 }],
    customer,
    return_url: input.returnUrl,
    metadata: input.metadata,
    feature_flags: dodoFeatureFlags(Boolean(input.discountCodes?.length)),
  };
  if (input.discountCodes?.length) payload.discount_codes = input.discountCodes;
  return payload;
}

export interface DodoDiscountInput {
  productId: string;
  /** Whole percent off (1–100); sent to Dodo in basis points. */
  percent: number;
  expiresAt: string;
  metadata: Record<string, string>;
}

/**
 * Discount request for one referred checkout: single use, first billing cycle only, this product only,
 * short expiry. Dodo generates the code.
 */
export function dodoDiscountPayload(input: DodoDiscountInput): Record<string, unknown> {
  const percent = Math.trunc(input.percent);
  if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
    throw new AppError(500, 'invalid_discount', `Discount percent must be 1-100, got ${input.percent}`);
  }
  return {
    type: 'percentage',
    amount: percent * 100,
    usage_limit: 1,
    subscription_cycles: 1,
    restricted_to: [input.productId],
    expires_at: input.expiresAt,
    name: `Referral ${percent}%`,
    metadata: input.metadata,
  };
}

/** Creates a one-off referral discount and returns its id and code. */
export async function createDodoDiscount(env: RuntimeEnv, input: DodoDiscountInput, fetchImpl: FetchLike): Promise<{ discountId: string; code: string }> {
  const body = await dodoRequest(env, '/discounts', { method: 'POST', body: dodoDiscountPayload(input) }, fetchImpl, 'discount creation');
  if (typeof body.discount_id !== 'string' || typeof body.code !== 'string' || !body.code) {
    throw new AppError(502, 'payment_provider_error', 'Dodo Payments returned no discount code');
  }
  return { discountId: body.discount_id, code: body.code };
}

/** Creates a hosted checkout session and returns its id and URL. */
export async function createDodoCheckout(env: RuntimeEnv, input: DodoCheckoutInput, fetchImpl: FetchLike): Promise<{ sessionId: string; url: string }> {
  const { productId } = requireDodoPlan(env, input.plan);
  const body = await dodoRequest(env, '/checkouts', { method: 'POST', body: dodoCheckoutPayload(productId, input) }, fetchImpl, 'checkout creation');
  if (typeof body.session_id !== 'string' || typeof body.checkout_url !== 'string') {
    throw new AppError(502, 'payment_provider_error', 'Dodo Payments returned no checkout URL');
  }
  return { sessionId: body.session_id, url: body.checkout_url };
}

export interface DodoOneTimeCheckoutInput {
  productId: string;
  /** Final price in US cents; the product must be pay-what-you-want so Dodo accepts the amount. */
  amountCents: number;
  customerEmail: string;
  customerName: string | null;
  returnUrl: string;
  metadata: Record<string, string>;
}

/** One-time checkout for a pay-what-you-want product at a server-computed amount (courses). */
export function dodoOneTimeCheckoutPayload(input: DodoOneTimeCheckoutInput): Record<string, unknown> {
  const customer: Record<string, string> = { email: input.customerEmail };
  if (input.customerName) customer.name = input.customerName;
  return {
    product_cart: [{ product_id: input.productId, quantity: 1, amount: input.amountCents }],
    customer,
    billing_currency: 'USD',
    return_url: input.returnUrl,
    metadata: input.metadata,
    feature_flags: { allow_discount_code: false, allow_currency_selection: false },
  };
}

export async function createDodoOneTimeCheckout(env: RuntimeEnv, input: DodoOneTimeCheckoutInput, fetchImpl: FetchLike): Promise<{ sessionId: string; url: string }> {
  const body = await dodoRequest(env, '/checkouts', { method: 'POST', body: dodoOneTimeCheckoutPayload(input) }, fetchImpl, 'checkout creation');
  if (typeof body.session_id !== 'string' || typeof body.checkout_url !== 'string') {
    throw new AppError(502, 'payment_provider_error', 'Dodo Payments returned no checkout URL');
  }
  return { sessionId: body.session_id, url: body.checkout_url };
}

/** Short-lived Dodo customer portal link (manage card, invoices, cancel). */
export async function createDodoPortalLink(env: RuntimeEnv, customerId: string, fetchImpl: FetchLike): Promise<string> {
  const body = await dodoRequest(env, `/customers/${encodeURIComponent(customerId)}/customer-portal/session`, { method: 'POST' }, fetchImpl, 'portal session');
  if (typeof body.link !== 'string') throw new AppError(502, 'payment_provider_error', 'Dodo Payments returned no portal link');
  return body.link;
}

/** Schedules cancellation at the end of the paid period; access continues until then. */
export async function cancelDodoSubscription(env: RuntimeEnv, subscriptionId: string, fetchImpl: FetchLike): Promise<DodoSubscriptionData | null> {
  const body = await dodoRequest(env, `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'PATCH', body: { cancel_at_next_billing_date: true },
  }, fetchImpl, 'subscription cancellation');
  return parseSubscriptionData(body);
}

// ---------------------------------------------------------------------------
// Webhook payloads
// ---------------------------------------------------------------------------

export interface DodoMetadata {
  userId: string | null;
  plan: PlanId | null;
  cardRef: string | null;
}

export interface DodoSubscriptionData {
  subscriptionId: string;
  status: string | null;
  productId: string | null;
  customerId: string | null;
  customerEmail: string | null;
  amountCents: number | null;
  currency: string | null;
  nextBillingDate: string | null;
  cancelAtPeriodEnd: boolean;
  metadata: DodoMetadata;
}

export interface DodoPaymentData {
  paymentId: string;
  subscriptionId: string | null;
  status: string | null;
  totalAmount: number | null;
  /** Tax included in `totalAmount`, minor units (null when Dodo sends none). */
  tax: number | null;
  currency: string | null;
  customerId: string | null;
  customerEmail: string | null;
  metadata: DodoMetadata;
}

export type DodoEvent =
  | { kind: 'subscription'; type: string; occurredAt: string | null; data: DodoSubscriptionData }
  | { kind: 'payment'; type: string; occurredAt: string | null; data: DodoPaymentData };

function strOrNull(r: Record<string, unknown>, k: string): string | null {
  const v = r[k];
  return typeof v === 'string' && v ? v : null;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function parseMetadata(v: unknown): DodoMetadata {
  const m = isRecord(v) ? v : {};
  const plan = m.plan;
  return {
    userId: strOrNull(m, 'user_id'),
    plan: typeof plan === 'string' && (PLAN_IDS as string[]).includes(plan) ? PLAN_IDS.find(p => p === plan) ?? null : null,
    cardRef: strOrNull(m, 'card_ref'),
  };
}

function customerOf(r: Record<string, unknown>): { id: string | null; email: string | null } {
  const c = isRecord(r.customer) ? r.customer : {};
  return { id: strOrNull(c, 'customer_id'), email: strOrNull(c, 'email')?.toLowerCase() ?? null };
}

function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

export function parseSubscriptionData(d: Record<string, unknown>): DodoSubscriptionData | null {
  const id = strOrNull(d, 'subscription_id');
  if (!id) return null;
  const customer = customerOf(d);
  return {
    subscriptionId: id,
    status: strOrNull(d, 'status'),
    productId: strOrNull(d, 'product_id'),
    customerId: customer.id,
    customerEmail: customer.email,
    amountCents: intOrNull(d.recurring_pre_tax_amount),
    currency: strOrNull(d, 'currency')?.toUpperCase() ?? null,
    nextBillingDate: isoOrNull(d.next_billing_date),
    cancelAtPeriodEnd: d.cancel_at_next_billing_date === true,
    metadata: parseMetadata(d.metadata),
  };
}

/** Validates a webhook body into a subscription or payment event; null for anything else. */
export function parseDodoEvent(payload: unknown): DodoEvent | null {
  if (!isRecord(payload) || typeof payload.type !== 'string' || !isRecord(payload.data)) return null;
  const occurredAt = isoOrNull(payload.timestamp);
  const d = payload.data;
  if (payload.type.startsWith('subscription.')) {
    const data = parseSubscriptionData(d);
    return data ? { kind: 'subscription', type: payload.type, occurredAt, data } : null;
  }
  if (payload.type === 'payment.succeeded' || payload.type === 'payment.failed') {
    const paymentId = strOrNull(d, 'payment_id');
    if (!paymentId) return null;
    const customer = customerOf(d);
    return {
      kind: 'payment',
      type: payload.type,
      occurredAt,
      data: {
        paymentId,
        subscriptionId: strOrNull(d, 'subscription_id'),
        status: strOrNull(d, 'status'),
        totalAmount: intOrNull(d.total_amount),
        tax: intOrNull(d.tax),
        currency: strOrNull(d, 'currency')?.toUpperCase() ?? null,
        customerId: customer.id,
        customerEmail: customer.email,
        metadata: parseMetadata(d.metadata),
      },
    };
  }
  return null;
}

/** Why a payment's money went back: a completed refund, or a chargeback opened or lost. */
export type DodoReversalKind = 'refund' | 'dispute_opened' | 'dispute_lost';

const REVERSAL_EVENTS: Record<string, DodoReversalKind> = {
  'refund.succeeded': 'refund',
  'dispute.opened': 'dispute_opened',
  'dispute.lost': 'dispute_lost',
};

export interface DodoReversalEvent {
  type: string;
  kind: DodoReversalKind;
  /** Refund or dispute id. */
  objectId: string | null;
  /** The charged payment; refunds and disputes carry no subscription id. */
  paymentId: string;
  amount: number | null;
  currency: string | null;
  isPartial: boolean;
}

/** Parses refund.succeeded / dispute.opened / dispute.lost; null for any other event or a missing payment id. */
export function parseDodoReversalEvent(payload: unknown): DodoReversalEvent | null {
  if (!isRecord(payload) || typeof payload.type !== 'string' || !isRecord(payload.data)) return null;
  const kind = REVERSAL_EVENTS[payload.type];
  const d = payload.data;
  const paymentId = strOrNull(d, 'payment_id');
  if (!kind || !paymentId) return null;
  return {
    type: payload.type,
    kind,
    objectId: strOrNull(d, kind === 'refund' ? 'refund_id' : 'dispute_id'),
    paymentId,
    amount: intOrNull(d.amount),
    currency: strOrNull(d, 'currency')?.toUpperCase() ?? null,
    isPartial: d.is_partial === true,
  };
}
