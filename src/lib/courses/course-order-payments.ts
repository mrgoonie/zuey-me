/**
 * Turning money into ownership and back. SePay transfers (ZSC codes) and Dodo card payments both
 * end in `fulfilCourseOrder`; refunds, chargebacks and admin revokes end in `reverseCourseOrder`.
 * Every provider event is recorded in payment_events first, which makes retries idempotent.
 */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { courseReceiptEmail, sendLoggedEmail } from '../members/email';
import { iso, isUniqueViolation, membersRuntime, siteUrl } from '../members/runtime';
import { getUserById, logActivity } from '../members/users';
import type { CourseOrder } from './course-orders';
import { getCourseOrderByCode } from './course-orders';
import { grantCourse, revokeCourse } from './course-purchases';
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
}

/**
 * Grants the course for a paid order, notifies the referral program and emails a receipt.
 * Referral and email failures are logged and never undo the purchase.
 */
export async function fulfilCourseOrder(d1: D1DatabaseLike, env: RuntimeEnv, order: CourseOrder): Promise<void> {
  const granted = await grantCourse(d1, { userId: order.user_id, courseId: order.course_id, orderId: order.id, source: 'purchase' });
  if (!granted) {
    // Bought twice (two open checkouts paid): keep the money traceable for a manual refund.
    await d1.prepare("UPDATE course_orders SET attention_reason = COALESCE(attention_reason, 'already_owned'), updated_at = ? WHERE id = ?")
      .bind(iso(membersRuntime.now()), order.id).run();
  }
  await logActivity(d1, order.user_id, 'courses.order_paid', { code: order.code, course_id: order.course_id, provider: order.provider });
  try {
    await onCourseOrderPaid(d1, env, order);
  } catch (err) {
    console.error(`referral capture for ${order.code} failed:`, err instanceof Error ? err.message : 'unknown');
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

/** Marks a paid order refunded or charged back, revokes access and reverses referral commission. */
export async function reverseCourseOrder(d1: D1DatabaseLike, order: CourseOrder, kind: ReversalKind, reason: string, actor = 'system'): Promise<boolean> {
  const res = await d1.prepare(`UPDATE course_orders SET status = ?, attention_reason = ?, updated_at = ? WHERE id = ? AND status IN ('paid', 'needs_attention')`)
    .bind(kind, reason.slice(0, 200), iso(membersRuntime.now()), order.id).run();
  if (!res.meta?.changes) return false;
  // Only revoke when this order is the one that granted access (a duplicate purchase leaves the original intact).
  const purchase = await d1.prepare("SELECT order_id FROM course_purchases WHERE user_id = ? AND course_id = ? AND status = 'active'")
    .bind(order.user_id, order.course_id).first<{ order_id: string | null }>();
  if (purchase && purchase.order_id === order.id) {
    await revokeCourse(d1, { userId: order.user_id, courseId: order.course_id, reason: `${kind}:${reason}`, actor });
  }
  try {
    await onCourseOrderReversed(d1, order, kind);
  } catch (err) {
    console.error(`referral reversal for ${order.code} failed:`, err instanceof Error ? err.message : 'unknown');
  }
  await logActivity(d1, order.user_id, `courses.order_${kind}`, { code: order.code, reason, actor });
  return true;
}

/** A dispute the merchant won: the order is paid again and access returns. */
export async function restoreCourseOrder(d1: D1DatabaseLike, env: RuntimeEnv, order: CourseOrder, reason: string): Promise<boolean> {
  const res = await d1.prepare("UPDATE course_orders SET status = 'paid', attention_reason = ?, updated_at = ? WHERE id = ? AND status = 'charged_back'")
    .bind(reason, iso(membersRuntime.now()), order.id).run();
  if (!res.meta?.changes) return false;
  await fulfilCourseOrder(d1, env, { ...order, status: 'paid' });
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
