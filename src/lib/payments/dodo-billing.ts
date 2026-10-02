import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { PlanId } from '../members/plans';
import { getPlan, isPlanId } from '../members/plans';
import type { Row } from '../members/runtime';
import { iso, isUniqueViolation, membersRuntime, numOrNull, randomId, siteUrl, str, strOrNull } from '../members/runtime';
import { recomputeSubscription } from '../members/subscriptions';
import { getUserById, logActivity } from '../members/users';
import type { DodoEvent, DodoMetadata } from './dodo';
import {
  cancelDodoSubscription, createDodoCheckout, createDodoPortalLink, dodoProductId, planForDodoProduct, requireDodoPlan,
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

/** Starts a monthly card subscription for a plan via a Dodo hosted checkout session. */
export async function startCardCheckout(
  d1: D1DatabaseLike, env: RuntimeEnv, userId: string, plan: PlanId, request?: Request
): Promise<CardCheckout> {
  requireDodoPlan(env, plan);
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
  await d1.prepare(
    `INSERT INTO card_subscriptions (id, provider, user_id, plan, status, customer_email, created_at, updated_at)
     VALUES (?, 'dodo', ?, ?, 'pending', ?, ?, ?)`
  ).bind(id, userId, plan, user.email, iso(nowMs), iso(nowMs)).run();
  let session: { sessionId: string; url: string };
  try {
    session = await createDodoCheckout(env, {
      plan,
      customerEmail: user.email,
      customerName: user.name,
      returnUrl: `${siteUrl(env)}/billing/card/${id}`,
      metadata: { user_id: userId, plan, card_ref: id },
    }, membersRuntime.fetch);
  } catch (err) {
    // Nothing was created at Dodo, so the placeholder row has no meaning.
    await d1.prepare("DELETE FROM card_subscriptions WHERE id = ? AND status = 'pending'").bind(id).run().catch(() => undefined);
    throw err;
  }
  await d1.prepare('UPDATE card_subscriptions SET provider_session_id = ?, updated_at = ? WHERE id = ?').bind(session.sessionId, iso(nowMs), id).run();
  await logActivity(d1, userId, 'billing.card_checkout', { plan, card_subscription_id: id }, request);
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
    if (card.plan) await recomputeSubscription(d1, userId, card.plan);
    await logActivity(d1, userId, 'billing.card_cancel_scheduled', { plan: card.plan, card_subscription_id: card.id }, request);
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

/** Price check for a plan: the configured product, the list price and USD. */
function subscriptionMismatch(env: RuntimeEnv, plan: PlanId, productId: string | null, amountCents: number | null, currency: string | null): string | null {
  if (productId !== dodoProductId(env, plan)) return 'product_mismatch';
  if (amountCents !== getPlan(plan).price_usd_cents || currency !== 'USD') return 'amount_mismatch';
  return null;
}

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
         attention_reason, last_event_at, created_at, updated_at)
       VALUES (?, 'dodo', ?, ?, NULL, ?, 'needs_attention', ?, 'metadata_missing', ?, ?, ?)`
    ).bind(randomId('csub'), subscriptionId, event.data.customerId, productPlan, event.data.customerEmail, event.occurredAt, nowIso, nowIso).run();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  console.warn(`dodo ${event.type} for ${subscriptionId} could not be matched to a member (metadata missing); flagged for the admin`);
}

async function applySubscriptionEvent(
  d1: D1DatabaseLike, env: RuntimeEnv, card: CardSubscription, event: DodoEvent & { kind: 'subscription' }, identityOk: boolean
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
    const mismatch = subscriptionMismatch(env, card.plan, data.productId, data.amountCents, data.currency);
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
       customer_email = COALESCE(?, customer_email), attention_reason = ?, last_event_at = COALESCE(?, last_event_at), updated_at = ?
     WHERE id = ?`
  ).bind(
    status, data.subscriptionId, data.customerId, data.nextBillingDate, data.cancelAtPeriodEnd ? 1 : 0, data.amountCents, data.currency,
    data.customerEmail, reason, event.occurredAt, nowIso, card.id
  ).run();

  if (card.user_id && card.plan) {
    const sub = await recomputeSubscription(d1, card.user_id, card.plan);
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
  d1: D1DatabaseLike, card: CardSubscription, event: DodoEvent & { kind: 'payment' }, identityOk: boolean
): Promise<CardOutcome> {
  const data = event.data;
  const nowIso = iso(membersRuntime.now());
  await d1.prepare(
    `UPDATE card_subscriptions SET provider_subscription_id = COALESCE(provider_subscription_id, ?),
       provider_customer_id = COALESCE(provider_customer_id, ?), updated_at = ? WHERE id = ?`
  ).bind(data.subscriptionId, data.customerId, nowIso, card.id).run();

  let reason: string | null = null;
  if (!identityOk || card.user_id === null || card.plan === null) reason = card.user_id === null ? 'metadata_missing' : 'metadata_mismatch';
  else if (event.type === 'payment.succeeded' && (data.currency !== 'USD' || data.totalAmount === null || data.totalAmount < getPlan(card.plan).price_usd_cents)) {
    reason = 'amount_mismatch';
  }
  if (reason) {
    await d1.prepare("UPDATE card_subscriptions SET status = 'needs_attention', attention_reason = ?, updated_at = ? WHERE id = ?").bind(reason, nowIso, card.id).run();
    if (card.user_id && card.plan) {
      await recomputeSubscription(d1, card.user_id, card.plan);
      await logActivity(d1, card.user_id, 'billing.needs_attention', { plan: card.plan, card_subscription_id: card.id, reason, amount: data.totalAmount, currency: data.currency });
    }
    return 'needs_attention';
  }
  if (event.type === 'payment.failed' && card.status === 'pending') {
    // The first charge failed: no subscription starts. Renewal failures arrive as subscription.on_hold.
    await d1.prepare("UPDATE card_subscriptions SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'").bind(nowIso, card.id).run();
    if (card.user_id) await logActivity(d1, card.user_id, 'billing.card_ended', { plan: card.plan, card_subscription_id: card.id, status: 'failed' });
    return 'deactivated';
  }
  return 'updated';
}

/**
 * Applies a verified Dodo webhook. The webhook id is recorded first (idempotency gate shared with the
 * other rails); on any processing error the record is released so Dodo's retry is processed again.
 */
export async function applyDodoEvent(
  d1: D1DatabaseLike, env: RuntimeEnv, eventId: string, event: DodoEvent
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
      ? await applySubscriptionEvent(d1, env, card, event, identityOk)
      : await applyPaymentEvent(d1, card, event, identityOk);
    return { outcome, card_subscription_id: card.id };
  } catch (err) {
    await d1.prepare('DELETE FROM payment_events WHERE provider = ? AND event_id = ?').bind('dodo', eventId).run().catch(() => undefined);
    throw err;
  }
}
