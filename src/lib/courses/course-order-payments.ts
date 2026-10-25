/**
 * Turning money into ownership and back. SePay transfers (ZSC codes) and Dodo card payments both
 * end in `fulfilCourseOrder`; refunds, chargebacks and admin revokes end in `reverseCourseOrder`.
 * Every provider event is recorded in payment_events, which makes retries idempotent. The record is written in the own
 * batch of whatever the event changes (the payment, the flag for the admin, the reversal or the restore), so a failure
 * or a worker crash before that batch commits leaves no record and the provider's redelivery applies the event once.
 */
import type { D1DatabaseLike, D1PreparedStatementLike, SqlCondition } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { needsAttentionEvent, purchaseEvent, refundEvent } from '../analytics/commerce-events';
import { outboxInsertStatement } from '../analytics/outbox';
import { AppError } from '../http';
import { courseReceiptEmail, sendLoggedEmail } from '../members/email';
import type { Row } from '../members/runtime';
import { iso, membersRuntime, siteUrl, str } from '../members/runtime';
import { activityStatement, getUserById } from '../members/users';
import { DODO_DISPUTE_FUNDS_KEPT, DODO_DISPUTE_FUNDS_LOST } from '../payments/dodo';
import { isPaymentEventConflict, paymentEventRecorded } from '../payments/payment-events';
import { activateInvoiceRequest } from '../promos/invoice-requests';
import { redeemPromo } from '../promos/promo-redemptions';
import type { CourseOrder } from './course-orders';
import { getCourseOrderByCode } from './course-orders';
import { grantCourseStatements, revokeCourseStatements } from './course-purchases';
import { getCourseById } from './course-store';
import { POLICY_PATH } from './course-terms';
import { formatUsd } from './course-types';
import { courseCommissionReversalStatements, onCourseOrderPaid } from './referral-bridge';

export type CoursePaymentOutcome = 'duplicate_event' | 'unmatched' | 'paid' | 'already_paid' | 'needs_attention' | 'reversed' | 'restored' | 'ignored';

export type CoursePaymentEvent = {
  provider: 'sepay' | 'dodo'; eventId: string; orderId: string | null; amount: number | null; currency: string | null; rawType: string;
};

/**
 * The idempotency record of a provider event as a statement (with `onlyIf`, inserted only while it holds). It throws a
 * unique violation when the event was already recorded.
 */
export function coursePaymentEventStatement(d1: D1DatabaseLike, e: CoursePaymentEvent, onlyIf?: SqlCondition): D1PreparedStatementLike {
  const source = onlyIf ? `SELECT ?, ?, NULL, ?, ?, ?, ?, ? WHERE ${onlyIf.sql}` : 'VALUES (?, ?, NULL, ?, ?, ?, ?, ?)';
  return d1.prepare(`INSERT INTO payment_events (provider, event_id, booking_id, course_order_id, amount, currency, raw_type, received_at) ${source}`)
    .bind(e.provider, e.eventId, e.orderId, e.amount, e.currency, e.rawType, iso(membersRuntime.now()), ...(onlyIf?.params ?? []));
}

export { isPaymentEventConflict };

/** Inserts the idempotency record; false when this provider event was already processed. */
export async function recordCoursePaymentEvent(
  d1: D1DatabaseLike, provider: 'sepay' | 'dodo', eventId: string, orderId: string | null, amount: number | null, currency: string | null, rawType: string,
): Promise<boolean> {
  try {
    await coursePaymentEventStatement(d1, { provider, eventId, orderId, amount, currency, rawType }).run();
    return true;
  } catch (err) {
    if (isPaymentEventConflict(err)) return false;
    throw err;
  }
}

/** True when this provider event is already recorded. */
export async function coursePaymentEventRecorded(d1: D1DatabaseLike, provider: 'sepay' | 'dodo', eventId: string): Promise<boolean> {
  return paymentEventRecorded(d1, provider, eventId);
}

