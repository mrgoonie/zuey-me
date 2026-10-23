/**
 * Builders for the server business events (taxonomy `source: 'server'`). Payment and account flows call
 * these right after a verified state change; each builds the property bag and the dedupe key, then
 * queues the event in the outbox. All of them resolve to an outcome and never throw, so analytics can
 * never break a payment, a webhook or a sign-in.
 *
 * Amounts keep the currency the money was paid in (no conversion) and are expressed in major units:
 * VND as-is, USD cents divided by 100.
 */
import type { D1DatabaseLike } from '../../db/store';
import { GUEST_ID_PREFIX } from './identity';
import type { EnqueueOutcome } from './outbox';
import { enqueueServerEvent, subscriptionExpiredKey } from './outbox';

export type CommerceProvider = 'sepay' | 'dodo' | 'paypal';
export type OrderType = 'membership' | 'course' | 'booking';

/** Currencies without a minor unit (amounts already in major units). */
const ZERO_DECIMAL = new Set(['VND', 'JPY', 'KRW']);
const CURRENCY_RE = /^[A-Z]{3}$/;

export function normaliseCurrency(currency: string | null | undefined): string | null {
  const c = currency?.trim().toUpperCase() ?? '';
  return CURRENCY_RE.test(c) ? c : null;
}

/** Provider amount in its smallest unit → major units of the same currency (VND 199000 → 199000, USD 999 → 9.99). */
export function toMajorUnits(amountMinor: number, currency: string): number {
  return ZERO_DECIMAL.has(currency) ? amountMinor : Math.round(amountMinor) / 100;
}

/** Optional amount and currency props; both are left out unless both are known. */
function money(amountMinor: number | null | undefined, currency: string | null | undefined): { amount?: number; currency?: string } {
  const c = normaliseCurrency(currency);
  if (c === null || typeof amountMinor !== 'number' || !Number.isFinite(amountMinor)) return {};
  return { amount: toMajorUnits(amountMinor, c), currency: c };
}

