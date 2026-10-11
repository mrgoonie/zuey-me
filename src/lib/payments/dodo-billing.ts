import type { D1DatabaseLike } from '../../db/store';
import {
  queueCardStateChange, queueCardSubscriptionEnd, queueNeedsAttention, queuePaymentFailed, queuePurchase, queueRefund,
} from '../analytics/commerce-events';
import type { WaitUntil } from '../channel-access/invalidate';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { PlanId } from '../members/plans';
import { getPlan, isPlanId } from '../members/plans';
import type { Row } from '../members/runtime';
import { iso, isUniqueViolation, membersRuntime, numOrNull, randomId, siteUrl, str, strOrNull } from '../members/runtime';
import { recomputeSubscription } from '../members/subscriptions';
import { getUserById, insertActivity, logActivity } from '../members/users';
import { normalizeEmailForSelfCheck } from '../referrals/codes';
import { captureReferralCommission } from '../referrals/commissions';
import type { ReversalOutcome } from '../referrals/refunds';
import { reverseCommission } from '../referrals/refunds';
import type { CheckoutReferral } from '../referrals/resolve-checkout-referral';
import type { PromoCode } from '../promos/promo-codes';
import { redeemPromo, releasePromo, reservePromo } from '../promos/promo-redemptions';
import { applyPercent } from '../referrals/rates';
import { allowedSubscriptionAmounts, discountNotApplied, minimumChargeCents } from './dodo-card-referral-pricing';
import type { DodoEvent, DodoMetadata, DodoReversalEvent } from './dodo';
import {
  DodoApiError, cancelDodoSubscription, createDodoCheckout, createDodoDiscount, createDodoPortalLink, dodoProductId, getDodoPaymentSubscriptionId,
  planForDodoProduct, requireDodoPlan,
} from './dodo';

/**
 * Card (Dodo Payments) membership subscriptions. Checkout creates a 'pending' row; afterwards only
 * verified webhooks change it. Entitlements are recomputed from SePay orders plus active card rows.
 */

export type CardStatus = 'pending' | 'active' | 'on_hold' | 'paused' | 'cancelled' | 'failed' | 'expired' | 'needs_attention';
const CARD_STATUSES: CardStatus[] = ['pending', 'active', 'on_hold', 'paused', 'cancelled', 'failed', 'expired', 'needs_attention'];
/** Statuses that block starting a second card subscription for the same plan. */
const LIVE_STATUSES: CardStatus[] = ['active', 'on_hold', 'paused', 'needs_attention'];
/** A checkout nobody completed within a day is shown as expired. */
export const CARD_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PENDING_CARD_CHECKOUTS = 5;
const PENDING_WINDOW_MS = 60 * 60 * 1000;