/**
 * The idempotency record of a webhook, built for the batch it gates (payment, flag, reversal or restore): written as
 * the batch's first statement, only while the batch's own guard holds, so the record and what the event changes commit
 * together or not at all.
 */
export type CourseEventGate = (onlyIf?: SqlCondition) => D1PreparedStatementLike;

/**
 * Flags the order for the admin and adds the money to it. The webhook's record (`gate`), the update, any `also`
 * statement, the activity log and the `payment_needs_attention` event are one D1 batch: the amount is added once, and a
 * failure or a crash before the commit leaves nothing, so the redelivery flags the order once. The update, the log and
 * the event apply only while the order is not paid (and while `onlyIf` holds): an order paid meanwhile (a payment
 * racing this one) stays paid, and no flag that never took effect is logged or counted. The record is still written,
 * so the redelivery is a duplicate; with `onlyIf` it is written only while that holds. The update runs last, so the
 * statements before it still see the order it read. Returns whether the order was flagged.
 */
export async function markCourseOrderAttention(
  d1: D1DatabaseLike, order: CourseOrder, reason: string, extra: { amount?: number; currency?: string; ref?: string | null; eventId?: string },
  gate: CourseEventGate, also: D1PreparedStatementLike[] = [], onlyIf?: SqlCondition,
): Promise<boolean> {
  const unpaidSql = "EXISTS (SELECT 1 FROM course_orders o WHERE o.id = ? AND o.status <> 'paid')";
  const unpaid: SqlCondition = onlyIf
    ? { sql: `${unpaidSql} AND ${onlyIf.sql}`, params: [order.id, ...onlyIf.params] }
    : { sql: unpaidSql, params: [order.id] };
  const attention = outboxInsertStatement(d1, needsAttentionEvent({
    distinctId: order.user_id, provider: order.provider, orderType: 'course', reference: extra.eventId ?? `course_order:${order.id}:${reason}`,
    reason, amountMinor: extra.amount, currency: extra.currency ?? (order.provider === 'sepay' ? 'VND' : null),
  }), undefined, unpaid);
  const results = await d1.batch([
    gate(onlyIf),
    ...also,
    activityStatement(d1, order.user_id, 'courses.order_attention', { code: order.code, reason, amount: extra.amount ?? null }, undefined, unpaid),
    ...(attention ? [attention] : []),
    d1.prepare(
      `UPDATE course_orders SET status = 'needs_attention', attention_reason = ?, amount_paid = COALESCE(amount_paid, 0) + ?,
         currency_paid = COALESCE(?, currency_paid), payment_ref = COALESCE(?, payment_ref), provider_event_id = COALESCE(?, provider_event_id), updated_at = ?
       WHERE id = ? AND ${unpaid.sql}`
    ).bind(reason, extra.amount ?? 0, extra.currency ?? null, extra.ref ?? null, extra.eventId ?? null, iso(membersRuntime.now()), order.id, ...unpaid.params),
  ]);
  return Boolean(results.at(-1)?.meta?.changes);
}

/** Amount and currency actually paid for an order (falls back to the amount due on its rail). */
function paidAmount(order: CourseOrder): { amountMinor: number | null; currency: string } {
  if (order.amount_paid !== null && order.currency_paid) return { amountMinor: order.amount_paid, currency: order.currency_paid };
  return order.provider === 'sepay'
    ? { amountMinor: order.amount_paid ?? order.amount_vnd, currency: 'VND' }
    : { amountMinor: order.amount_paid ?? order.amount_usd_cents, currency: 'USD' };
}

/** True when the provider reports less money taken back than the order paid. */
export function isPartialCourseReversal(order: CourseOrder, amountMinor: number | null): boolean {
  const paid = paidAmount(order).amountMinor;
  return amountMinor !== null && paid !== null && amountMinor < paid;
}

/**
 * How a caller marks an order paid: the `SET` assignments of its update with their values, applied only while `when`
 * (a predicate on the order row `o`) holds.
 */
export interface CoursePayment {
  set: string; values: unknown[]; when: string;
  /** The order's `attention_reason` once paid (an admin grant names itself); `set` must not assign it. */
  reason?: string;
}

