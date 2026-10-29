/**
 * Provider-specific entry points for course payments: SePay ZSC transfers (webhook and
 * reconciliation) and Dodo one-time payments, refunds and disputes.
 */
import type { D1DatabaseLike, SqlCondition } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { needsAttentionEvent, queuePaymentFailed } from '../analytics/commerce-events';
import { outboxInsertStatement } from '../analytics/outbox';
import type { Row } from '../members/runtime';
import { iso, membersRuntime } from '../members/runtime';
import { activityStatement } from '../members/users';
import { DODO_DISPUTE_FUNDS_KEPT, DODO_DISPUTE_FUNDS_LOST, minorUnitsOrNull } from '../payments/dodo';
import type { CourseOrder } from './course-orders';
import { getCourseOrderByCode, rowToCourseOrder } from './course-orders';
import { getCourseById } from './course-store';
import type { CourseEventGate, CoursePaymentEvent, CoursePaymentOutcome } from './course-order-payments';
import {
  chargeBackLostCourseOrder, courseDisputeResolvedEarly, courseDisputesPaired, coursePaymentEventRecorded, coursePaymentEventStatement, fulfilCourseOrder,
  isPartialCourseReversal, isPaymentEventConflict,
  markCourseOrderAttention, recordCoursePaymentEvent, refundCourseOrder, restoreCourseOrder, resumeCourseOrderFollowUps, reverseCourseOrder,
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

/** A Dodo payment other than the order's own, captured on an order already refunded or charged back. */
export interface NewCourseCapture {
  payment_id: string;
  amount: number | null;
  currency: string | null;
  reason: 'payment_after_refund' | 'payment_after_dispute';
}

export interface CoursePaymentResult {
  outcome: CoursePaymentOutcome;
  order_code: string | null;
  /** Set when the event is a new capture on a closed order: the admin notice names this payment, not the order's. */
  new_capture?: NewCourseCapture;
}

/** What an event handler applied: an outcome, or an outcome with the new capture it found. */
type AppliedCoursePayment = CoursePaymentOutcome | { outcome: CoursePaymentOutcome; new_capture: NewCourseCapture };

/** Bank booking time clamped to [order creation, now]; falls back to now. */
function paymentTimeMs(order: CourseOrder, transactedAt: number | null | undefined, nowMs: number): number {
  if (typeof transactedAt !== 'number' || !Number.isFinite(transactedAt)) return nowMs;
  return Math.min(nowMs, Math.max(Date.parse(order.created_at), transactedAt));
}

/**
 * Runs a course payment event once. Its `payment_events` record is never written up front: `apply` writes it through
 * `gate` exactly once, as the first statement of the batch that pays or flags the order, or alone when the event changes
 * nothing. A failure or a worker crash before that commit leaves no record, so the provider's redelivery applies the
 * event once, and a record is never deleted. A redelivery after the commit is found by the read below; if the receipt of
 * the order it paid is still missing (the worker died after the batch), the follow-ups run again. A delivery racing
 * this one fails on the record's unique key: its batch rolled back, so nothing was written twice.
 */
async function applyCoursePaymentEvent(
  d1: D1DatabaseLike, env: RuntimeEnv, order: CourseOrder | null, event: CoursePaymentEvent, payerText: string | null,
  apply: (gate: CourseEventGate) => Promise<AppliedCoursePayment>,
): Promise<CoursePaymentResult> {
  const result = (applied: AppliedCoursePayment): CoursePaymentResult => typeof applied === 'string'
    ? { outcome: applied, order_code: order?.code ?? null }
    : { outcome: applied.outcome, order_code: order?.code ?? null, new_capture: applied.new_capture };
  if (await coursePaymentEventRecorded(d1, event.provider, event.eventId)) {
    if (order) await resumeCourseOrderFollowUps(d1, env, order, payerText);
    return result('duplicate_event');
  }
  try {
    return result(await apply(onlyIf => coursePaymentEventStatement(d1, event, onlyIf)));
  } catch (err) {
    if (isPaymentEventConflict(err) && await coursePaymentEventRecorded(d1, event.provider, event.eventId)) return result('duplicate_event');
    throw err;
  }
}

/**
 * Full, on-time payment of a pending SePay order pays it; anything else is flagged for the admin. SePay's transaction
 * id (`eventId`, the same on every redelivery and on reconciliation) is the idempotency key of the `payment_events`
 * record, so a transfer is applied once.
 */
export async function applyCourseSepayPayment(d1: D1DatabaseLike, env: RuntimeEnv, n: CourseTransferNotice): Promise<CoursePaymentResult> {
  const order = await getCourseOrderByCode(d1, n.orderCode);
  const event: CoursePaymentEvent = { provider: 'sepay', eventId: n.eventId, orderId: order?.id ?? null, amount: n.amount, currency: 'VND', rawType: n.rawType };
  return applyCoursePaymentEvent(d1, env, order, event, n.payerText ?? null, async gate => {
    if (!order) {
      await gate().run();
      return 'unmatched';
    }
    const extra = { amount: n.amount, currency: 'VND', ref: n.paymentRef, eventId: n.eventId };
    if (order.status === 'paid') {
      await d1.batch([
        gate(),
        d1.prepare("UPDATE course_orders SET attention_reason = COALESCE(attention_reason, 'duplicate_payment'), updated_at = ? WHERE id = ?")
          .bind(iso(membersRuntime.now()), order.id),
      ]);
      return 'already_paid';
    }
    const nowMs = membersRuntime.now();
    const paidIso = iso(paymentTimeMs(order, n.transactedAt, nowMs));
    const payable = order.provider === 'sepay' && (order.status === 'pending' || (order.status === 'expired' && order.attention_reason === null));
    if (!payable || order.expires_at < paidIso) {
      await markCourseOrderAttention(d1, order, order.status === 'needs_attention' ? (order.attention_reason ?? 'additional_payment') : 'late_payment', extra, gate);
      return 'needs_attention';
    }
    if (order.amount_vnd === null || n.amount < order.amount_vnd) {
      await markCourseOrderAttention(d1, order, 'underpaid', extra, gate);
      return 'needs_attention';
    }
    if (!(await getCourseById(d1, order.course_id))) {
      // The course was deleted after checkout: the money is recorded on the order for a refund, and nothing is granted.
      await markCourseOrderAttention(d1, order, 'course_missing', extra, gate);
      return 'needs_attention';
    }
    const nowIso = iso(nowMs);
    const paid = await fulfilCourseOrder(d1, env, { ...order, status: 'paid', paid_at: nowIso, amount_paid: n.amount, currency_paid: 'VND' }, {
      set: "status = 'paid', paid_at = ?, amount_paid = ?, currency_paid = 'VND', payment_ref = ?, provider_event_id = ?, updated_at = ?",
      values: [nowIso, n.amount, n.paymentRef, n.eventId, nowIso],
      when: "o.status = 'pending' OR (o.status = 'expired' AND o.attention_reason IS NULL)",
    }, n.payerText ?? null, gate);
    if (paid) return 'paid';
    // The order changed since it was read; the payment batch wrote nothing, its record included.
    const current = await getCourseOrderByCode(d1, order.code);
    if (current?.status === 'paid') {
      await gate().run();
      return 'already_paid';
    }
    if (current) await markCourseOrderAttention(d1, current, 'late_payment', extra, gate);
    else await gate().run();
    return 'needs_attention';
  });
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

/** An opened dispute and every funds-lost outcome take access away; the outcomes that keep the money give it back. */
const DISPUTE_REVOKE = new Set(['dispute.opened', ...DODO_DISPUTE_FUNDS_LOST]);

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

  const amount = typeof d.total_amount === 'number' ? d.total_amount : minorUnitsOrNull(d.amount);
  const currency = text(d, 'currency')?.toUpperCase() ?? null;
  if (order && (type === 'refund.succeeded' || DISPUTE_REVOKE.has(type) || DODO_DISPUTE_FUNDS_KEPT.has(type))) {
    return applyGatedDodoCourseEvent(d1, env, order, { provider: 'dodo', eventId, orderId: order.id, amount, currency, rawType: type });
  }
  const event: CoursePaymentEvent = { provider: 'dodo', eventId, orderId: order?.id ?? null, amount, currency, rawType: type };
  return applyCoursePaymentEvent(d1, env, order, event, null, async gate => {
    if (order && type === 'payment.succeeded') return applyDodoCoursePayment(d1, env, order, { paymentId, amount, currency, eventId, userMismatch }, gate);
    if (order && type === 'payment.failed') {
      // Once per payment (its dedupe key), so queueing it again on a redelivery is safe; it never throws.
      await queuePaymentFailed(d1, {
        distinctId: order.user_id, provider: 'dodo', orderType: 'course', reference: paymentId ?? eventId, amountMinor: amount, currency,
      });
    }
    await gate().run();
    return order ? 'ignored' : 'unmatched';
  });
}

/**
 * A refund or a dispute: one that takes access away, or a won or cancelled one that gives it back. Its
 * `payment_events` record is not written up front: it is the first statement of the batch that applies the reversal or
 * the restore (`gate`), so a failure or a worker crash before that batch commits leaves no record and Dodo's
 * redelivery applies it once. A redelivery after the commit is found by the read below, or, when it races the first
 * delivery, fails on the record's unique key and writes nothing. When no batch applies, the record is written alone,
 * so a later redelivery is still a duplicate.
 */
async function applyGatedDodoCourseEvent(d1: D1DatabaseLike, env: RuntimeEnv, order: CourseOrder, event: CoursePaymentEvent): Promise<CoursePaymentResult> {
  const result = (outcome: CoursePaymentOutcome): CoursePaymentResult => ({ outcome, order_code: order.code });
  if (await coursePaymentEventRecorded(d1, 'dodo', event.eventId)) return result('duplicate_event');
  const gate: CourseEventGate = onlyIf => coursePaymentEventStatement(d1, event, onlyIf);
  const { rawType: type, amount, currency } = event;
  const moneyBack = { amountMinor: amount, currency };
  try {
    if (type === 'refund.succeeded') {
      // Any refund, even a partial one, revokes access for good; the reason records whether it was partial, so a later
      // chargeback is still counted. A refund while a dispute is open moves the charged-back order to refunded, so a won
      // or cancelled dispute no longer restores it.
      const reason = isPartialCourseReversal(order, amount) ? 'dodo_partial_refund' : 'dodo_refund';
      if (await refundCourseOrder(d1, order, reason, 'system', moneyBack, gate)) return result('reversed');
    } else if (DODO_DISPUTE_FUNDS_KEPT.has(type)) {
      // Only a charged-back order is restored; one refunded meanwhile stays revoked. Before its opened event the order
      // is still paid: the outcome is only recorded, and the late opened event then finds it.
      const restored = await restoreCourseOrder(d1, env, order, type, gate);
      if (restored) return result(restored);
    } else {
      const lost = DODO_DISPUTE_FUNDS_LOST.has(type);
      // A late `dispute.opened` of a dispute already won or cancelled takes nothing away; the check is also part of the
      // batch guard, so an outcome racing this event is seen either way.
      const opened = type === 'dispute.opened';
      const settled = opened && await courseDisputeResolvedEarly(d1, order.id);
      // A funds-lost outcome on a paid order reports the chargeback in the same batch as the reversal.
      if (!settled && await reverseCourseOrder(d1, order, 'charged_back', type, 'system', moneyBack, lost, gate, opened ? courseDisputesPaired(order.id) : undefined)) {
        return result('reversed');
      }
      if (lost) {
        // Usually already charged back by `dispute.opened`: the record and the chargeback report are one batch.
        await chargeBackLostCourseOrder(d1, order, moneyBack, gate);
        return result('ignored');
      }
    }
    // Nothing applied: the event is still recorded as handled.
    return result((await recordCoursePaymentEvent(d1, 'dodo', event.eventId, event.orderId, amount, currency, type)) ? 'ignored' : 'duplicate_event');
  } catch (err) {
    // A delivery racing this one committed the record first; this batch rolled back, so nothing was written twice.
    if (isPaymentEventConflict(err) && await coursePaymentEventRecorded(d1, 'dodo', event.eventId)) return result('duplicate_event');
    throw err;
  }
}

type DodoCoursePayment = { paymentId: string | null; amount: number | null; currency: string | null; eventId: string; userMismatch: boolean };

/** Orders whose money went back or is contested: a payment never pays them again, only a won dispute restores one. */
const isSettled = (order: CourseOrder) => order.status === 'refunded' || order.status === 'charged_back';
const SETTLED_SQL = "o.status IN ('refunded', 'charged_back')";

/**
 * A `payment.succeeded` for an order already refunded or charged back: Dodo delivered it late, out of order, or again
 * under a new event id. Nothing is paid or granted, and the order keeps its status, so the refund and dispute flows
 * still find it as they left it. The event is recorded once. A payment id other than the order's is a new capture on
 * a closed order: the record, the activity log and the `payment_needs_attention` event are one batch, and the result
 * carries the capture so the admin notice names it; the admin refunds it in Dodo or decides otherwise.
 *
 * The capture is flagged once per payment id, not per event: its activity log is the durable marker (the analytics event
 * shares the payment id as its dedupe key), so a redelivery under another event id is only recorded and announced to
 * nobody. Two such deliveries racing each other can both pass the read; the batch guard still logs the capture once,
 * but both may announce it.
 */
async function settledCoursePayment(d1: D1DatabaseLike, order: CourseOrder, p: DodoCoursePayment, gate: CourseEventGate): Promise<AppliedCoursePayment> {
  // Without a payment id the event cannot name another capture: it is taken as the order's own payment.
  if (!p.paymentId || p.paymentId === order.provider_payment_id) {
    await gate().run();
    return 'ignored';
  }
  const unflagged: SqlCondition = {
    sql: "NOT EXISTS (SELECT 1 FROM user_activity WHERE user_id = ? AND action = 'courses.order_attention' AND json_extract(detail, '$.payment_id') = ?)",
    params: [order.user_id, p.paymentId],
  };
  if (await d1.prepare(`SELECT 1 AS flagged WHERE NOT (${unflagged.sql})`).bind(...unflagged.params).first()) {
    await gate().run();
    return 'ignored';
  }
  const reason = order.status === 'refunded' ? 'payment_after_refund' : 'payment_after_dispute';
  const attention = outboxInsertStatement(d1, needsAttentionEvent({
    distinctId: order.user_id, provider: 'dodo', orderType: 'course', reference: p.paymentId, reason, amountMinor: p.amount ?? undefined, currency: p.currency,
  }));
  await d1.batch([
    gate(),
    ...(attention ? [attention] : []),
    activityStatement(d1, order.user_id, 'courses.order_attention', { code: order.code, reason, amount: p.amount, payment_id: p.paymentId }, undefined, unflagged),
  ]);
  return { outcome: 'needs_attention', new_capture: { payment_id: p.paymentId, amount: p.amount, currency: p.currency, reason } };
}

async function applyDodoCoursePayment(d1: D1DatabaseLike, env: RuntimeEnv, order: CourseOrder, p: DodoCoursePayment, gate: CourseEventGate): Promise<AppliedCoursePayment> {
  if (order.status === 'paid') {
    await gate().run();
    return 'already_paid';
  }
  if (isSettled(order)) return settledCoursePayment(d1, order, p, gate);
  /** The order as it is after a batch that wrote nothing: a refund or a dispute may have closed it meanwhile. */
  const settledMeanwhile = async () => {
    const current = await getCourseOrderByCode(d1, order.code);
    return current && isSettled(current) ? current : null;
  };
  const extra = { amount: p.amount ?? 0, currency: p.currency ?? undefined, ref: p.paymentId, eventId: p.eventId };
  // Another account's checkout, a SePay order, a USD charge below the quote (tampered or misconfigured checkout), or a
  // course deleted since checkout: the card money is captured, so the order is flagged with its payment id for a grant
  // or a Dodo refund.
  const reason = p.userMismatch ? 'user_mismatch'
    : order.provider !== 'dodo' ? 'provider_mismatch'
      : p.currency === 'USD' && (p.amount ?? 0) < order.amount_usd_cents ? 'underpaid'
        : !(await getCourseById(d1, order.course_id)) ? 'course_missing' : null;
  if (reason) {
    // The payment id lands in the same batch as the flag, so a later refund always finds the order.
    // A refund or a dispute closing the order meanwhile makes the flag batch write nothing, its record included.
    const open: SqlCondition = { sql: `NOT EXISTS (SELECT 1 FROM course_orders o WHERE o.id = ? AND ${SETTLED_SQL})`, params: [order.id] };
    const paymentId = p.paymentId
      ? [d1.prepare(`UPDATE course_orders SET provider_payment_id = COALESCE(provider_payment_id, ?) WHERE id = ? AND ${open.sql}`).bind(p.paymentId, order.id, ...open.params)]
      : [];
    if (!(await markCourseOrderAttention(d1, order, reason, extra, gate, paymentId, open))) {
      // A closed order made the whole batch write nothing, its record included: that path records it. An order paid
      // meanwhile (by another delivery, or a dispute opened and won) only skipped the flag: the record, guarded by
      // `open` alone, is already written, so it is not written again.
      const settled = await settledMeanwhile();
      if (settled) return settledCoursePayment(d1, settled, p, gate);
    }
    return 'needs_attention';
  }
  const nowIso = iso(membersRuntime.now());
  // Card money is captured: pay even an expired or flagged order rather than lose the payment, but never one refunded
  // or charged back, also when the refund or the dispute lands while this batch runs.
  const paid = await fulfilCourseOrder(d1, env, { ...order, status: 'paid', paid_at: nowIso, amount_paid: p.amount, currency_paid: p.currency, provider_payment_id: p.paymentId }, {
    set: "status = 'paid', paid_at = ?, amount_paid = ?, currency_paid = ?, provider_payment_id = ?, payment_ref = ?, provider_event_id = ?, updated_at = ?",
    values: [nowIso, p.amount, p.currency, p.paymentId, p.paymentId, p.eventId, nowIso],
    when: `o.status <> 'paid' AND NOT (${SETTLED_SQL})`,
  }, null, gate);
  if (paid) return 'paid';
  // Paid by another delivery, refunded or disputed meanwhile: the payment batch wrote nothing, its record included.
  const settled = await settledMeanwhile();
  if (settled) return settledCoursePayment(d1, settled, p, gate);
  await gate().run();
  return 'already_paid';
}
