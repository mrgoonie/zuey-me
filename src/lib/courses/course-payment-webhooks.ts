/**
 * Provider-specific entry points for course payments: SePay ZSC transfers (webhook and
 * reconciliation) and Dodo one-time payments, refunds and disputes.
 */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import type { Row } from '../members/runtime';
import { iso, membersRuntime } from '../members/runtime';
import type { CourseOrder } from './course-orders';
import { getCourseOrderByCode, rowToCourseOrder } from './course-orders';
import type { CoursePaymentOutcome } from './course-order-payments';
import {
  fulfilCourseOrder, markCourseOrderAttention, recordCoursePaymentEvent, releaseCoursePaymentEvent, restoreCourseOrder, reverseCourseOrder,
} from './course-order-payments';

export interface CourseTransferNotice {
  eventId: string;
  amount: number;
  orderCode: string;
  paymentRef: string | null;
  rawType: string;
  transactedAt?: number | null;
  /** Transfer content (may name the payer): the referral fraud check compares it with the referrer. */
  payerText?: string | null;
}

export interface CoursePaymentResult { outcome: CoursePaymentOutcome; order_code: string | null }

/** Bank booking time clamped to [order creation, now]; falls back to now. */
function paymentTimeMs(order: CourseOrder, transactedAt: number | null | undefined, nowMs: number): number {
  if (typeof transactedAt !== 'number' || !Number.isFinite(transactedAt)) return nowMs;
  return Math.min(nowMs, Math.max(Date.parse(order.created_at), transactedAt));
}