/**
 * Marks the order paid and grants its course as one D1 batch, then notifies the referral program and emails a
 * receipt. The batch holds every durable write of the payment: the webhook's `payment_events` record (`gate`, first),
 * the grant (GitHub invite rows and log included), the order log, the `purchase` event and, last, the status update,
 * which also flags a course bought twice as `already_owned`. Each applies only while the order is still payable: a failed write or
 * a worker crash before the commit leaves the order unpaid, nothing granted and no record, so the redelivery pays it
 * once. Returns false, with nothing written, when the order was no longer payable. The follow-ups after the batch
 * (referral, promo and invoice bookkeeping, receipt) are idempotent; their failures are logged and never undo the
 * purchase, and a redelivery that finds the receipt missing runs them again (`resumeCourseOrderFollowUps`).
 */
export async function fulfilCourseOrder(
  d1: D1DatabaseLike, env: RuntimeEnv, order: CourseOrder, payment: CoursePayment, payerText: string | null = null, gate?: CourseEventGate,
): Promise<boolean> {
  const course = await getCourseById(d1, order.course_id);
  if (!course) throw new AppError(404, 'course_not_found', 'Course not found');
  const payable: SqlCondition = { sql: `EXISTS (SELECT 1 FROM course_orders o WHERE o.id = ? AND (${payment.when}))`, params: [order.id] };
  // A course order is paid by one verified payment, so the order id is the transaction.
  const paid = paidAmount(order);
  const purchase = paid.amountMinor === null ? null : await purchaseEvent(d1, {
    distinctId: order.user_id, provider: order.provider, orderType: 'course', transactionId: `course_order:${order.id}`,
    amountMinor: paid.amountMinor, currency: paid.currency, occurredAt: order.paid_at,
  });
  const purchaseInsert = purchase ? outboxInsertStatement(d1, purchase, undefined, payable) : null;
  // Bought twice (two open checkouts paid): the access stays with what granted it, and the order keeps the money
  // traceable for a manual refund. The grant earlier in the batch activates only a course that was not active, so an
  // active purchase of another order (or an admin grant) means the course was owned already. The payment's own reason
  // wins, and an earlier reason is kept.
  const reason = `attention_reason = COALESCE(?, CASE WHEN EXISTS (SELECT 1 FROM course_purchases WHERE user_id = ? AND course_id = ? AND status = 'active'
    AND order_id IS NOT ?) THEN COALESCE(attention_reason, 'already_owned') ELSE attention_reason END)`;
  const results = await d1.batch([
    ...(gate ? [gate(payable)] : []),
    ...grantCourseStatements(d1, course, { userId: order.user_id, courseId: order.course_id, orderId: order.id, source: 'purchase' }, payable),
    activityStatement(d1, order.user_id, 'courses.order_paid', orderPaidDetail(order), undefined, payable),
    ...(purchaseInsert ? [purchaseInsert] : []),
    d1.prepare(`UPDATE course_orders SET ${payment.set}, ${reason} WHERE id = ? AND ${payable.sql}`)
      .bind(...payment.values, payment.reason ?? null, order.user_id, order.course_id, order.id, order.id, ...payable.params),
  ]);
  if (!results.at(-1)?.meta?.changes) return false;
  await afterCourseOrderPaid(d1, env, order, payerText);
  return true;
}

function orderPaidDetail(order: CourseOrder): Record<string, unknown> {
  return { code: order.code, course_id: order.course_id, provider: order.provider };
}

const receiptKey = (orderId: string) => `course-receipt:${orderId}`;

/**
 * A redelivered payment event (already recorded) of a paid order whose receipt was never sent: the worker died after
 * the payment batch committed. The follow-ups run again; each is idempotent (the referral commission once per order,
 * promo and invoice updates guarded on their status, the receipt once per order), and the receipt is sent last, so
 * its log marks them done. An admin grant retried after its batch committed resumes them the same way. Returns false,
 * running nothing, when the order is not paid or its receipt was already sent (or skipped).
 */
