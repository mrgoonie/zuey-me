import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { parseUsdVndRate } from '../members/plans';
import type { Row } from '../members/runtime';
import { num, numOrNull, str, strOrNull } from '../members/runtime';
import type { CommissionSource } from './commissions';
import { applyPercent } from './rates';

/**
 * Facts read from a paid source row (SePay order, Dodo card, booking, course order) for its commission: who referred whom,
 * the snapshotted commission percent and the base actually collected, in USD cents.
 */
export interface SourceFacts {
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
  payerEmail: string | null;
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

/** Referral snapshot of a source row, or null when it carries no usable one. */
function snapshot(r: Row | null): { referrer: string; percent: number } | null {
  const referrer = r ? strOrNull(r, 'referrer_user_id') : null;
  const percent = r ? numOrNull(r, 'referral_commission_percent') : null;
  return referrer && validPercent(percent) ? { referrer, percent } : null;
}

/** Facts for one source, or null when it is not a paid referred order. Throws when a VND rate is missing. */
export async function sourceFacts(d1: D1DatabaseLike, env: RuntimeEnv, source: CommissionSource, nowIso: string): Promise<SourceFacts | null> {
  if (source.kind === 'billing_order') {
    const r = await d1.prepare('SELECT * FROM billing_orders WHERE id = ?').bind(source.id).first<Row>();
    const s = snapshot(r);
    if (!r || !s || r.status !== 'paid') return null;
    // Commission on what was collected, never on an overpayment beyond the order total.
    const collectedVnd = Math.min(numOrNull(r, 'amount_paid') ?? 0, num(r, 'amount_vnd'));
    const userId = str(r, 'user_id');
    const paidAt = strOrNull(r, 'paid_at') ?? nowIso;
    return {
      referrerUserId: s.referrer, commissionPercent: s.percent, refereeUserId: userId, refereeEmail: await emailOf(d1, userId),
      baseCents: vndToUsdCents(collectedVnd, num(r, 'usd_vnd_rate')), paidAt, holdFrom: paidAt,
      paymentId: strOrNull(r, 'payment_ref'), payerText: source.payerText ?? null, payerEmail: null,
    };
  }
  if (source.kind === 'card_subscription') {
    const r = await d1.prepare('SELECT * FROM card_subscriptions WHERE id = ?').bind(source.id).first<Row>();
    const s = snapshot(r);
    if (!r || !s) return null;
    const userId = strOrNull(r, 'user_id');
    // The stored first-payment time keeps the hold anchored to the charge when the capture is retried later.
    const paidAt = strOrNull(r, 'first_payment_at') ?? nowIso;
    return {
      referrerUserId: s.referrer, commissionPercent: s.percent, refereeUserId: userId,
      refereeEmail: (await emailOf(d1, userId)) ?? strOrNull(r, 'customer_email'),
      baseCents: Math.max(Math.trunc(source.collectedCents), 0), paidAt, holdFrom: paidAt,
      paymentId: source.paymentId, payerText: null, payerEmail: null,
    };
  }
  if (source.kind === 'course_order') {
    const r = await d1.prepare('SELECT * FROM course_orders WHERE id = ?').bind(source.id).first<Row>();
    const s = snapshot(r);
    if (!r || !s || r.status !== 'paid') return null;
    // Commission on what was collected for the order, never on an overpayment or card tax beyond its price.
    let baseCents: number;
    if (r.provider === 'sepay') {
      const collectedVnd = Math.min(numOrNull(r, 'amount_paid') ?? 0, numOrNull(r, 'amount_vnd') ?? 0);
      const rate = numOrNull(r, 'usd_vnd_rate') ?? parseUsdVndRate(env);
      if (rate === null || rate <= 0) throw new AppError(503, 'billing_unconfigured', 'USD_VND_RATE is required to convert a VND course commission');
      baseCents = vndToUsdCents(collectedVnd, rate);
    } else {
      baseCents = Math.min(numOrNull(r, 'amount_paid') ?? 0, num(r, 'amount_usd_cents'));
    }
    const userId = str(r, 'user_id');
    const paidAt = strOrNull(r, 'paid_at') ?? nowIso;
    return {
      referrerUserId: s.referrer, commissionPercent: s.percent, refereeUserId: userId, refereeEmail: await emailOf(d1, userId),
      baseCents: Math.max(baseCents, 0), paidAt, holdFrom: paidAt,
      paymentId: strOrNull(r, 'provider_payment_id') ?? strOrNull(r, 'payment_ref'), payerText: null, payerEmail: null,
    };
  }
  const r = await d1.prepare('SELECT * FROM bookings WHERE id = ?').bind(source.id).first<Row>();
  const s = snapshot(r);
  if (!r || !s || r.status !== 'confirmed') return null;
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
    // The rate snapshotted at hold time; bookings held before that snapshot existed fall back to today's rate.
    const rate = numOrNull(r, 'usd_vnd_rate') ?? parseUsdVndRate(env);
    if (rate === null || rate <= 0) throw new AppError(503, 'billing_unconfigured', 'USD_VND_RATE is required to convert a VND booking commission');
    baseCents = vndToUsdCents(collected, rate);
  }
  return {
    referrerUserId: s.referrer, commissionPercent: s.percent, refereeUserId: null, refereeEmail: strOrNull(r, 'guest_email'),
    baseCents, paidAt: nowIso, holdFrom: str(r, 'slot_end'), paymentId: strOrNull(r, 'payment_ref'),
    payerText: source.payerText ?? null, payerEmail: source.payerEmail ?? null,
  };
}