export interface CardSubscription {
  id: string;
  provider: 'dodo';
  provider_subscription_id: string | null;
  provider_customer_id: string | null;
  user_id: string | null;
  plan: PlanId | null;
  status: CardStatus;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  amount_cents: number | null;
  currency: string | null;
  customer_email: string | null;
  attention_reason: string | null;
  last_event_at: string | null;
  /** Referral snapshot (null without a referral); the discount covers the first charge only. */
  referrer_user_id: string | null;
  referral_discount_percent: number | null;
  /** Promo snapshot (null without a promo; never together with a referral): percent off the first `promo_cycles` charges. */
  promo_code_id: string | null;
  promo_code: string | null;
  promo_discount_percent: number | null;
  promo_cycles: number | null;
  /** Id of the first successful Dodo payment: refunds and disputes are matched to the card through it. */
  first_payment_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CardSubscriptionView {
  id: string;
  provider: 'dodo';
  plan: PlanId | null;
  plan_name: string | null;
  status: CardStatus;
  /** Provider's next billing date: renewal date, or the end of access once cancellation is scheduled. */
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  amount_cents: number | null;
  currency: string | null;
  attention_reason: string | null;
  /** Referral discount on the first charge only (null without a referral). */
  referral_discount_percent: number | null;
  /** Promo code discount and the number of monthly charges it covers (null without a promo). */
  promo_code: string | null;
  promo_discount_percent: number | null;
  promo_cycles: number | null;
  can_manage: boolean;
  can_cancel: boolean;
  created_at: string;
  updated_at: string;
  status_url: string;
}

function toCardStatus(v: unknown): CardStatus {
  return CARD_STATUSES.find(s => s === v) ?? 'needs_attention';
}

function rowToCard(row: Row): CardSubscription {
  const plan = row.plan;
  return {
    id: str(row, 'id'),
    provider: 'dodo',
    provider_subscription_id: strOrNull(row, 'provider_subscription_id'),
    provider_customer_id: strOrNull(row, 'provider_customer_id'),
    user_id: strOrNull(row, 'user_id'),
    plan: isPlanId(plan) ? plan : null,
    status: toCardStatus(row.status),
    current_period_end: strOrNull(row, 'current_period_end'),
    cancel_at_period_end: Number(row.cancel_at_period_end ?? 0) === 1,
    amount_cents: numOrNull(row, 'amount_cents'),
    currency: strOrNull(row, 'currency'),
    customer_email: strOrNull(row, 'customer_email'),
    attention_reason: strOrNull(row, 'attention_reason'),
    last_event_at: strOrNull(row, 'last_event_at'),
    referrer_user_id: strOrNull(row, 'referrer_user_id'),
    referral_discount_percent: numOrNull(row, 'referral_discount_percent'),
    promo_code_id: strOrNull(row, 'promo_code_id'),
    promo_code: strOrNull(row, 'promo_code'),
    promo_discount_percent: numOrNull(row, 'promo_discount_percent'),
    promo_cycles: numOrNull(row, 'promo_cycles'),
    first_payment_id: strOrNull(row, 'first_payment_id'),
    created_at: str(row, 'created_at'),
    updated_at: str(row, 'updated_at'),
  };
}

export function toCardView(card: CardSubscription, env: RuntimeEnv): CardSubscriptionView {
  const stale = card.status === 'pending' && Date.parse(card.created_at) + CARD_PENDING_TTL_MS <= membersRuntime.now();
  const status: CardStatus = stale ? 'expired' : card.status;
  return {
    id: card.id,
    provider: 'dodo',
    plan: card.plan,
    plan_name: card.plan ? getPlan(card.plan).name : null,
    status,
    current_period_end: card.current_period_end,
    cancel_at_period_end: card.cancel_at_period_end,
    amount_cents: card.amount_cents,
    currency: card.currency,
    attention_reason: card.attention_reason,
    referral_discount_percent: card.referrer_user_id ? card.referral_discount_percent : null,
    promo_code: card.promo_code_id ? card.promo_code : null,
    promo_discount_percent: card.promo_code_id ? card.promo_discount_percent : null,
    promo_cycles: card.promo_code_id ? card.promo_cycles : null,
    can_manage: card.provider_customer_id !== null && status !== 'pending',
    can_cancel: card.provider_subscription_id !== null && status === 'active' && !card.cancel_at_period_end,
    created_at: card.created_at,
    updated_at: card.updated_at,
    status_url: `${siteUrl(env)}/billing/card/${card.id}`,
  };
}

async function getCard(d1: D1DatabaseLike, id: string): Promise<CardSubscription | null> {
  const row = await d1.prepare("SELECT * FROM card_subscriptions WHERE id = ? AND provider = 'dodo'").bind(id).first<Row>();
  return row ? rowToCard(row) : null;
}

/** The caller's own card subscription (admins may read any); everything else is a 404. */
export async function getCardFor(d1: D1DatabaseLike, id: string, viewer: { userId: string | null; isAdmin: boolean }): Promise<CardSubscription> {
  const card = await getCard(d1, id);
  if (!card || (!viewer.isAdmin && (card.user_id === null || card.user_id !== viewer.userId))) {
    throw new AppError(404, 'not_found', 'Card subscription not found');
  }
  return card;
}

/** Your card subscriptions, newest first (abandoned checkouts older than a day are omitted). */
export async function listCardSubscriptions(d1: D1DatabaseLike, userId: string): Promise<CardSubscription[]> {
  const cutoff = iso(membersRuntime.now() - CARD_PENDING_TTL_MS);
  const { results } = await d1.prepare(
    `SELECT * FROM card_subscriptions WHERE user_id = ? AND NOT (status = 'pending' AND created_at <= ?)
     ORDER BY created_at DESC LIMIT 50`
  ).bind(userId, cutoff).all<Row>();
  return (results ?? []).map(rowToCard);
}

// ---------------------------------------------------------------------------
// Checkout, portal and cancellation (member actions)
// ---------------------------------------------------------------------------

export interface CardCheckout extends CardSubscriptionView {
  checkout_url: string;
}

/**
 * Starts a monthly card subscription for a plan via a Dodo hosted checkout session. With a referral (first
 * charge) or a promo code (its first `card_cycles` charges), a single-use discount is created at Dodo first and
 * pre-applied to the session; the discount terms are snapshotted on the pending row (`referral_ref` = Dodo
 * discount id). Pass at most one of `referral` and `promo` (the caller picks the larger discount).
 */
export async function startCardCheckout(
  d1: D1DatabaseLike, env: RuntimeEnv, userId: string, plan: PlanId, request?: Request, referral: CheckoutReferral | null = null,
  promo: PromoCode | null = null,
): Promise<CardCheckout> {
  if (promo) referral = null;
  const { productId } = requireDodoPlan(env, plan);
  const user = await getUserById(d1, userId);
  if (!user) throw new AppError(403, 'member_account_required', 'This action requires a member account');

  const live = await d1.prepare(
    `SELECT id FROM card_subscriptions WHERE user_id = ? AND plan = ? AND status IN (${LIVE_STATUSES.map(() => '?').join(', ')}) LIMIT 1`
  ).bind(userId, plan, ...LIVE_STATUSES).first<Row>();
  if (live) {
    throw new AppError(409, 'already_subscribed', 'You already have a card subscription for this plan; manage it from /account', { card_subscription_id: str(live, 'id') });
  }
  const nowMs = membersRuntime.now();
  const recent = await d1.prepare("SELECT COUNT(*) AS n FROM card_subscriptions WHERE user_id = ? AND status = 'pending' AND created_at > ?")
    .bind(userId, iso(nowMs - PENDING_WINDOW_MS)).first<Row>();
  if (Number(recent?.n ?? 0) >= MAX_PENDING_CARD_CHECKOUTS) {
    throw new AppError(429, 'too_many_pending_orders', 'You started several card checkouts recently; finish one or try again later');
  }

  const id = randomId('csub');
  const listCents = getPlan(plan).price_usd_cents;
  const discountPercent = promo ? promo.percent : referral?.discountPercent ?? 0;
  await d1.prepare(
    `INSERT INTO card_subscriptions (id, provider, user_id, plan, status, customer_email, canonical_email, created_at, updated_at,
       referrer_user_id, referral_rate, referral_discount_percent, referral_commission_percent, amount_before_referral,
       promo_code_id, promo_code, promo_discount_percent, promo_cycles)
     VALUES (?, 'dodo', ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, userId, plan, user.email, normalizeEmailForSelfCheck(user.email), iso(nowMs), iso(nowMs),
    referral?.referrerUserId ?? null, referral?.rate ?? null, referral?.discountPercent ?? null, referral?.commissionPercent ?? null,
    referral ? listCents : null, promo?.id ?? null, promo?.code ?? null, promo?.percent ?? null, promo?.card_cycles ?? null).run();
  const expiresAt = iso(nowMs + CARD_PENDING_TTL_MS);
  if (promo) {
    try {
      await reservePromo(d1, {
        promo, kind: 'card_subscription', sourceId: id, sourceCode: null, target: { product: 'membership', plan, userId },
        currency: 'USD', amountBefore: listCents, amountDue: applyPercent(listCents, promo.percent, 'USD'), expiresAt,
      });
    } catch (err) {
      await d1.prepare("DELETE FROM card_subscriptions WHERE id = ? AND status = 'pending'").bind(id).run().catch(() => undefined);
      throw err;
    }
  }
  let session: { sessionId: string; url: string };
  try {
    let discountCodes: string[] | undefined;
    if (discountPercent > 0) {
      const discount = await createDodoDiscount(env, {
        productId,
        percent: discountPercent,
        expiresAt,
        metadata: promo
          ? { promo_code: promo.code, card_ref: id }
          : { referral_order: id, card_ref: id, referrer_user_id: referral?.referrerUserId ?? '' },
        cycles: promo ? promo.card_cycles : 1,
        name: promo ? `Promo ${promo.code} ${promo.percent}%` : undefined,
      }, membersRuntime.fetch);
      await d1.prepare('UPDATE card_subscriptions SET referral_ref = ? WHERE id = ?').bind(discount.discountId, id).run();
      discountCodes = [discount.code];
    }
    session = await createDodoCheckout(env, {
      plan,
      customerEmail: user.email,
      customerName: user.name,
      returnUrl: `${siteUrl(env)}/billing/card/${id}`,
      metadata: { user_id: userId, plan, card_ref: id },
      discountCodes,
    }, membersRuntime.fetch);
  } catch (err) {
    // Nothing was created at Dodo, so the placeholder row has no meaning.
    if (promo) await releasePromo(d1, 'card_subscription', id).catch(() => undefined);
    await d1.prepare("DELETE FROM card_subscriptions WHERE id = ? AND status = 'pending'").bind(id).run().catch(() => undefined);
    throw err;
  }
  await d1.prepare('UPDATE card_subscriptions SET provider_session_id = ?, updated_at = ? WHERE id = ?').bind(session.sessionId, iso(nowMs), id).run();
  await logActivity(d1, userId, 'billing.card_checkout', {
    plan, card_subscription_id: id, referral_discount_percent: referral?.discountPercent ?? null, promo_code: promo?.code ?? null,
  }, request);
  const card = await getCard(d1, id);
  if (!card) throw new AppError(500, 'internal_error', 'Card subscription was not persisted');
  return { ...toCardView(card, env), checkout_url: session.url };
}

/** One-time Dodo customer portal link for managing the card, invoices or cancellation. */
export async function cardPortalLink(d1: D1DatabaseLike, env: RuntimeEnv, userId: string, id: string): Promise<{ url: string }> {
  const card = await getCardFor(d1, id, { userId, isAdmin: false });
  if (!card.provider_customer_id) throw new AppError(409, 'not_manageable', 'This subscription has no Dodo customer yet; wait until payment is confirmed');
  return { url: await createDodoPortalLink(env, card.provider_customer_id, membersRuntime.fetch) };
}

/** Schedules cancellation at the end of the paid period; access continues until then. */
export async function cancelCardSubscription(
  d1: D1DatabaseLike, env: RuntimeEnv, userId: string, id: string, request?: Request
): Promise<CardSubscriptionView> {
  const card = await getCardFor(d1, id, { userId, isAdmin: false });
  if (card.status !== 'active' || !card.provider_subscription_id) {
    throw new AppError(409, 'not_cancellable', 'Only an active card subscription can be cancelled');
  }
  if (!card.cancel_at_period_end) {
    const updated = await cancelDodoSubscription(env, card.provider_subscription_id, membersRuntime.fetch);
    await d1.prepare('UPDATE card_subscriptions SET cancel_at_period_end = 1, current_period_end = COALESCE(?, current_period_end), updated_at = ? WHERE id = ?')
      .bind(updated?.nextBillingDate ?? null, iso(membersRuntime.now()), card.id).run();
    if (card.plan) await recomputeSubscription(d1, userId, card.plan, { env });
    await logActivity(d1, userId, 'billing.card_cancel_scheduled', { plan: card.plan, card_subscription_id: card.id }, request);
    await queueCardSubscriptionEnd(d1, 'subscription_cancel_scheduled', card);
  }
  const fresh = await getCard(d1, card.id);
  if (!fresh) throw new AppError(404, 'not_found', 'Card subscription not found');
  return toCardView(fresh, env);
}

// ---------------------------------------------------------------------------
// Webhook events
// ---------------------------------------------------------------------------

export type CardOutcome =
  | 'duplicate_event' | 'unmatched' | 'ignored' | 'stale_event' | 'needs_attention' | 'activated' | 'deactivated' | 'updated';

const STATUS_FROM_PROVIDER: Record<string, CardStatus> = {
  pending: 'pending', active: 'active', on_hold: 'on_hold', paused: 'paused', cancelled: 'cancelled', failed: 'failed', expired: 'expired',
};

const STATUS_FROM_EVENT: Record<string, CardStatus> = {
  'subscription.active': 'active',
  'subscription.renewed': 'active',
  'subscription.unpaused': 'active',
  'subscription.on_hold': 'on_hold',
  'subscription.paused': 'paused',
  'subscription.cancelled': 'cancelled',
  'subscription.failed': 'failed',
  'subscription.expired': 'expired',
};

/**
 * Dodo always delivers the latest subscription state, so the payload `status` wins over the event
 * name (a delayed `subscription.active` retry can carry `cancelled`). Unknown events change nothing.
 */
function nextStatus(event: DodoEvent & { kind: 'subscription' }): CardStatus | null {
  const fromPayload = event.data.status ? STATUS_FROM_PROVIDER[event.data.status] : undefined;
  if (fromPayload) return fromPayload;
  return STATUS_FROM_EVENT[event.type] ?? null;
}

async function locateCard(d1: D1DatabaseLike, subscriptionId: string | null, meta: DodoMetadata): Promise<{ card: CardSubscription | null; via: 'subscription' | 'metadata' | null }> {
  if (subscriptionId) {
    const row = await d1.prepare("SELECT * FROM card_subscriptions WHERE provider = 'dodo' AND provider_subscription_id = ?").bind(subscriptionId).first<Row>();
    if (row) return { card: rowToCard(row), via: 'subscription' };
  }
  if (meta.cardRef) {
    const card = await getCard(d1, meta.cardRef);
    if (card && (card.provider_subscription_id === null || card.provider_subscription_id === subscriptionId)) return { card, via: 'metadata' };
  }
  return { card: null, via: null };
}

function metadataMatches(card: CardSubscription, meta: DodoMetadata): boolean {
  return meta.userId === card.user_id && meta.plan === card.plan;
}

/**
 * Price check for a plan: the configured product, USD, and the recurring amount at list price (or, on a
 * referral card's first activation, the snapshotted discounted first-cycle price, in case Dodo reports it).
 */
function subscriptionMismatch(
  env: RuntimeEnv, card: CardSubscription, plan: PlanId, productId: string | null, amountCents: number | null, currency: string | null, paidCharges: number,
): string | null {
  if (productId !== dodoProductId(env, plan)) return 'product_mismatch';
  // A row still `pending` has never been activated, so this event is the first cycle; a promo covers several.
  const cycle = card.status === 'pending' ? 1 : card.promo_code_id ? Math.max(1, paidCharges) : 2;
  const allowed = allowedSubscriptionAmounts(card, plan, cycle);
  if (amountCents === null || !allowed.has(amountCents) || currency !== 'USD') return 'amount_mismatch';
  return null;
}

/**
 * Besides one row per webhook id, `payment_events` holds prefixed rows keyed by the business fact: a collected
 * Dodo charge (`charge:<payment id>`, raw type `payment.charge`) and a refund/dispute (`<event type>:<id>`).
 */
const CHARGE_RAW_TYPE = 'payment.charge';
const chargeKey = (paymentId: string): string => `charge:${paymentId}`;

async function recordEvent(d1: D1DatabaseLike, eventId: string, cardId: string | null, amount: number | null, currency: string | null, rawType: string): Promise<boolean> {
  try {
    await d1.prepare(
      'INSERT INTO payment_events (provider, event_id, booking_id, card_subscription_id, amount, currency, raw_type, received_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)'
    ).bind('dodo', eventId, cardId, amount, currency, rawType, iso(membersRuntime.now())).run();
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

async function flagUnmatched(d1: D1DatabaseLike, env: RuntimeEnv, event: DodoEvent, subscriptionId: string): Promise<void> {
  const nowIso = iso(membersRuntime.now());
  const productPlan = event.kind === 'subscription' ? planForDodoProduct(env, event.data.productId) : null;
  try {
    await d1.prepare(
      `INSERT INTO card_subscriptions (id, provider, provider_subscription_id, provider_customer_id, user_id, plan, status, customer_email,
         canonical_email, attention_reason, last_event_at, created_at, updated_at)
       VALUES (?, 'dodo', ?, ?, NULL, ?, 'needs_attention', ?, ?, 'metadata_missing', ?, ?, ?)`
    ).bind(randomId('csub'), subscriptionId, event.data.customerId, productPlan, event.data.customerEmail,
      normalizeEmailForSelfCheck(event.data.customerEmail), event.occurredAt, nowIso, nowIso).run();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  console.warn(`dodo ${event.type} for ${subscriptionId} could not be matched to a member (metadata missing); flagged for the admin`);
}

/**
 * A `payment.succeeded` webhook row is written a moment before the `charge:` row of the same delivery. Webhook rows
 * older than a card's first charge row by more than this are charges collected before charge rows existed.
 */
const LEGACY_CHARGE_GAP_MS = 60 * 1000;

/**
 * Distinct Dodo payments collected on a card. Each `charge:<payment id>` row is one payment, however many webhook
 * ids delivered it. Charges collected before charge rows were written have only their webhook row (the payload is not
 * stored), so those are counted one per webhook row: every webhook row when the card has no charge row yet, otherwise
 * the ones received before its first charge row.
 */
async function succeededCharges(d1: D1DatabaseLike, cardId: string): Promise<number> {
  const charges = await d1.prepare(
    "SELECT COUNT(*) AS n, MIN(received_at) AS first_at FROM payment_events WHERE provider = 'dodo' AND card_subscription_id = ? AND raw_type = ?"
  ).bind(cardId, CHARGE_RAW_TYPE).first<Row>();
  const firstAt = strOrNull(charges ?? {}, 'first_at');
  const cutoff = firstAt ? iso(Date.parse(firstAt) - LEGACY_CHARGE_GAP_MS) : null;
  const legacy = await d1.prepare(
    "SELECT COUNT(*) AS n FROM payment_events WHERE provider = 'dodo' AND card_subscription_id = ? AND raw_type = 'payment.succeeded' AND (? IS NULL OR received_at < ?)"
  ).bind(cardId, cutoff, cutoff).first<Row>();
  return Number(charges?.n ?? 0) + Number(legacy?.n ?? 0);
}

async function applySubscriptionEvent(
  d1: D1DatabaseLike, env: RuntimeEnv, card: CardSubscription, event: DodoEvent & { kind: 'subscription' }, identityOk: boolean,
  waitUntil?: WaitUntil,
): Promise<CardOutcome> {
  if (card.last_event_at && event.occurredAt && event.occurredAt < card.last_event_at) return 'stale_event';
  const data = event.data;
  const target = nextStatus(event) ?? card.status;
  let status: CardStatus = target;
  let reason: string | null = card.attention_reason;
  if (!identityOk || card.user_id === null || card.plan === null) {
    status = 'needs_attention';
    reason = card.user_id === null ? (reason ?? 'metadata_missing') : 'metadata_mismatch';
  } else if (target === 'active') {
    const mismatch = subscriptionMismatch(env, card, card.plan, data.productId, data.amountCents, data.currency, await succeededCharges(d1, card.id));
    if (mismatch) {
      status = 'needs_attention';
      reason = mismatch;
    } else if (card.status === 'needs_attention') {
      // A flagged subscription stays blocked until the admin has looked at it.
      status = 'needs_attention';
    } else {
      reason = null;
    }
  }
  const nowIso = iso(membersRuntime.now());
  await d1.prepare(
    `UPDATE card_subscriptions SET status = ?, provider_subscription_id = COALESCE(provider_subscription_id, ?),
       provider_customer_id = COALESCE(?, provider_customer_id), current_period_end = COALESCE(?, current_period_end),
       cancel_at_period_end = ?, amount_cents = COALESCE(?, amount_cents), currency = COALESCE(?, currency),
       customer_email = COALESCE(?, customer_email), canonical_email = CASE WHEN ? IS NULL THEN canonical_email ELSE ? END,
       attention_reason = ?, last_event_at = COALESCE(?, last_event_at), updated_at = ?
     WHERE id = ?`
  ).bind(
    status, data.subscriptionId, data.customerId, data.nextBillingDate, data.cancelAtPeriodEnd ? 1 : 0, data.amountCents, data.currency,
    data.customerEmail, data.customerEmail, normalizeEmailForSelfCheck(data.customerEmail), reason, event.occurredAt, nowIso, card.id
  ).run();
  await queueCardStateChange(d1, card, { status, cancelAtPeriodEnd: data.cancelAtPeriodEnd, reason }, event.occurredAt);

  if (card.user_id && card.plan) {
    const sub = await recomputeSubscription(d1, card.user_id, card.plan, { env, waitUntil });
    if (status !== card.status || event.type === 'subscription.renewed') {
      const action = status === 'needs_attention' ? 'billing.needs_attention'
        : status === 'active' ? (event.type === 'subscription.renewed' && card.status === 'active' ? 'billing.card_renewed' : 'billing.card_active')
          : 'billing.card_ended';
      await logActivity(d1, card.user_id, action, {
        plan: card.plan, card_subscription_id: card.id, status, reason, period_end: sub?.current_period_end ?? null,
      });
    }
  }
  if (status === 'needs_attention') return 'needs_attention';
  if (status === 'active') return card.status === 'active' ? 'updated' : 'activated';
  return card.status === 'active' ? 'deactivated' : 'updated';
}

async function applyPaymentEvent(
  d1: D1DatabaseLike, env: RuntimeEnv, card: CardSubscription, event: DodoEvent & { kind: 'payment' }, identityOk: boolean,
  waitUntil?: WaitUntil,
): Promise<CardOutcome> {
  const data = event.data;
  const nowIso = iso(membersRuntime.now());
  const succeeded = event.type === 'payment.succeeded';
  // Refunds and disputes name only the payment: remember which card every collected charge belongs to.
  if (succeeded) await recordEvent(d1, chargeKey(data.paymentId), card.id, data.totalAmount, data.currency, CHARGE_RAW_TYPE);
  // The first successful charge is stored with its amount and tax, so a failed commission capture can be retried.
  const first = succeeded ? [data.paymentId, data.totalAmount, data.tax ?? 0, event.occurredAt ?? nowIso] : [null, null, null, null];
  await d1.prepare(
    `UPDATE card_subscriptions SET provider_subscription_id = COALESCE(provider_subscription_id, ?),
       provider_customer_id = COALESCE(provider_customer_id, ?),
       first_payment_cents = CASE WHEN first_payment_id IS NULL THEN ? ELSE first_payment_cents END,
       first_payment_tax_cents = CASE WHEN first_payment_id IS NULL THEN ? ELSE first_payment_tax_cents END,
       first_payment_at = CASE WHEN first_payment_id IS NULL THEN ? ELSE first_payment_at END,
       first_payment_id = COALESCE(first_payment_id, ?), updated_at = ? WHERE id = ?`
  ).bind(data.subscriptionId, data.customerId, first[1], first[2], first[3], first[0], nowIso, card.id).run();
  const isFirstPayment = succeeded && (card.first_payment_id ?? data.paymentId) === data.paymentId;
  // Which charge this is (1 = first): decides whether a promo still covers it. The event is already recorded.
  const cycle = isFirstPayment ? 1 : Math.max(2, await succeededCharges(d1, card.id));
  const analytics = {
    distinctId: card.user_id ?? '', provider: 'dodo', orderType: 'membership', plan: card.plan,
    amountMinor: data.totalAmount, currency: data.currency, occurredAt: event.occurredAt,
  } as const;
  // Every collected charge (first or renewal) is its own transaction, keyed by the Dodo payment id. A charge held
  // for review was still collected, so it counts as revenue with `flagged: true`.
  const queueCharge = async (flagged: boolean): Promise<void> => {
    if (!succeeded || !card.user_id || data.totalAmount === null || !data.currency) return;
    await queuePurchase(d1, {
      ...analytics, transactionId: data.paymentId, amountMinor: data.totalAmount, currency: data.currency,
      renewal: !isFirstPayment, months: 1, flagged,
    });
  };

  let reason: string | null = null;
  if (!identityOk || card.user_id === null || card.plan === null) reason = card.user_id === null ? 'metadata_missing' : 'metadata_mismatch';
  else if (succeeded && (data.currency !== 'USD' || data.totalAmount === null || data.totalAmount < minimumChargeCents(card, card.plan, cycle))) {
    // `total_amount` includes tax, so it is never below the price owed: discounted while a discount covers the charge, list price after.
    reason = 'amount_mismatch';
  }
  if (reason) {
    await d1.prepare("UPDATE card_subscriptions SET status = 'needs_attention', attention_reason = ?, updated_at = ? WHERE id = ?").bind(reason, nowIso, card.id).run();
    if (card.user_id && card.plan) {
      await recomputeSubscription(d1, card.user_id, card.plan, { env, waitUntil });
      await logActivity(d1, card.user_id, 'billing.needs_attention', { plan: card.plan, card_subscription_id: card.id, reason, amount: data.totalAmount, currency: data.currency });
    }
    if (card.user_id) await queueNeedsAttention(d1, { ...analytics, reference: data.paymentId, reason });
    await queueCharge(true);
    return 'needs_attention';
  }
  if (event.type === 'payment.failed' && card.user_id) await queuePaymentFailed(d1, { ...analytics, reference: data.paymentId });
  if (event.type === 'payment.failed' && card.status === 'pending') {
    // The first charge failed: no subscription starts. Renewal failures arrive as subscription.on_hold.
    await d1.prepare("UPDATE card_subscriptions SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'").bind(nowIso, card.id).run();
    if (card.promo_code_id) await releasePromo(d1, 'card_subscription', card.id);
    if (card.user_id) await logActivity(d1, card.user_id, 'billing.card_ended', { plan: card.plan, card_subscription_id: card.id, status: 'failed' });
    return 'deactivated';
  }
  if (isFirstPayment && (card.referrer_user_id || card.promo_code_id) && data.totalAmount !== null) {
    const collected = data.totalAmount - (data.tax ?? 0);
    // Commission is on the amount collected, as for any referred charge.
    if (card.referrer_user_id) await captureReferralCommission(d1, env, { kind: 'card_subscription', id: card.id, paymentId: data.paymentId, collectedCents: collected });
    if (card.promo_code_id) await redeemPromo(d1, 'card_subscription', card.id, collected);
    if (card.plan && discountNotApplied(card, card.plan, collected, 1)) {
      // Dodo ignored the pre-applied discount: flag it so the admin refunds the difference.
      const reasonText = card.promo_code_id ? 'promo_discount_not_applied' : 'referral_discount_not_applied';
      await d1.prepare("UPDATE card_subscriptions SET status = 'needs_attention', attention_reason = ?, updated_at = ? WHERE id = ?").bind(reasonText, nowIso, card.id).run();
      if (card.user_id) {
        await recomputeSubscription(d1, card.user_id, card.plan, { env, waitUntil });
        await logActivity(d1, card.user_id, 'billing.needs_attention', {
          plan: card.plan, card_subscription_id: card.id, reason: reasonText, amount: data.totalAmount, tax: data.tax ?? 0, currency: data.currency,
        });
        await queueNeedsAttention(d1, { ...analytics, reference: data.paymentId, reason: reasonText });
      }
      await queueCharge(true);
      return 'needs_attention';
    }
  }
  await queueCharge(false);
  return 'updated';
}

/**
 * Applies a verified Dodo webhook. The webhook id is recorded first (idempotency gate shared with the
 * other rails); on any processing error the record is released so Dodo's retry is processed again.
 */
export async function applyDodoEvent(
  d1: D1DatabaseLike, env: RuntimeEnv, eventId: string, event: DodoEvent, waitUntil?: WaitUntil,
): Promise<{ outcome: CardOutcome; card_subscription_id: string | null }> {
  const subscriptionId = event.data.subscriptionId;
  const { card, via } = await locateCard(d1, subscriptionId, event.data.metadata);
  const amount = event.kind === 'subscription' ? event.data.amountCents : event.data.totalAmount;
  if (!(await recordEvent(d1, eventId, card?.id ?? null, amount, event.data.currency, event.type))) {
    return { outcome: 'duplicate_event', card_subscription_id: card?.id ?? null };
  }
  try {
    if (!card) {
      if (!subscriptionId) return { outcome: 'unmatched', card_subscription_id: null };
      await flagUnmatched(d1, env, event, subscriptionId);
      return { outcome: 'needs_attention', card_subscription_id: null };
    }
    const identityOk = via === 'subscription' || metadataMatches(card, event.data.metadata);
    const outcome = event.kind === 'subscription'
      ? await applySubscriptionEvent(d1, env, card, event, identityOk, waitUntil)
      : await applyPaymentEvent(d1, env, card, event, identityOk, waitUntil);
    return { outcome, card_subscription_id: card.id };
  } catch (err) {
    await d1.prepare('DELETE FROM payment_events WHERE provider = ? AND event_id = ?').bind('dodo', eventId).run().catch(() => undefined);
    throw err;
  }
}

/** The card a Dodo payment was charged to: the first payment, or any later charge recorded by `applyPaymentEvent`. */
async function cardForPayment(d1: D1DatabaseLike, paymentId: string): Promise<Row | null> {
  const first = await d1.prepare("SELECT id, user_id, plan, first_payment_id FROM card_subscriptions WHERE provider = 'dodo' AND first_payment_id = ?")
    .bind(paymentId).first<Row>();
  if (first) return first;
  return d1.prepare(
    `SELECT c.id, c.user_id, c.plan, c.first_payment_id FROM payment_events e JOIN card_subscriptions c ON c.id = e.card_subscription_id
     WHERE e.provider = 'dodo' AND e.event_id = ? AND c.provider = 'dodo'`
  ).bind(chargeKey(paymentId)).first<Row>();
}

/**
 * The card of a payment with no recorded charge, through Dodo's payment lookup; null when the lookup cannot run (no API
 * key), Dodo rejects it (4xx, such as an unknown payment) or it matches no card. A network error, timeout or Dodo 5xx
 * propagates as 502 so Dodo redelivers the reversal; nothing has been written yet.
 */
async function cardFromDodoLookup(d1: D1DatabaseLike, env: RuntimeEnv, paymentId: string): Promise<Row | null> {
  if (!env.DODO_API_KEY) {
    console.warn('dodo reversal: payment lookup skipped (missing DODO_API_KEY); ignored');
    return null;
  }
  let subscriptionId: string | null;
  try {
    subscriptionId = await getDodoPaymentSubscriptionId(env, paymentId, membersRuntime.fetch);
  } catch (err) {
    const status = err instanceof DodoApiError ? err.upstreamStatus : null;
    if (!(err instanceof DodoApiError) || status === null || status < 400 || status >= 500) throw err;
    console.warn(`dodo reversal: payment lookup rejected (${err.message}); ignored`);
    return null;
  }
  if (!subscriptionId) return null;
  const row = await d1.prepare("SELECT id, user_id, plan, first_payment_id FROM card_subscriptions WHERE provider = 'dodo' AND provider_subscription_id = ?")
    .bind(subscriptionId).first<Row>();
  if (row && strOrNull(row, 'first_payment_id') === null) {
    // The reversal may be of the first payment, whose referral commission is captured when it is recorded.
    throw new AppError(409, 'payment_not_recorded', 'The reversed payment is not recorded yet; retry after its payment.succeeded webhook', { payment_id: paymentId });
  }
  return row;
}

/**
 * Refund or chargeback on a Dodo payment of a card subscription, first charge or renewal. Only the first
 * payment carries a referral commission, so only its reversal reverses the commission (idempotently); a
 * renewal reports `renewal`. Access is not changed for either: the admin reviews the logged reversal.
 * The activity log entry and the `refund` analytics event are written once per refund/dispute: a
 * `payment_events` row keyed by the refund or dispute id gates them across webhook retries.
 *
 * A payment with no recorded charge (a reversal that beats its `payment.succeeded`, or a renewal charged before
 * charge rows existed) is looked up at Dodo (`GET /payments/{id}`, with `env`). If it charged a card subscription that
 * already has a first payment, it is that card's renewal and is applied now. If the card has no first payment yet,
 * this throws a 409 so Dodo redelivers the reversal after the charge is recorded (Dodo's 8 attempts span about 28
 * hours). A lookup Dodo rejects (4xx), one that cannot run (no API key) or a payment of no card here is `ignored`; a lookup that
 * fails on a network error, timeout or Dodo 5xx answers 502 so Dodo redelivers the reversal.
 */
export async function applyDodoReversal(
  d1: D1DatabaseLike, event: DodoReversalEvent, env?: RuntimeEnv,
): Promise<{ outcome: ReversalOutcome | 'renewal' | 'ignored'; card_subscription_id: string | null }> {
  const row = (await cardForPayment(d1, event.paymentId)) ?? (env ? await cardFromDodoLookup(d1, env, event.paymentId) : null);
  if (!row) return { outcome: 'ignored', card_subscription_id: null };
  const cardId = str(row, 'id');
  const renewal = strOrNull(row, 'first_payment_id') !== event.paymentId;
  const outcome = renewal ? 'renewal' : (await reverseCommission(d1, { sourceKind: 'card_subscription', sourceId: cardId }, event.kind)).outcome;
  const userId = strOrNull(row, 'user_id');
  const reversalKey = `${event.type}:${event.objectId ?? event.paymentId}`;
  if (!userId || !(await recordEvent(d1, reversalKey, cardId, event.amount, event.currency, event.type))) {
    return { outcome, card_subscription_id: cardId };
  }
  try {
    // The analytics event is deduped by its key, so it goes first; the activity log is the last write and throws on
    // failure, which releases the gate with nothing logged, so the retry writes it once.
    // An opened dispute may still be won; only money that actually went back is a refund.
    if (event.kind !== 'dispute_opened') {
      await queueRefund(d1, {
        distinctId: userId, provider: 'dodo', orderType: 'membership', reference: `${event.kind}:${event.objectId ?? event.paymentId}`,
        reason: event.kind === 'refund' ? 'refund' : 'chargeback', amountMinor: event.amount, currency: event.currency, partial: event.isPartial, plan: strOrNull(row, 'plan'),
      });
    }
    await insertActivity(d1, userId, 'billing.card_reversal', {
      card_subscription_id: cardId, kind: event.kind, payment_id: event.paymentId, amount: event.amount, currency: event.currency, partial: event.isPartial, renewal,
    });
  } catch (err) {
    await d1.prepare('DELETE FROM payment_events WHERE provider = ? AND event_id = ?').bind('dodo', reversalKey).run().catch(() => undefined);
    throw err;
  }
  return { outcome, card_subscription_id: cardId };
}