export async function resumeCourseOrderFollowUps(d1: D1DatabaseLike, env: RuntimeEnv, order: CourseOrder, payerText: string | null = null): Promise<boolean> {
  const current = await getCourseOrderByCode(d1, order.code);
  if (current?.status !== 'paid') return false;
  const mail = await d1.prepare('SELECT status FROM email_log WHERE idempotency_key = ?').bind(receiptKey(current.id)).first<Row>();
  const status = mail ? str(mail, 'status') : '';
  if (status === 'sent' || status === 'skipped') return false;
  await afterCourseOrderPaid(d1, env, current, payerText);
  return true;
}

/** Referral capture, promo/invoice bookkeeping and the receipt of an order whose access is granted. */
async function afterCourseOrderPaid(d1: D1DatabaseLike, env: RuntimeEnv, order: CourseOrder, payerText: string | null): Promise<void> {
  try {
    await onCourseOrderPaid(d1, env, order, payerText);
  } catch (err) {
    console.error(`referral capture for ${order.code} failed:`, err instanceof Error ? err.message : 'unknown');
  }
  try {
    if (order.promo_code_id) await redeemPromo(d1, 'course_order', order.id, order.amount_paid);
    if (order.provider === 'sepay') await activateInvoiceRequest(d1, env, 'course_order', order.id, order.amount_paid ?? order.amount_vnd);
  } catch (err) {
    console.error(`promo/invoice bookkeeping for ${order.code} failed:`, err instanceof Error ? err.message : 'unknown');
  }
  const [user, course] = await Promise.all([getUserById(d1, order.user_id), getCourseById(d1, order.course_id)]);
  if (!user || !course) return;
  const amount = order.provider === 'sepay'
    ? `${new Intl.NumberFormat('vi-VN').format(order.amount_paid ?? order.amount_vnd ?? 0)} ₫`
    : formatUsd(order.amount_paid ?? order.amount_usd_cents);
  const mail = await sendLoggedEmail(d1, env, {
    key: receiptKey(order.id),
    kind: 'course_receipt',
    to: user.email,
    userId: user.id,
    ...courseReceiptEmail({
      code: order.code,
      courseTitle: course.title,
      amount,
      paidAt: order.paid_at ?? iso(membersRuntime.now()),
      courseUrl: `${siteUrl(env)}/courses/${course.slug}`,
      policyUrl: `${siteUrl(env)}${POLICY_PATH}`,
    }),
  });
  if (mail.status !== 'sent' && mail.status !== 'duplicate') console.warn(`course receipt for ${order.code} ${mail.status}`);
}

export type ReversalKind = 'refunded' | 'charged_back';

type MoneyBack = { amountMinor: number | null; currency: string | null };

/** The order still has one of `statuses` when the statement runs. */
function orderIn(orderId: string, statuses: readonly string[], also = ''): SqlCondition {
  return {
    sql: `EXISTS (SELECT 1 FROM course_orders o WHERE o.id = ? AND o.status IN (${statuses.map(() => '?').join(', ')})${also})`,
    params: [orderId, ...statuses],
  };
}

const REVERSIBLE = ['paid', 'needs_attention'] as const;

/**
 * Marks a paid order refunded or charged back, revokes access and reverses referral commission. The status update,
 * the revoke (when this order granted the access), the activity log and the analytics event (`countMoneyBack`: a
 * refund, or the chargeback of a lost dispute) are one D1 batch, each applied only while the order is still
 * reversible. A webhook passes its `payment_events` record as `gate`: it is the batch's first statement under the same
 * guard, so a failure or a crash before the commit leaves neither the reversal nor the record, and the redelivery
 * applies it once; a redelivery after the commit fails on the record's unique key and writes nothing. The referral
 * commission reversal (its log, ledger line and status, or the marker of a referred order with no commission yet) is
 * part of the same batch under the same guard, so the order and its commission change together: an order still paid
 * keeps its commission, and one reversed has its commission reversed, whatever status the order was read in. `onlyIf`
 * narrows the guard (an opened dispute already resolved for the merchant reverses nothing).
 */
