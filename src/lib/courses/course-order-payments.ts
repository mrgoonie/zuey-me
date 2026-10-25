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
import { DODO_DISPUTE_FUNDS_LOST } from '../payments/dodo';
import { activateInvoiceRequest } from '../promos/invoice-requests';
import { redeemPromo } from '../promos/promo-redemptions';
import type { CourseOrder } from './course-orders';
import { getCourseOrderByCode } from './course-orders';
import { grantCourseStatements, revokeCourseStatements } from './course-purchases';
import { getCourseById } from './course-store';
import { POLICY_PATH } from './course-terms';
import { formatUsd } from './course-types';
import { onCourseOrderPaid, onCourseOrderReversed } from './referral-bridge';

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

/**
 * True when `err` is the unique key of `payment_events` (provider, event_id): another delivery of the same event
 * recorded it first. Any other constraint failure is a real error.
 */
export function isPaymentEventConflict(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed: payment_events\.provider, payment_events\.event_id\b/i.test(err.message);
}

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
  return (await d1.prepare('SELECT 1 AS found FROM payment_events WHERE provider = ? AND event_id = ?').bind(provider, eventId).first<Row>()) !== null;
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
 * failure or a crash before the commit leaves nothing, so the redelivery flags the order once.
 */
export async function markCourseOrderAttention(
  d1: D1DatabaseLike, order: CourseOrder, reason: string, extra: { amount?: number; currency?: string; ref?: string | null; eventId?: string },
  gate: CourseEventGate, also: D1PreparedStatementLike[] = [],
): Promise<void> {
  const attention = outboxInsertStatement(d1, needsAttentionEvent({
    distinctId: order.user_id, provider: order.provider, orderType: 'course', reference: extra.eventId ?? `course_order:${order.id}:${reason}`,
    reason, amountMinor: extra.amount, currency: extra.currency ?? (order.provider === 'sepay' ? 'VND' : null),
  }));
  await d1.batch([
    gate(),
    d1.prepare(
      `UPDATE course_orders SET status = 'needs_attention', attention_reason = ?, amount_paid = COALESCE(amount_paid, 0) + ?,
         currency_paid = COALESCE(?, currency_paid), payment_ref = COALESCE(?, payment_ref), provider_event_id = COALESCE(?, provider_event_id), updated_at = ?
       WHERE id = ? AND status <> 'paid'`
    ).bind(reason, extra.amount ?? 0, extra.currency ?? null, extra.ref ?? null, extra.eventId ?? null, iso(membersRuntime.now()), order.id),
    ...also,
    activityStatement(d1, order.user_id, 'courses.order_attention', { code: order.code, reason, amount: extra.amount ?? null }),
    ...(attention ? [attention] : []),
  ]);
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
 * applies it once; a redelivery after the commit fails on the record's unique key and writes nothing. The commission
 * reversal cannot join the batch (it reads and appends to the shared referral ledger) and runs first for an order
 * read as reversible: it is idempotent, so running it again on the redelivery is safe.
 */
export async function reverseCourseOrder(
  d1: D1DatabaseLike, order: CourseOrder, kind: ReversalKind, reason: string, actor = 'system',
  /** Amount the provider reports taken back; defaults to the amount paid. */
  reversed: MoneyBack | null = null,
  countMoneyBack = kind === 'refunded',
  gate?: CourseEventGate,
): Promise<boolean> {
  const commissionFirst = (REVERSIBLE as readonly string[]).includes(order.status);
  if (commissionFirst) await reverseReferral(d1, order, kind);
  const reversible = orderIn(order.id, REVERSIBLE);
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
    d1.prepare(`UPDATE course_orders SET status = ?, attention_reason = ?, updated_at = ? WHERE id = ? AND ${reversible.sql}`)
      .bind(kind, reason.slice(0, 200), iso(membersRuntime.now()), order.id, ...reversible.params),
  ]);
  const applied = Boolean(results.at(-1)?.meta?.changes);
  // The order was read in another status and became reversible since: the commission was not reversed above.
  if (applied && !commissionFirst) await reverseReferral(d1, order, kind);
  return applied;
}

/** Referral failures are logged and never block the reversal. */
async function reverseReferral(d1: D1DatabaseLike, order: CourseOrder, kind: ReversalKind): Promise<void> {
  try {
    await onCourseOrderReversed(d1, order, kind);
  } catch (err) {
    console.error(`referral reversal for ${order.code} failed:`, err instanceof Error ? err.message : 'unknown');
  }
}

/**
 * A Dodo refund of an order that an opened dispute already charged back. Access is already revoked and the referral
 * commission reversed, so the order only becomes `refunded` and its money back is counted; a later won or cancelled
 * dispute then finds no `charged_back` order to restore. The refund is dropped once a funds-lost outcome was received
 * for the order (that chargeback is the same money). The check runs in the same batch as the update, so a racing
 * funds-lost outcome either finds the order refunded or suppresses the refund. The webhook's record (`gate`), the
 * update, the log and the `refund` event land together or not at all.
 */
