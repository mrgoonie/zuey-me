import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import type { Row } from '../members/runtime';
import { DAY_MS, iso, membersRuntime, num, randomId, str, strOrNull } from '../members/runtime';
import { sourceFacts } from './commission-source-facts';
import { getReferralSettings } from './config';
import { assessReferral } from './fraud';
import type { FraudAssessment } from './fraud';
import { gatherFraudSnapshot } from './fraud-signals';
import { logReferralEvent } from './ledger';
import { isSourceReversed } from './source-reversals';

/**
 * One commission per paid referred order, captured from the paid-webhook path. The order's snapshotted
 * terms decide the percent; the base is the amount actually collected, in USD cents. A commission starts
 * `pending` (or `review` / `blocked` from the fraud verdict) and only reaches the ledger when approved.
 */
export type CommissionSourceKind = 'billing_order' | 'card_subscription' | 'booking' | 'course_order';
export type CommissionStatus = 'pending' | 'review' | 'approved' | 'reversed' | 'blocked';

export type CommissionSource =
  /** SePay membership order; `payerText` is the transfer content (may name the payer). */
  | { kind: 'billing_order'; id: string; payerText?: string | null }
  /** Dodo card subscription's first charge; `collectedCents` = total_amount − tax, USD. */
  | { kind: 'card_subscription'; id: string; paymentId: string; collectedCents: number }
  /**
   * Consultation booking (SePay or PayPal). `payerText` is the SePay content or the PayPal payer's name,
   * `payerEmail` the PayPal payer's email.
   */
  | { kind: 'booking'; id: string; payerText?: string | null; payerEmail?: string | null }
  /** Paid course order (SePay ZSC transfer or Dodo one-time card payment); every course a referred account buys. */
  | { kind: 'course_order'; id: string; payerText?: string | null };

export interface ReferralCommission {
  id: string;
  source_kind: CommissionSourceKind;
  source_id: string;
  referrer_user_id: string;
  referee_user_id: string | null;
  referee_email: string | null;
  base_amount_cents: number;
  commission_percent: number;
  commission_cents: number;
  status: CommissionStatus;
  review_reasons: string[];
  hold_until: string;
  provider_payment_id: string | null;
  paid_at: string | null;
  approved_at: string | null;
  reversed_at: string | null;
  created_at: string;
  updated_at: string;
}

const STATUSES: CommissionStatus[] = ['pending', 'review', 'approved', 'reversed', 'blocked'];
const KINDS: CommissionSourceKind[] = ['billing_order', 'card_subscription', 'booking', 'course_order'];