export async function reverseCourseOrder(
  d1: D1DatabaseLike, order: CourseOrder, kind: ReversalKind, reason: string, actor = 'system',
  /** Amount the provider reports taken back; defaults to the amount paid. */
  reversed: MoneyBack | null = null,
  countMoneyBack = kind === 'refunded',
  gate?: CourseEventGate,
  onlyIf?: SqlCondition,
): Promise<boolean> {
  const base = orderIn(order.id, REVERSIBLE);
  const reversible: SqlCondition = onlyIf ? { sql: `${base.sql} AND ${onlyIf.sql}`, params: [...base.params, ...onlyIf.params] } : base;
  const course = await getCourseById(d1, order.course_id);
  const moneyBack = countMoneyBack ? await courseMoneyBackStatement(d1, order, kind, reversed, reversible) : null;
  const results = await d1.batch([
    ...(gate ? [gate(reversible)] : []),
    // Only revoke when this order is the one that granted access (a duplicate purchase leaves the original intact).
    ...revokeCourseStatements(d1, course, { userId: order.user_id, courseId: order.course_id, reason: `${kind}:${reason}`, actor, orderId: order.id }, reversible),
    activityStatement(d1, order.user_id, `courses.order_${kind}`, { code: order.code, reason, actor }, undefined, reversible),
    // A refund always took the money back. A chargeback is reported only once the dispute is lost: an opened dispute
    // revokes access but may still be won.
    ...(moneyBack ? [moneyBack] : []),
    ...courseCommissionReversalStatements(d1, order.id, kind, reversible),
    d1.prepare(`UPDATE course_orders SET status = ?, attention_reason = ?, updated_at = ? WHERE id = ? AND ${reversible.sql}`)
      .bind(kind, reason.slice(0, 200), iso(membersRuntime.now()), order.id, ...reversible.params),
  ]);
  return Boolean(results.at(-1)?.meta?.changes);
}

/**
 * A refund (Dodo's, or a manual one an admin records) of an order that an opened dispute already charged back. Access
 * is already revoked and the referral commission reversed, so the order only becomes `refunded` and its money back is
 * counted; a later won or cancelled dispute then finds no `charged_back` order to restore. The refund is dropped once a
 * funds-lost outcome was received for the order (that chargeback is the same money). The check runs in the same batch
 * as the update, so a racing funds-lost outcome either finds the order refunded or suppresses the refund. The webhook's
 * record (`gate`), the update, the log and the `refund` event land together or not at all.
 */
export async function refundDisputedCourseOrder(
  d1: D1DatabaseLike, order: CourseOrder, reason: string, reversed: MoneyBack | null, gate?: CourseEventGate, actor = 'system',
): Promise<boolean> {
  const lost = [...DODO_DISPUTE_FUNDS_LOST];
  const disputed = orderIn(order.id, ['charged_back'], ` AND NOT EXISTS (SELECT 1 FROM payment_events WHERE provider = 'dodo' AND course_order_id = o.id AND raw_type IN (${lost.map(() => '?').join(', ')}))`);
  disputed.params.push(...lost);
  const moneyBack = await courseMoneyBackStatement(d1, order, 'refunded', reversed, disputed);
  const results = await d1.batch([
    ...(gate ? [gate(disputed)] : []),
    activityStatement(d1, order.user_id, 'courses.order_refunded', { code: order.code, reason, actor }, undefined, disputed),
    ...(moneyBack ? [moneyBack] : []),
    d1.prepare(`UPDATE course_orders SET status = 'refunded', attention_reason = ?, updated_at = ? WHERE id = ? AND ${disputed.sql}`)
      .bind(reason, iso(membersRuntime.now()), order.id, ...disputed.params),
  ]);
  return Boolean(results.at(-1)?.meta?.changes);
}

