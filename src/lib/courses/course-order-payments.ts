/**
 * Turning money into ownership and back. SePay transfers (ZSC codes) and Dodo card payments both
 * end in `fulfilCourseOrder`; refunds, chargebacks and admin revokes end in `reverseCourseOrder`.
 * Every provider event is recorded in payment_events first, which makes retries idempotent.
 */
import type { D1DatabaseLike, D1PreparedStatementLike, SqlCondition } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { queueNeedsAttention, queuePurchase, refundEvent } from '../analytics/commerce-events';
import { outboxInsertStatement } from '../analytics/outbox';
import { AppError } from '../http';
import { courseReceiptEmail, sendLoggedEmail } from '../members/email';
import { iso, isUniqueViolation, membersRuntime, siteUrl } from '../members/runtime';
import { activityStatement, getUserById, logActivity } from '../members/users';
import { DODO_DISPUTE_FUNDS_LOST } from '../payments/dodo';
import { activateInvoiceRequest } from '../promos/invoice-requests';
import { redeemPromo } from '../promos/promo-redemptions';
import type { CourseOrder } from './course-orders';
import { getCourseOrderByCode } from './course-orders';
import { grantCourse, revokeCourseStatements } from './course-purchases';
import { getCourseById } from './course-store';
import { POLICY_PATH } from './course-terms';
import { formatUsd } from './course-types';
import { onCourseOrderPaid, onCourseOrderReversed } from './referral-bridge';

export type CoursePaymentOutcome = 'duplicate_event' | 'unmatched' | 'paid' | 'already_paid' | 'needs_attention' | 'reversed' | 'restored' | 'ignored';