function parseReasons(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function rowToCommission(row: Row): ReferralCommission {
  return {
    id: str(row, 'id'),
    source_kind: KINDS.find(k => k === row.source_kind) ?? 'billing_order',
    source_id: str(row, 'source_id'),
    referrer_user_id: str(row, 'referrer_user_id'),
    referee_user_id: strOrNull(row, 'referee_user_id'),
    referee_email: strOrNull(row, 'referee_email'),
    base_amount_cents: num(row, 'base_amount_cents'),
    commission_percent: num(row, 'commission_percent'),
    commission_cents: num(row, 'commission_cents'),
    status: STATUSES.find(s => s === row.status) ?? 'review',
    review_reasons: parseReasons(strOrNull(row, 'review_reasons')),
    hold_until: str(row, 'hold_until'),
    provider_payment_id: strOrNull(row, 'provider_payment_id'),
    paid_at: strOrNull(row, 'paid_at'),
    approved_at: strOrNull(row, 'approved_at'),
    reversed_at: strOrNull(row, 'reversed_at'),
    created_at: str(row, 'created_at'),
    updated_at: str(row, 'updated_at'),
  };
}

export async function getCommission(d1: D1DatabaseLike, id: string): Promise<ReferralCommission | null> {
  const row = await d1.prepare('SELECT * FROM referral_commissions WHERE id = ?').bind(id).first<Row>();
  return row ? rowToCommission(row) : null;
}

export async function getCommissionBySource(d1: D1DatabaseLike, kind: CommissionSourceKind, sourceId: string): Promise<ReferralCommission | null> {
  const row = await d1.prepare('SELECT * FROM referral_commissions WHERE source_kind = ? AND source_id = ?').bind(kind, sourceId).first<Row>();
  return row ? rowToCommission(row) : null;
}

const STATUS_FOR_VERDICT: Record<FraudAssessment['verdict'], CommissionStatus> = { ok: 'pending', review: 'review', block: 'blocked' };

/**
 * Creates the commission for a paid referred order, at most once per (source kind, source id): a replayed
 * webhook returns the existing row with `created: false`. Orders without a referral snapshot, and orders
 * refunded or cancelled before any commission existed, return null. Booking commissions always start in
 * `review` (guest emails are unverified), unless a hard signal blocks them.
 */
export async function recordReferralCommission(
  d1: D1DatabaseLike, env: RuntimeEnv, source: CommissionSource,
): Promise<{ created: boolean; commission: ReferralCommission | null }> {
  const existing = await getCommissionBySource(d1, source.kind, source.id);
  if (existing) return { created: false, commission: existing };
  const nowMs = membersRuntime.now();
  const nowIso = iso(nowMs);
  if (await isSourceReversed(d1, source.kind, source.id)) return { created: false, commission: null };
  const facts = await sourceFacts(d1, env, source, nowIso);
  if (!facts) return { created: false, commission: null };

  const assessment = assessReferral(await gatherFraudSnapshot(d1, {
    referrerUserId: facts.referrerUserId, refereeUserId: facts.refereeUserId, refereeEmail: facts.refereeEmail,
    sourceId: source.id, payerText: facts.payerText, payerEmail: facts.payerEmail, manualReview: source.kind === 'booking',
    repeatOrdersOfBoundReferee: source.kind === 'course_order',
  }));
  const status = STATUS_FOR_VERDICT[assessment.verdict];
  const { hold_days } = await getReferralSettings(d1);
  const holdFromMs = Date.parse(facts.holdFrom);
  const holdUntil = iso((Number.isNaN(holdFromMs) ? nowMs : holdFromMs) + hold_days * DAY_MS);
  const commissionCents = Math.floor((facts.baseCents * facts.commissionPercent) / 100);
  const id = randomId('rcm');
  const res = await d1.prepare(
    `INSERT INTO referral_commissions (id, source_kind, source_id, referrer_user_id, referee_user_id, referee_email, base_amount_cents,
       commission_percent, commission_cents, status, review_reasons, hold_until, provider_payment_id, paid_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_kind, source_id) DO NOTHING`
  ).bind(
    id, source.kind, source.id, facts.referrerUserId, facts.refereeUserId, facts.refereeEmail, facts.baseCents,
    facts.commissionPercent, commissionCents, status, assessment.reasons.length ? JSON.stringify(assessment.reasons) : null,
    holdUntil, facts.paymentId, facts.paidAt, nowIso, nowIso,
  ).run();
  const commission = await getCommissionBySource(d1, source.kind, source.id);
  const created = res.meta?.changes === 1;
  if (created && commission) {
    await logReferralEvent(d1, {
      actor: 'system', action: `commission.${status}`, subjectUserId: facts.referrerUserId,
      detail: { commission_id: commission.id, source_kind: source.kind, source_id: source.id, commission_cents: commissionCents, reasons: assessment.reasons },
    });
  }
  return { created, commission };
}

/**
 * Payment-path wrapper: a commission failure must never undo or block a confirmed payment (the provider's
 * retry would then hit the already-paid branch). Failures are logged and audited for the admin instead.
 */
export async function captureReferralCommission(d1: D1DatabaseLike, env: RuntimeEnv, source: CommissionSource): Promise<void> {
  try {
    await recordReferralCommission(d1, env, source);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    console.error(`referral commission for ${source.kind} ${source.id} failed: ${message}`);
    await logReferralEvent(d1, { actor: 'system', action: 'commission.failed', detail: { source_kind: source.kind, source_id: source.id, error: message } });
  }
}

/**
 * A rescheduled consultation moves its commission's hold: it ends `hold_days` after the NEW slot end. Only
 * commissions still in their hold (pending or review) move; approved/reversed/blocked ones are final.
 */
export async function rescheduleBookingCommissionHold(d1: D1DatabaseLike, bookingId: string, slotEnd: string): Promise<boolean> {
  const endMs = Date.parse(slotEnd);
  if (Number.isNaN(endMs)) return false;
  const { hold_days } = await getReferralSettings(d1);
  const res = await d1.prepare(
    `UPDATE referral_commissions SET hold_until = ?, updated_at = ?
     WHERE source_kind = 'booking' AND source_id = ? AND status IN ('pending', 'review')`
  ).bind(iso(endMs + hold_days * DAY_MS), iso(membersRuntime.now()), bookingId).run();
  return res.meta?.changes === 1;
}