export async function refundDisputedCourseOrder(d1: D1DatabaseLike, order: CourseOrder, reason: string, reversed: MoneyBack, gate?: CourseEventGate): Promise<boolean> {
  const lost = [...DODO_DISPUTE_FUNDS_LOST];
  const disputed = orderIn(order.id, ['charged_back'], ` AND NOT EXISTS (SELECT 1 FROM payment_events WHERE provider = 'dodo' AND course_order_id = o.id AND raw_type IN (${lost.map(() => '?').join(', ')}))`);
  disputed.params.push(...lost);
  const moneyBack = await courseMoneyBackStatement(d1, order, 'refunded', reversed, disputed);
  const results = await d1.batch([
    ...(gate ? [gate(disputed)] : []),
    activityStatement(d1, order.user_id, 'courses.order_refunded', { code: order.code, reason, actor: 'system' }, undefined, disputed),
    ...(moneyBack ? [moneyBack] : []),
    d1.prepare(`UPDATE course_orders SET status = 'refunded', attention_reason = ?, updated_at = ? WHERE id = ? AND ${disputed.sql}`)
      .bind(reason, iso(membersRuntime.now()), order.id, ...disputed.params),
  ]);
  return Boolean(results.at(-1)?.meta?.changes);
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

/**
 * A dispute the merchant won: the order is paid again and access returns. No purchase event is queued: the
 * original one still stands, because an opened dispute never queued a refund. An order refunded while the dispute was
 * open is `refunded`, not `charged_back`, so it stays revoked (after a partial refund too: any refund revokes access).
 * The access grant (with its GitHub invite rows and log), the order log and the status update are one D1 batch, each
 * applied only while the order is still `charged_back`, with the status update last: a refund that commits first
 * makes the whole batch a no-op, and a refund that comes after it finds the order paid and the access granted, and
 * revokes it. The webhook's record (`gate`) is the batch's first statement under the same guard, so a failure or a
 * crash before the commit leaves no record and the redelivery restores the order once.
 */
export async function restoreCourseOrder(d1: D1DatabaseLike, env: RuntimeEnv, order: CourseOrder, reason: string, gate?: CourseEventGate): Promise<boolean> {
  const course = await getCourseById(d1, order.course_id);
  if (!course) throw new AppError(404, 'course_not_found', 'Course not found');
  const disputed = orderIn(order.id, ['charged_back']);
  const results = await d1.batch([
    ...(gate ? [gate(disputed)] : []),
    ...grantCourseStatements(d1, course, { userId: order.user_id, courseId: order.course_id, orderId: order.id, source: 'purchase' }, disputed),
    activityStatement(d1, order.user_id, 'courses.order_paid', orderPaidDetail(order), undefined, disputed),
    d1.prepare(`UPDATE course_orders SET status = 'paid', attention_reason = ?, updated_at = ? WHERE id = ? AND ${disputed.sql}`)
      .bind(reason, iso(membersRuntime.now()), order.id, ...disputed.params),
  ]);
  if (!results.at(-1)?.meta?.changes) return false;
  await afterCourseOrderPaid(d1, env, { ...order, status: 'paid' }, null);
  return true;
}

/** The `attention_reason` prefix of an order an admin grant paid (`admin_grant:<note>`). */
const ADMIN_GRANT = 'admin_grant:';

/**
 * Admin decisions: `grant` pays out a flagged order (e.g. underpaid by a rounding error),
 * `dismiss` closes it without access, `refund` records a manual refund and revokes access.
 * A `grant` retried on an order an admin grant already paid, whose receipt is still missing (the follow-ups after the
 * payment batch failed), runs the idempotent follow-ups again; a grant of an order paid any other way, or whose
 * follow-ups completed, answers `409 already_paid`.
 */
export async function resolveCourseOrder(d1: D1DatabaseLike, env: RuntimeEnv, code: string, action: unknown, reason: unknown): Promise<CourseOrder> {
  const order = await getCourseOrderByCode(d1, code);
  if (!order) throw new AppError(404, 'not_found', 'Order not found');
  const note = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : 'admin';
  const now = iso(membersRuntime.now());
  if (action === 'grant') {
    const done = order.status === 'paid'
      ? (order.attention_reason ?? '').startsWith(ADMIN_GRANT) && await resumeCourseOrderFollowUps(d1, env, order)
      : await fulfilCourseOrder(d1, env, { ...order, status: 'paid', paid_at: order.paid_at ?? now }, {
        set: "status = 'paid', paid_at = COALESCE(paid_at, ?), updated_at = ?", values: [now, now], when: "o.status <> 'paid'", reason: `${ADMIN_GRANT}${note}`,
      });
    if (!done) throw new AppError(409, 'already_paid', 'Order is already paid');
  } else if (action === 'dismiss') {
    if (order.status === 'paid') throw new AppError(409, 'already_paid', 'Use refund for a paid order');
    await d1.prepare("UPDATE course_orders SET status = 'cancelled', attention_reason = ?, updated_at = ? WHERE id = ?").bind(`dismissed:${note}`, now, order.id).run();
  } else if (action === 'refund') {
    if (!(await reverseCourseOrder(d1, order, 'refunded', note, 'admin'))) throw new AppError(409, 'not_refundable', 'Only paid or flagged orders can be refunded');
  } else {
    throw new AppError(400, 'invalid_field', "action must be 'grant', 'dismiss' or 'refund'", { field: 'action' });
  }
  const updated = await getCourseOrderByCode(d1, order.code);
  if (!updated) throw new AppError(500, 'internal_error', 'Order disappeared');
  return updated;
}