/**
 * A refund of a course order, by Dodo or recorded by an admin: a paid or flagged order is reversed
 * (`reverseCourseOrder`), and one an opened dispute charged back only becomes refunded (`refundDisputedCourseOrder`),
 * so its commission, reversed when the dispute opened, is not reversed twice. The order was read before the batch ran:
 * when a dispute opened or was won meanwhile, the refund is applied once more on the current order instead of being
 * dropped. Only the batch that applies writes the webhook's record (`gate`). Returns whether the order was refunded.
 */
export async function refundCourseOrder(
  d1: D1DatabaseLike, order: CourseOrder, reason: string, actor: string, reversed: MoneyBack | null = null, gate?: CourseEventGate,
): Promise<boolean> {
  const refund = (o: CourseOrder) => o.status === 'charged_back'
    ? refundDisputedCourseOrder(d1, o, reason, reversed, gate, actor)
    : reverseCourseOrder(d1, o, 'refunded', reason, actor, reversed, true, gate);
  if (await refund(order)) return true;
  const current = await getCourseOrderByCode(d1, order.code);
  return current !== null && current.status !== order.status && refund(current);
}

/**
 * A funds-lost dispute outcome for an order that is no longer reversible, usually charged back by `dispute.opened`:
 * the lost money is reported now, once. An order already refunded in full reported its money back then (also when the
 * refund came while the dispute was open); after a partial refund the chargeback is still counted. The webhook's record
 * comes first in the same batch, and the refund check reads the order after it: a refund racing this outcome either
 * committed first and is seen here, or sees the record and is suppressed (`refundDisputedCourseOrder`).
 */
export async function chargeBackLostCourseOrder(d1: D1DatabaseLike, order: CourseOrder, reversed: MoneyBack, gate: CourseEventGate): Promise<void> {
  const notFullyRefunded: SqlCondition = {
    sql: "NOT EXISTS (SELECT 1 FROM course_orders o WHERE o.id = ? AND o.status = 'refunded' AND COALESCE(o.attention_reason, '') <> 'dodo_partial_refund')",
    params: [order.id],
  };
  const moneyBack = await courseMoneyBackStatement(d1, order, 'charged_back', reversed, notFullyRefunded);
  await d1.batch([gate(), ...(moneyBack ? [moneyBack] : [])]);
}

/**
 * The `refund` event of money that went back for a course order, once per order and kind, as a statement for a D1
 * batch (with `onlyIf`, inserted only while it holds). Null for a flagged order that was never paid (`paid_at` is
 * null): it never produced a purchase event, so it is not lost revenue either.
 */
export async function courseMoneyBackStatement(
  d1: D1DatabaseLike, order: CourseOrder, kind: ReversalKind, reversed: MoneyBack | null = null, onlyIf?: SqlCondition,
): Promise<D1PreparedStatementLike | null> {
  if (order.paid_at === null) return null;
  const paid = paidAmount(order);
  const amountMinor = reversed?.amountMinor ?? paid.amountMinor;
  return outboxInsertStatement(d1, await refundEvent(d1, {
    distinctId: order.user_id, provider: order.provider, orderType: 'course', reference: `course_order:${order.id}:${kind}`,
    reason: kind === 'refunded' ? 'refund' : 'chargeback', amountMinor, currency: reversed?.currency ?? paid.currency,
    partial: amountMinor !== null && paid.amountMinor !== null ? isPartialCourseReversal(order, amountMinor) : undefined,
    purchaseTransactionId: `course_order:${order.id}`,
  }), undefined, onlyIf);
}

const DISPUTE_KEPT = [...DODO_DISPUTE_FUNDS_KEPT];

/**
 * Every won or cancelled dispute outcome recorded for the order has its `dispute.opened` recorded too (a dispute opens
 * once and ends once). Dodo may deliver an outcome before the opened event it ends (that delivery retried later); while
 * an outcome waits for its opened event, the late `dispute.opened` must not take access away. Recording an opened
 * event only keeps this true, so it holds for every statement of the batch that records it.
 */
