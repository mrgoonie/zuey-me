import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { parseUsdVndRate } from '../members/plans';
import type { Row } from '../members/runtime';
import { DAY_MS, iso, membersRuntime, num, numOrNull, randomId, str, strOrNull } from '../members/runtime';
import { getReferralSettings } from './config';
import { assessReferral } from './fraud';
import type { FraudAssessment } from './fraud';
import { gatherFraudSnapshot } from './fraud-signals';
import { logReferralEvent } from './ledger';
import { applyPercent } from './rates';

/**
 * One commission per paid referred order, captured from the paid-webhook path. The order's snapshotted
 * terms decide the percent; the base is the amount actually collected, in USD cents. A commission starts
 * `pending` (or `review` / `blocked` from the fraud verdict) and only reaches the ledger when approved.
 */
export type CommissionSourceKind = 'billing_order' | 'card_subscription' | 'booking';
export type CommissionStatus = 'pending' | 'review' | 'approved' | 'reversed' | 'blocked';

export type CommissionSource =
  /** SePay membership order; `payerText` is the transfer content (may name the payer). */
  | { kind: 'billing_order'; id: string; payerText?: string | null }
  /** Dodo card subscription's first charge; `collectedCents` = total_amount − tax, USD. */
  | { kind: 'card_subscription'; id: string; paymentId: string; collectedCents: number }
  /** Consultation booking (SePay or PayPal). */
  | { kind: 'booking'; id: string; payerText?: string | null };

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
const KINDS: CommissionSourceKind[] = ['billing_order', 'card_subscription', 'booking'];

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

/** Facts read from the paid source row: who referred whom, the snapshotted percent and the collected base. */
interface SourceFacts {
  referrerUserId: string;
  commissionPercent: number;
  refereeUserId: string | null;
  refereeEmail: string | null;
  baseCents: number;
  paidAt: string;
  /** Start of the hold: payment time, or the consultation's end for bookings. */
  holdFrom: string;
  paymentId: string | null;
  payerText: string | null;
}

/** VND → USD cents at the given VND-per-USD rate. */
function vndToUsdCents(vnd: number, rate: number): number {
  return Math.round((vnd / rate) * 100);
}

function validPercent(p: number | null): p is number {
  return p !== null && Number.isInteger(p) && p >= 0 && p <= 50;
}

async function emailOf(d1: D1DatabaseLike, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const row = await d1.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first<Row>();
  return row ? str(row, 'email') : null;
}

async function sourceFacts(d1: D1DatabaseLike, env: RuntimeEnv, source: CommissionSource, nowIso: string): Promise<SourceFacts | null> {
  if (source.kind === 'billing_order') {
    const r = await d1.prepare('SELECT * FROM billing_orders WHERE id = ?').bind(source.id).first<Row>();
    const referrer = r ? strOrNull(r, 'referrer_user_id') : null;
    const percent = r ? numOrNull(r, 'referral_commission_percent') : null;
    if (!r || !referrer || !validPercent(percent) || r.status !== 'paid') return null;
    // Commission on what was collected, never on an overpayment beyond the order total.
    const collectedVnd = Math.min(numOrNull(r, 'amount_paid') ?? 0, num(r, 'amount_vnd'));
    const userId = str(r, 'user_id');
    const paidAt = strOrNull(r, 'paid_at') ?? nowIso;
    return {
      referrerUserId: referrer, commissionPercent: percent, refereeUserId: userId, refereeEmail: await emailOf(d1, userId),
      baseCents: vndToUsdCents(collectedVnd, num(r, 'usd_vnd_rate')), paidAt, holdFrom: paidAt,
      paymentId: strOrNull(r, 'payment_ref'), payerText: source.payerText ?? null,
    };
  }
  if (source.kind === 'card_subscription') {
    const r = await d1.prepare('SELECT * FROM card_subscriptions WHERE id = ?').bind(source.id).first<Row>();
    const referrer = r ? strOrNull(r, 'referrer_user_id') : null;
    const percent = r ? numOrNull(r, 'referral_commission_percent') : null;
    if (!r || !referrer || !validPercent(percent)) return null;
    const userId = strOrNull(r, 'user_id');
    return {
      referrerUserId: referrer, commissionPercent: percent, refereeUserId: userId,
      refereeEmail: (await emailOf(d1, userId)) ?? strOrNull(r, 'customer_email'),
      baseCents: Math.max(Math.trunc(source.collectedCents), 0), paidAt: nowIso, holdFrom: nowIso,
      paymentId: source.paymentId, payerText: null,
    };
  }
  const r = await d1.prepare('SELECT * FROM bookings WHERE id = ?').bind(source.id).first<Row>();
  const referrer = r ? strOrNull(r, 'referrer_user_id') : null;
  const percent = r ? numOrNull(r, 'referral_commission_percent') : null;
  if (!r || !referrer || !validPercent(percent) || r.status !== 'confirmed') return null;
  const vnd = r.payment_method === 'sepay';
  const paid = numOrNull(r, 'amount_paid') ?? 0;
  // Owed = the checkout amount, or the snapshotted list price minus the referral discount when the guest
  // paid without opening checkout. Commission never applies to an overpayment.
  const before = numOrNull(r, 'amount_before_referral');
  const owed = numOrNull(r, 'amount_expected') ?? (before === null ? null : applyPercent(before, numOrNull(r, 'referral_discount_percent') ?? 0, vnd ? 'VND' : 'USD'));
  const collected = Math.min(paid, owed ?? paid);
  let baseCents = collected;
  // The rail decides the currency (`currency` stays null when the guest paid without opening checkout).
  if (vnd) {
    // Bookings carry no stored exchange rate, so the VND transfer converts at today's USD_VND_RATE.
    const rate = parseUsdVndRate(env);
    if (rate === null) throw new AppError(503, 'billing_unconfigured', 'USD_VND_RATE is required to convert a VND booking commission');
    baseCents = vndToUsdCents(collected, rate);
  }
  return {
    referrerUserId: referrer, commissionPercent: percent, refereeUserId: null, refereeEmail: strOrNull(r, 'guest_email'),
    baseCents, paidAt: nowIso, holdFrom: str(r, 'slot_end'), paymentId: strOrNull(r, 'payment_ref'), payerText: source.payerText ?? null,
  };
}

const STATUS_FOR_VERDICT: Record<FraudAssessment['verdict'], CommissionStatus> = { ok: 'pending', review: 'review', block: 'blocked' };

/**
 * Creates the commission for a paid referred order, at most once per (source kind, source id): a replayed
 * webhook returns the existing row with `created: false`. Orders without a referral snapshot return null.
 */
export async function recordReferralCommission(
  d1: D1DatabaseLike, env: RuntimeEnv, source: CommissionSource,
): Promise<{ created: boolean; commission: ReferralCommission | null }> {
  const existing = await getCommissionBySource(d1, source.kind, source.id);
  if (existing) return { created: false, commission: existing };
  const nowMs = membersRuntime.now();
  const nowIso = iso(nowMs);
  const facts = await sourceFacts(d1, env, source, nowIso);
  if (!facts) return { created: false, commission: null };

  const assessment = assessReferral(await gatherFraudSnapshot(d1, {
    referrerUserId: facts.referrerUserId, refereeUserId: facts.refereeUserId, refereeEmail: facts.refereeEmail,
    sourceId: source.id, payerText: facts.payerText,
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