/** Full, on-time payment of a pending SePay order pays it; anything else is flagged for the admin. */
export async function applyCourseSepayPayment(d1: D1DatabaseLike, env: RuntimeEnv, n: CourseTransferNotice): Promise<CoursePaymentResult> {
  const order = await getCourseOrderByCode(d1, n.orderCode);
  if (!(await recordCoursePaymentEvent(d1, 'sepay', n.eventId, order?.id ?? null, n.amount, 'VND', n.rawType))) {
    return { outcome: 'duplicate_event', order_code: order?.code ?? null };
  }
  try {
    if (!order) return { outcome: 'unmatched', order_code: null };
    const extra = { amount: n.amount, currency: 'VND', ref: n.paymentRef, eventId: n.eventId };
    if (order.status === 'paid') {
      await d1.prepare("UPDATE course_orders SET attention_reason = COALESCE(attention_reason, 'duplicate_payment'), updated_at = ? WHERE id = ?")
        .bind(iso(membersRuntime.now()), order.id).run();
      return { outcome: 'already_paid', order_code: order.code };
    }
    const nowMs = membersRuntime.now();
    const paidIso = iso(paymentTimeMs(order, n.transactedAt, nowMs));
    const payable = order.provider === 'sepay' && (order.status === 'pending' || (order.status === 'expired' && order.attention_reason === null));
    if (!payable || order.expires_at < paidIso) {
      await markCourseOrderAttention(d1, order, order.status === 'needs_attention' ? (order.attention_reason ?? 'additional_payment') : 'late_payment', extra);
      return { outcome: 'needs_attention', order_code: order.code };
    }
    if (order.amount_vnd === null || n.amount < order.amount_vnd) {
      await markCourseOrderAttention(d1, order, 'underpaid', extra);
      return { outcome: 'needs_attention', order_code: order.code };
    }
    const nowIso = iso(nowMs);
    const res = await d1.prepare(
      `UPDATE course_orders SET status = 'paid', paid_at = ?, amount_paid = ?, currency_paid = 'VND', payment_ref = ?, provider_event_id = ?, updated_at = ?
       WHERE id = ? AND (status = 'pending' OR (status = 'expired' AND attention_reason IS NULL))`
    ).bind(nowIso, n.amount, n.paymentRef, n.eventId, nowIso, order.id).run();
    if (res.meta?.changes !== 1) {
      const current = await getCourseOrderByCode(d1, order.code);
      if (current?.status === 'paid') return { outcome: 'already_paid', order_code: order.code };
      if (current) await markCourseOrderAttention(d1, current, 'late_payment', extra);
      return { outcome: 'needs_attention', order_code: order.code };
    }
    await fulfilCourseOrder(d1, env, { ...order, status: 'paid', paid_at: nowIso, amount_paid: n.amount, currency_paid: 'VND' }, n.payerText ?? null);
    return { outcome: 'paid', order_code: order.code };
  } catch (err) {
    await releaseCoursePaymentEvent(d1, 'sepay', n.eventId);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Dodo
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(r: Record<string, unknown>, k: string): string | null {
  const v = r[k];
  return typeof v === 'string' && v ? v : null;
}

/** Dispute outcomes that take access away, and those that give it back. */
const DISPUTE_REVOKE = new Set(['dispute.opened', 'dispute.accepted', 'dispute.lost', 'dispute.expired']);
const DISPUTE_RESTORE = new Set(['dispute.won', 'dispute.cancelled']);

async function orderByPaymentId(d1: D1DatabaseLike, paymentId: string): Promise<CourseOrder | null> {
  // Any provider: a card payment landing on a SePay order is flagged but still refundable through Dodo.
  const row = await d1.prepare('SELECT * FROM course_orders WHERE provider_payment_id = ?').bind(paymentId).first<Row>();
  return row ? rowToCourseOrder(row) : null;
}

/**
 * Handles a verified Dodo webhook if it concerns a course order: payments carrying
 * `metadata.course_order`, and refunds or disputes of a course payment. Returns null otherwise so
 * the membership handler can process it.
 */
export async function applyDodoCourseWebhook(d1: D1DatabaseLike, env: RuntimeEnv, eventId: string, payload: unknown): Promise<CoursePaymentResult | null> {
  if (!isRecord(payload) || typeof payload.type !== 'string' || !isRecord(payload.data)) return null;
  const type = payload.type;
  const d = payload.data;
  const paymentId = text(d, 'payment_id');
  let order: CourseOrder | null = null;
  let userMismatch = false;
  if (type === 'payment.succeeded' || type === 'payment.failed') {
    const meta = isRecord(d.metadata) ? d.metadata : {};
    const code = text(meta, 'course_order');
    if (!code) return null;
    order = await getCourseOrderByCode(d1, code);
    userMismatch = order !== null && text(meta, 'user_id') !== order.user_id;
  } else if (type.startsWith('refund.') || type.startsWith('dispute.')) {
    if (!paymentId) return null;
    order = await orderByPaymentId(d1, paymentId);
    if (!order) return null;
  } else {
    return null;
  }

  const amount = typeof d.total_amount === 'number' ? d.total_amount : typeof d.amount === 'number' ? d.amount : null;
  const currency = text(d, 'currency')?.toUpperCase() ?? null;
  if (!(await recordCoursePaymentEvent(d1, 'dodo', eventId, order?.id ?? null, amount, currency, type))) {
    return { outcome: 'duplicate_event', order_code: order?.code ?? null };
  }
  try {
    if (!order) return { outcome: 'unmatched', order_code: null };
    if (type === 'payment.failed') return { outcome: 'ignored', order_code: order.code };
    if (type === 'payment.succeeded') return await applyDodoCoursePayment(d1, env, order, { paymentId, amount, currency, eventId, userMismatch });
    if (type === 'refund.succeeded') {
      return { outcome: (await reverseCourseOrder(d1, order, 'refunded', 'dodo_refund')) ? 'reversed' : 'ignored', order_code: order.code };
    }
    if (DISPUTE_REVOKE.has(type)) {
      return { outcome: (await reverseCourseOrder(d1, order, 'charged_back', type)) ? 'reversed' : 'ignored', order_code: order.code };
    }
    if (DISPUTE_RESTORE.has(type)) {
      return { outcome: (await restoreCourseOrder(d1, env, order, type)) ? 'restored' : 'ignored', order_code: order.code };
    }
    return { outcome: 'ignored', order_code: order.code };
  } catch (err) {
    await releaseCoursePaymentEvent(d1, 'dodo', eventId);
    throw err;
  }
}

async function applyDodoCoursePayment(
  d1: D1DatabaseLike, env: RuntimeEnv, order: CourseOrder,
  p: { paymentId: string | null; amount: number | null; currency: string | null; eventId: string; userMismatch: boolean },
): Promise<CoursePaymentResult> {
  if (order.status === 'paid') return { outcome: 'already_paid', order_code: order.code };
  const extra = { amount: p.amount ?? 0, currency: p.currency ?? undefined, ref: p.paymentId, eventId: p.eventId };
  // Another account's checkout, a SePay order, or a USD charge below the quote (tampered or misconfigured checkout):
  // the card money is captured, so the order is flagged with its payment id for a grant or a Dodo refund.
  const reason = p.userMismatch ? 'user_mismatch'
    : order.provider !== 'dodo' ? 'provider_mismatch'
      : p.currency === 'USD' && (p.amount ?? 0) < order.amount_usd_cents ? 'underpaid' : null;
  if (reason) {
    await markCourseOrderAttention(d1, order, reason, extra);
    if (p.paymentId) {
      await d1.prepare('UPDATE course_orders SET provider_payment_id = COALESCE(provider_payment_id, ?) WHERE id = ?').bind(p.paymentId, order.id).run();
    }
    return { outcome: 'needs_attention', order_code: order.code };
  }
  const nowIso = iso(membersRuntime.now());
  // Card money is captured: pay even an expired or flagged order rather than lose the payment.
  const res = await d1.prepare(
    `UPDATE course_orders SET status = 'paid', paid_at = ?, amount_paid = ?, currency_paid = ?, provider_payment_id = ?, payment_ref = ?,
       provider_event_id = ?, updated_at = ? WHERE id = ? AND status <> 'paid'`
  ).bind(nowIso, p.amount, p.currency, p.paymentId, p.paymentId, p.eventId, nowIso, order.id).run();
  if (res.meta?.changes !== 1) return { outcome: 'already_paid', order_code: order.code };
  await fulfilCourseOrder(d1, env, { ...order, status: 'paid', paid_at: nowIso, amount_paid: p.amount, currency_paid: p.currency, provider_payment_id: p.paymentId });
  return { outcome: 'paid', order_code: order.code };
}