/** Inserts the idempotency record; false when this provider event was already processed. */
export async function recordCoursePaymentEvent(
  d1: D1DatabaseLike, provider: 'sepay' | 'dodo', eventId: string, orderId: string | null, amount: number | null, currency: string | null, rawType: string,
): Promise<boolean> {
  try {
    await d1.prepare(
      'INSERT INTO payment_events (provider, event_id, booking_id, course_order_id, amount, currency, raw_type, received_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)'
    ).bind(provider, eventId, orderId, amount, currency, rawType, iso(membersRuntime.now())).run();
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/** Lets the provider retry an event whose processing failed half-way. */
export async function releaseCoursePaymentEvent(d1: D1DatabaseLike, provider: 'sepay' | 'dodo', eventId: string): Promise<void> {
  await d1.prepare('DELETE FROM payment_events WHERE provider = ? AND event_id = ?').bind(provider, eventId).run().catch(() => undefined);
}

export async function markCourseOrderAttention(d1: D1DatabaseLike, order: CourseOrder, reason: string, extra: { amount?: number; currency?: string; ref?: string | null; eventId?: string } = {}): Promise<void> {
  await d1.prepare(
    `UPDATE course_orders SET status = 'needs_attention', attention_reason = ?, amount_paid = COALESCE(amount_paid, 0) + ?,
       currency_paid = COALESCE(?, currency_paid), payment_ref = COALESCE(?, payment_ref), provider_event_id = COALESCE(?, provider_event_id), updated_at = ?
     WHERE id = ? AND status <> 'paid'`
  ).bind(reason, extra.amount ?? 0, extra.currency ?? null, extra.ref ?? null, extra.eventId ?? null, iso(membersRuntime.now()), order.id).run();
  await logActivity(d1, order.user_id, 'courses.order_attention', { code: order.code, reason, amount: extra.amount ?? null });
  await queueNeedsAttention(d1, {
    distinctId: order.user_id, provider: order.provider, orderType: 'course', reference: extra.eventId ?? `course_order:${order.id}:${reason}`,
    reason, amountMinor: extra.amount, currency: extra.currency ?? (order.provider === 'sepay' ? 'VND' : null),
  });
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
 * Grants the course for a paid order, notifies the referral program and emails a receipt.
 * Referral and email failures are logged and never undo the purchase.
 */
export async function fulfilCourseOrder(
  d1: D1DatabaseLike, env: RuntimeEnv, order: CourseOrder, payerText: string | null = null,
  /** `countPurchase: false` when access returns for money that was already counted (a won dispute). */
  opts: { countPurchase?: boolean } = {},
): Promise<void> {
  const granted = await grantCourse(d1, { userId: order.user_id, courseId: order.course_id, orderId: order.id, source: 'purchase' });
  if (!granted) {
    // Bought twice (two open checkouts paid): keep the money traceable for a manual refund.
    await d1.prepare("UPDATE course_orders SET attention_reason = COALESCE(attention_reason, 'already_owned'), updated_at = ? WHERE id = ?")
      .bind(iso(membersRuntime.now()), order.id).run();
  }
  await logActivity(d1, order.user_id, 'courses.order_paid', { code: order.code, course_id: order.course_id, provider: order.provider });
  // A course order is paid by one verified payment, so the order id is the transaction.
  const paid = paidAmount(order);
  if (opts.countPurchase !== false && paid.amountMinor !== null) {
    await queuePurchase(d1, {
      distinctId: order.user_id, provider: order.provider, orderType: 'course', transactionId: `course_order:${order.id}`,
      amountMinor: paid.amountMinor, currency: paid.currency, occurredAt: order.paid_at,
    });
  }
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
    key: `course-receipt:${order.id}`,
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
 * reversible, so a failed write leaves none of them and, once the webhook has released its event, the retry writes
 * them all once. (The webhook's `payment_events` row is a separate insert before the batch, so a worker that dies
 * after that insert leaves the event recorded and its redelivery is dropped as a duplicate.) The commission
 * reversal cannot join the batch and runs first for an order read as reversible: it is idempotent, so running it
 * again on the retry is safe.
 */
export async function reverseCourseOrder(
  d1: D1DatabaseLike, order: CourseOrder, kind: ReversalKind, reason: string, actor = 'system',
  /** Amount the provider reports taken back; defaults to the amount paid. */
  reversed: MoneyBack | null = null,
  countMoneyBack = kind === 'refunded',
): Promise<boolean> {
  const commissionFirst = (REVERSIBLE as readonly string[]).includes(order.status);
  if (commissionFirst) await reverseReferral(d1, order, kind);
  const reversible = orderIn(order.id, REVERSIBLE);
  const course = await getCourseById(d1, order.course_id);
  const moneyBack = countMoneyBack ? await courseMoneyBackStatement(d1, order, kind, reversed, reversible) : null;
  const results = await d1.batch([
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
 * funds-lost outcome either finds the order refunded or suppresses the refund. The update, the log and the `refund`
 * event land together or not at all.
 */
export async function refundDisputedCourseOrder(d1: D1DatabaseLike, order: CourseOrder, reason: string, reversed: MoneyBack): Promise<boolean> {
  const lost = [...DODO_DISPUTE_FUNDS_LOST];
  const disputed = orderIn(order.id, ['charged_back'], ` AND NOT EXISTS (SELECT 1 FROM payment_events WHERE provider = 'dodo' AND course_order_id = o.id AND raw_type IN (${lost.map(() => '?').join(', ')}))`);
  disputed.params.push(...lost);
  const moneyBack = await courseMoneyBackStatement(d1, order, 'refunded', reversed, disputed);
  const results = await d1.batch([
    activityStatement(d1, order.user_id, 'courses.order_refunded', { code: order.code, reason, actor: 'system' }, undefined, disputed),
    ...(moneyBack ? [moneyBack] : []),
    d1.prepare(`UPDATE course_orders SET status = 'refunded', attention_reason = ?, updated_at = ? WHERE id = ? AND ${disputed.sql}`)
      .bind(reason, iso(membersRuntime.now()), order.id, ...disputed.params),
  ]);
  return Boolean(results.at(-1)?.meta?.changes);
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
 */
export async function restoreCourseOrder(d1: D1DatabaseLike, env: RuntimeEnv, order: CourseOrder, reason: string): Promise<boolean> {
  const res = await d1.prepare("UPDATE course_orders SET status = 'paid', attention_reason = ?, updated_at = ? WHERE id = ? AND status = 'charged_back'")
    .bind(reason, iso(membersRuntime.now()), order.id).run();
  if (!res.meta?.changes) return false;
  await fulfilCourseOrder(d1, env, { ...order, status: 'paid' }, null, { countPurchase: false });
  return true;
}

/**
 * Admin decisions: `grant` pays out a flagged order (e.g. underpaid by a rounding error),
 * `dismiss` closes it without access, `refund` records a manual refund and revokes access.
 */
export async function resolveCourseOrder(d1: D1DatabaseLike, env: RuntimeEnv, code: string, action: unknown, reason: unknown): Promise<CourseOrder> {
  const order = await getCourseOrderByCode(d1, code);
  if (!order) throw new AppError(404, 'not_found', 'Order not found');
  const note = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : 'admin';
  const now = iso(membersRuntime.now());
  if (action === 'grant') {
    if (order.status === 'paid') throw new AppError(409, 'already_paid', 'Order is already paid');
    await d1.prepare("UPDATE course_orders SET status = 'paid', paid_at = COALESCE(paid_at, ?), attention_reason = ?, updated_at = ? WHERE id = ?")
      .bind(now, `admin_grant:${note}`, now, order.id).run();
    await fulfilCourseOrder(d1, env, { ...order, status: 'paid', paid_at: order.paid_at ?? now });
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