export function courseDisputesPaired(orderId: string): SqlCondition {
  const count = (types: string) => `(SELECT COUNT(*) FROM payment_events WHERE provider = 'dodo' AND course_order_id = ? AND raw_type IN (${types}))`;
  return {
    sql: `${count(DISPUTE_KEPT.map(() => '?').join(', '))} <= ${count('?')}`,
    params: [orderId, ...DISPUTE_KEPT, orderId, 'dispute.opened'],
  };
}

/** True when a won or cancelled outcome of the order's dispute arrived before its `dispute.opened`. */
export async function courseDisputeResolvedEarly(d1: D1DatabaseLike, orderId: string): Promise<boolean> {
  const paired = courseDisputesPaired(orderId);
  return (await d1.prepare(`SELECT 1 AS found WHERE NOT (${paired.sql})`).bind(...paired.params).first<Row>()) !== null;
}

/**
 * A dispute the merchant won: the order is paid again and access returns. No purchase event is queued: the
 * original one still stands, because an opened dispute never queued a refund. An order refunded while the dispute was
 * open is `refunded`, not `charged_back`, so it stays revoked (after a partial refund too: any refund revokes access).
 * The access grant (with its GitHub invite rows and log), the order log and the status update are one D1 batch, each
 * applied only while the order is still `charged_back`, with the status update last: a refund that commits first
 * makes the whole batch a no-op, and a refund that comes after it finds the order paid and the access granted, and
 * revokes it. The webhook's record (`gate`) is the batch's first statement under the same guard, so a failure or a
 * crash before the commit leaves no record and the redelivery restores the order once. A course deleted meanwhile
 * grants nothing: the order is flagged `course_missing` under the same guard, for the admin to refund or settle.
 * Returns the outcome, or null when the order was no longer charged back.
 */
export async function restoreCourseOrder(
  d1: D1DatabaseLike, env: RuntimeEnv, order: CourseOrder, reason: string, gate: CourseEventGate,
): Promise<'restored' | 'needs_attention' | null> {
  const disputed = orderIn(order.id, ['charged_back']);
  const course = await getCourseById(d1, order.course_id);
  if (!course) return (await markCourseOrderAttention(d1, order, 'course_missing', {}, gate, [], disputed)) ? 'needs_attention' : null;
  const results = await d1.batch([
    gate(disputed),
    ...grantCourseStatements(d1, course, { userId: order.user_id, courseId: order.course_id, orderId: order.id, source: 'purchase' }, disputed),
    activityStatement(d1, order.user_id, 'courses.order_paid', orderPaidDetail(order), undefined, disputed),
    d1.prepare(`UPDATE course_orders SET status = 'paid', attention_reason = ?, updated_at = ? WHERE id = ? AND ${disputed.sql}`)
      .bind(reason, iso(membersRuntime.now()), order.id, ...disputed.params),
  ]);
  if (!results.at(-1)?.meta?.changes) return null;
  await afterCourseOrderPaid(d1, env, { ...order, status: 'paid' }, null);
  return 'restored';
}

/** True when a funds-lost outcome of a dispute was received for the order: its chargeback already returned the money. */
export async function courseDisputeLost(d1: D1DatabaseLike, orderId: string): Promise<boolean> {
  const lost = [...DODO_DISPUTE_FUNDS_LOST];
  return (await d1.prepare(`SELECT 1 AS found FROM payment_events WHERE provider = 'dodo' AND course_order_id = ? AND raw_type IN (${lost.map(() => '?').join(', ')}) LIMIT 1`)
    .bind(orderId, ...lost).first<Row>()) !== null;
}

/** The `attention_reason` prefix of an order an admin grant paid (`admin_grant:<note>`). */
const ADMIN_GRANT = 'admin_grant:';

/** A grant or dismiss of a charged-back order: the dispute's outcome decides its access, an admin can only refund it. */
function disputedOrder(verb: 'granted' | 'dismissed'): AppError {
  return new AppError(409, 'order_disputed', `A disputed (charged back) order cannot be ${verb}: the dispute outcome decides its access; record a refund instead while the dispute is open`);
}