async function sha256Hex(value: string, bytes: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest).slice(0, bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Opaque, stable distinct id for a guest without a member account (bookings), derived from the record id. */
export async function guestDistinctId(recordId: string): Promise<string> {
  return `${GUEST_ID_PREFIX}${await sha256Hex(`guest:${recordId}`, 12)}`;
}

/**
 * Opaque ecommerce `transaction_id` of a provider transaction (`tx_` + 24 hex of SHA-256): the raw id or order
 * code never leaves the app, while a refund of the same transaction derives the same value.
 */
export async function ecommerceTransactionId(provider: CommerceProvider, transactionId: string): Promise<string> {
  return `tx_${await sha256Hex(`${provider}:${transactionId}`, 12)}`;
}

export interface PurchaseInput {
  distinctId: string;
  provider: CommerceProvider;
  orderType: OrderType;
  /** Provider transaction (payment, capture) or our order id when one order is paid by exactly one transaction. */
  transactionId: string;
  /** In the currency's smallest unit (VND, USD cents). */
  amountMinor: number;
  currency: string;
  renewal?: boolean;
  plan?: string | null;
  months?: number | null;
  /** The money was collected but the charge is held for admin review. */
  flagged?: boolean;
  occurredAt?: string | null;
}

/** One `purchase` per verified transaction. Zero-amount grants (100% promo codes) are not purchases. */
export async function queuePurchase(d1: D1DatabaseLike, p: PurchaseInput): Promise<EnqueueOutcome> {
  const currency = normaliseCurrency(p.currency);
  if (currency === null || !Number.isFinite(p.amountMinor) || p.amountMinor <= 0) return 'rejected';
  return enqueueServerEvent(d1, {
    event: 'purchase',
    distinctId: p.distinctId,
    dedupeKey: `purchase:${p.provider}:${p.transactionId}`,
    properties: {
      provider: p.provider, order_type: p.orderType, amount: toMajorUnits(p.amountMinor, currency), currency,
      renewal: p.renewal ?? false,
      ...(p.plan ? { plan: p.plan } : {}),
      ...(typeof p.months === 'number' ? { months: p.months } : {}),
      ...(p.flagged ? { flagged: true } : {}),
      transaction_id: await ecommerceTransactionId(p.provider, p.transactionId),
    },
    occurredAt: p.occurredAt,
  });
}

export interface PaymentIssueInput {
  distinctId: string;
  provider: CommerceProvider;
  orderType: OrderType;
  /** Provider event, payment or refund id that identifies this occurrence. */
  reference: string;
  amountMinor?: number | null;
  currency?: string | null;
  plan?: string | null;
  occurredAt?: string | null;
}

export async function queueNeedsAttention(d1: D1DatabaseLike, p: PaymentIssueInput & { reason: string }): Promise<EnqueueOutcome> {
  return enqueueServerEvent(d1, {
    event: 'payment_needs_attention',
    distinctId: p.distinctId,
    dedupeKey: `payment_needs_attention:${p.provider}:${p.reference}`,
    properties: {
      provider: p.provider, order_type: p.orderType, reason: p.reason, ...money(p.amountMinor, p.currency), ...(p.plan ? { plan: p.plan } : {}),
    },
    occurredAt: p.occurredAt,
  });
}

export async function queuePaymentFailed(d1: D1DatabaseLike, p: PaymentIssueInput): Promise<EnqueueOutcome> {
  return enqueueServerEvent(d1, {
    event: 'payment_failed',
    distinctId: p.distinctId,
    dedupeKey: `payment_failed:${p.provider}:${p.reference}`,
    properties: { provider: p.provider, order_type: p.orderType, ...money(p.amountMinor, p.currency), ...(p.plan ? { plan: p.plan } : {}) },
    occurredAt: p.occurredAt,
  });
}

export async function queueRefund(
  d1: D1DatabaseLike,
  p: PaymentIssueInput & {
    reason: string; partial?: boolean;
    /** The refunded purchase's `transactionId` (as given to `queuePurchase`), when known. */
    purchaseTransactionId?: string | null;
  },
): Promise<EnqueueOutcome> {
  return enqueueServerEvent(d1, {
    event: 'refund',
    distinctId: p.distinctId,
    dedupeKey: `refund:${p.provider}:${p.reference}`,
    properties: {
      provider: p.provider, order_type: p.orderType, reason: p.reason, ...money(p.amountMinor, p.currency),
      ...(typeof p.partial === 'boolean' ? { partial: p.partial } : {}), ...(p.plan ? { plan: p.plan } : {}),
      ...(p.purchaseTransactionId ? { transaction_id: await ecommerceTransactionId(p.provider, p.purchaseTransactionId) } : {}),
    },
    occurredAt: p.occurredAt,
  });
}

/** `subscription_cancel_scheduled` / `subscription_cancelled` of a card subscription: once per card. */
export async function queueCardSubscriptionEnd(
  d1: D1DatabaseLike, event: 'subscription_cancel_scheduled' | 'subscription_cancelled',
  card: { id: string; user_id: string | null; plan: string | null }, occurredAt?: string | null,
): Promise<EnqueueOutcome> {
  if (!card.user_id || !card.plan) return 'rejected';
  return enqueueServerEvent(d1, {
    event,
    distinctId: card.user_id,
    dedupeKey: `${event}:dodo:${card.id}`,
    properties: { plan: card.plan, provider: 'dodo' },
    occurredAt,
  });
}

/**
 * Events of a card subscription status change applied from a verified Dodo webhook: cancellation
 * scheduled, cancelled, or flagged for the admin (once per card and reason).
 */
export async function queueCardStateChange(
  d1: D1DatabaseLike,
  before: { id: string; user_id: string | null; plan: string | null; status: string; cancel_at_period_end: boolean },
  after: { status: string; cancelAtPeriodEnd: boolean; reason: string | null },
  occurredAt?: string | null,
): Promise<void> {
  if (after.status === 'needs_attention' && before.status !== 'needs_attention' && before.user_id) {
    await queueNeedsAttention(d1, {
      distinctId: before.user_id, provider: 'dodo', orderType: 'membership', reference: `card:${before.id}:${after.reason ?? 'unknown'}`,
      reason: after.reason ?? 'unknown', plan: before.plan, occurredAt,
    });
  }
  if (after.status === 'cancelled' && before.status !== 'cancelled') {
    await queueCardSubscriptionEnd(d1, 'subscription_cancelled', before, occurredAt);
  }
  if (after.status === 'active' && after.cancelAtPeriodEnd && !before.cancel_at_period_end) {
    await queueCardSubscriptionEnd(d1, 'subscription_cancel_scheduled', before, occurredAt);
  }
}

/** Moving the access end forward by less than this (e.g. the card renewal grace toggling) is not a renewal. */
export const RENEWAL_MIN_EXTENSION_MS = 7 * 24 * 60 * 60 * 1000;

export interface SubscriptionChange {
  userId: string;
  plan: string;
  /** Active by status and clock before the recompute. */
  wasActive: boolean;
  /** Access end before the recompute (epoch ms; 0 without a row). */
  previousEndMs: number;
  /** State after the recompute; null when the member has no row for the plan. */
  after: { status: 'active' | 'expired'; current_period_end: string } | null;
  /** Rail that grants the (new) access end. */
  provider: 'sepay' | 'dodo';
}

/**
 * Lifecycle events derived from a subscription recompute: activated (no access → access), renewed (access
 * end moved forward), expired (access → none). Keys include the resulting period end, so recomputing the
 * same state again queues nothing.
 */
export async function queueSubscriptionChange(d1: D1DatabaseLike, c: SubscriptionChange): Promise<EnqueueOutcome | null> {
  const after = c.after;
  if (!after) return null;
  const end = after.current_period_end;
  const nowActive = after.status === 'active';
  if (nowActive && !c.wasActive) {
    return enqueueServerEvent(d1, {
      event: 'subscription_activated', distinctId: c.userId,
      dedupeKey: `subscription_activated:${c.userId}:${c.plan}:${end}`,
      properties: { plan: c.plan, provider: c.provider, period_end: end },
    });
  }
  if (nowActive && Date.parse(end) - c.previousEndMs >= RENEWAL_MIN_EXTENSION_MS) {
    return enqueueServerEvent(d1, {
      event: 'subscription_renewed', distinctId: c.userId,
      dedupeKey: `subscription_renewed:${c.userId}:${c.plan}:${end}`,
      properties: { plan: c.plan, provider: c.provider, period_end: end },
    });
  }
  if (!nowActive && c.wasActive) {
    return enqueueServerEvent(d1, {
      event: 'subscription_expired', distinctId: c.userId,
      dedupeKey: subscriptionExpiredKey(c.userId, c.plan, end),
      properties: { plan: c.plan, period_end: end },
      occurredAt: end,
    });
  }
  return null;
}

/**
 * Server-side `sign_up` (account created, once per member) or `login` (once per session) after a
 * verified sign-in.
 */
export async function queueAuthEvent(
  d1: D1DatabaseLike, p: { userId: string; created: boolean; method: string; sessionId: string },
): Promise<EnqueueOutcome> {
  return p.created
    ? enqueueServerEvent(d1, { event: 'sign_up', distinctId: p.userId, dedupeKey: `sign_up:${p.userId}`, properties: { method: p.method } })
    : enqueueServerEvent(d1, { event: 'login', distinctId: p.userId, dedupeKey: `login:${p.sessionId}`, properties: { method: p.method } });
}