/** Neither paid nor charged back: what an admin grant or dismiss may change. */
const SETTLEABLE = "o.status NOT IN ('paid', 'charged_back')";

/**
 * Admin decisions: `grant` pays out a flagged order (e.g. underpaid by a rounding error),
 * `dismiss` closes it without access, `refund` records a manual refund and revokes access. A refund of an order with
 * an open dispute (`charged_back`) takes the same path as Dodo's refund during a dispute (`refundCourseOrder`); after a
 * lost dispute it answers `409 not_refundable`, as the chargeback already returned the money.
 * A `grant` or `dismiss` of a charged-back order answers `409 order_disputed` and changes nothing: a grant would give
 * access back while the dispute is open, and a dismissed order could no longer be restored by a won dispute. Both
 * apply only while the order is still neither paid nor charged back, so a dispute opened meanwhile is refused the same way.
 * A `grant` retried on an order an admin grant already paid, whose receipt is still missing (the follow-ups after the
 * payment batch failed), runs the idempotent follow-ups again; a grant of an order paid any other way, or whose
 * follow-ups completed, answers `409 already_paid`.
 */
export async function resolveCourseOrder(d1: D1DatabaseLike, env: RuntimeEnv, code: string, action: unknown, reason: unknown): Promise<CourseOrder> {
  const order = await getCourseOrderByCode(d1, code);
  if (!order) throw new AppError(404, 'not_found', 'Order not found');
  const note = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : 'admin';
  const now = iso(membersRuntime.now());
  /** The order as it is now, after an attempt that changed nothing. */
  const current = async () => (await getCourseOrderByCode(d1, order.code)) ?? order;
  if (action === 'grant') {
    if (order.status === 'charged_back') throw disputedOrder('granted');
    const done = order.status === 'paid'
      ? (order.attention_reason ?? '').startsWith(ADMIN_GRANT) && await resumeCourseOrderFollowUps(d1, env, order)
      : await fulfilCourseOrder(d1, env, { ...order, status: 'paid', paid_at: order.paid_at ?? now }, {
        set: "status = 'paid', paid_at = COALESCE(paid_at, ?), updated_at = ?", values: [now, now], when: SETTLEABLE, reason: `${ADMIN_GRANT}${note}`,
      });
    if (!done) {
      if ((await current()).status === 'charged_back') throw disputedOrder('granted');
      throw new AppError(409, 'already_paid', 'Order is already paid');
    }
  } else if (action === 'dismiss') {
    if (order.status === 'paid') throw new AppError(409, 'already_paid', 'Use refund for a paid order');
    if (order.status === 'charged_back') throw disputedOrder('dismissed');
    const res = await d1.prepare(`UPDATE course_orders SET status = 'cancelled', attention_reason = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM course_orders o WHERE o.id = ? AND ${SETTLEABLE})`)
      .bind(`dismissed:${note}`, now, order.id, order.id).run();
    if (!res.meta?.changes) {
      if ((await current()).status === 'charged_back') throw disputedOrder('dismissed');
      throw new AppError(409, 'already_paid', 'Use refund for a paid order');
    }
  } else if (action === 'refund') {
    if (!(await refundCourseOrder(d1, order, note, 'admin'))) {
      // The status the attempt found, not the one read before it: a Dodo refund may have landed in between.
      const found = await current();
      throw new AppError(409, 'not_refundable', found.status === 'charged_back'
        ? 'The dispute on this order was lost: the chargeback already returned the money'
        : found.status === 'refunded' ? 'Order is already refunded' : 'Only paid, flagged or disputed (charged back) orders can be refunded');
    }
  } else {
    throw new AppError(400, 'invalid_field', "action must be 'grant', 'dismiss' or 'refund'", { field: 'action' });
  }
  const updated = await getCourseOrderByCode(d1, order.code);
  if (!updated) throw new AppError(500, 'internal_error', 'Order disappeared');
  return updated;
}
