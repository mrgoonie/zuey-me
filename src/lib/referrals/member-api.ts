import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { iso, membersRuntime, num, siteUrl, str, strOrNull } from '../members/runtime';
import { bindReferrerByCode } from './attribution';
import type { ReferralProfile } from './codes';
import { ensureReferralProfile, getReferralProfile } from './codes';
import type { ReferralSettings, ReferralTier } from './config';
import { getReferralSettings } from './config';
import { isActiveReferrer } from './eligibility';
import { TIER_WINDOW_DAYS } from './jobs';
import { balanceCents, heldCommissionCents, logReferralEvent } from './ledger';
import type { PayoutMethod, PayoutStatus } from './payouts';
import { rowToPayout } from './payouts';
import type { PayoutProfileStatus } from './payout-profiles';
import { getPayoutProfile } from './payout-profiles';
import { bookingSplit, clampDiscount, effectiveRate, membershipSplit, tierRateFor } from './rates';
import { nextCloseDate } from './saigon-calendar';

/** The member's own referral dashboard (`GET /api/v1/referrals/me`). Money is USD cents. */
export interface ReferralMeView {
  /** May share the link now (active plan or admin-enabled, not locked). */
  eligible: boolean;
  locked: boolean;
  code: string | null;
  link: string | null;
  /** R = max(admin override, tier rate). */
  rate: number;
  admin_rate_override: number | null;
  tier: {
    count_90d: number;
    rate: number;
    window_days: number;
    next: { min: number; rate: number; remaining: number } | null;
  };
  /** Saved discount d (0 ≤ d ≤ R); applied clamped to the current R. */
  discount_percent: number;
  membership_split: { discount_percent: number; commission_percent: number };
  booking_split: { discount_percent: number; commission_percent: number };
  leaderboard_opt_out: boolean;
  balance: {
    /** In the hold or under review; not yet payable. */
    pending_cents: number;
    /** Approved and not yet in a payout; negative after a refund of paid-out commission. */
    approved_cents: number;
    /** Closed into a payout that the admin has not paid yet. */
    processing_cents: number;
    paid_cents: number;
  };
  commissions: MemberCommissionView[];
  payouts: MemberPayoutView[];
  payout_profile: { status: PayoutProfileStatus; method: PayoutMethod } | null;
  /** Next day-1 close, local date (Asia/Saigon). */
  next_close_date: string;
  program: Pick<ReferralSettings, 'tiers' | 'hold_days' | 'booking_rate' | 'payout_threshold_cents' | 'vn_deduction_bp' | 'paypal_deduction_bp'>;
}

export interface MemberCommissionView {
  id: string;
  source_kind: string;
  /** Masked, e.g. `la***@gmail.com`. */
  referee: string | null;
  base_amount_cents: number;
  commission_percent: number;
  commission_cents: number;
  status: string;
  paid_at: string | null;
  hold_until: string;
  approved_at: string | null;
  reversed_at: string | null;
}

export interface MemberPayoutView {
  id: string;
  period: string;
  method: PayoutMethod;
  gross_cents: number;
  deduction_bp: number;
  deduction_cents: number;
  net_cents: number;
  net_vnd: number | null;
  status: PayoutStatus;
  transaction_ref: string | null;
  paid_at: string | null;
}

const RECENT_LIMIT = 20;

/** `lan.nguyen@gmail.com` → `la***@gmail.com`. */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

function nextTier(count: number, tiers: ReferralTier[]): { min: number; rate: number; remaining: number } | null {
  const next = tiers.find(t => t.min > count);
  return next ? { min: next.min, rate: next.rate, remaining: next.min - count } : null;
}

function splitView(s: { discountPercent: number; commissionPercent: number }): { discount_percent: number; commission_percent: number } {
  return { discount_percent: s.discountPercent, commission_percent: s.commissionPercent };
}

async function sumPayouts(d1: D1DatabaseLike, userId: string, status: PayoutStatus): Promise<number> {
  const row = await d1.prepare('SELECT COALESCE(SUM(gross_cents), 0) AS total FROM referral_payouts WHERE referrer_user_id = ? AND status = ?')
    .bind(userId, status).first<Row>();
  return Number(row?.total ?? 0);
}

/** The profile to show or edit: created on first use for an eligible referrer, otherwise only if it exists. */
async function profileFor(d1: D1DatabaseLike, userId: string, eligible: boolean): Promise<ReferralProfile | null> {
  return eligible ? ensureReferralProfile(d1, userId) : getReferralProfile(d1, userId);
}

export async function buildReferralMe(d1: D1DatabaseLike, env: RuntimeEnv, userId: string): Promise<ReferralMeView> {
  const [settings, eligible] = await Promise.all([getReferralSettings(d1), isActiveReferrer(d1, userId)]);
  const profile = await profileFor(d1, userId, eligible);
  const count = profile?.tier_count_90d ?? 0;
  const rate = profile ? effectiveRate(profile, settings) : 0;
  const discount = profile?.discount_percent ?? 0;

  const { results: commissionRows } = await d1.prepare(
    'SELECT * FROM referral_commissions WHERE referrer_user_id = ? ORDER BY created_at DESC LIMIT ?'
  ).bind(userId, RECENT_LIMIT).all<Row>();
  const { results: payoutRows } = await d1.prepare(
    'SELECT * FROM referral_payouts WHERE referrer_user_id = ? ORDER BY period DESC LIMIT ?'
  ).bind(userId, RECENT_LIMIT).all<Row>();
  const payoutProfile = await getPayoutProfile(d1, userId);

  return {
    eligible,
    locked: Boolean(profile?.locked_at),
    code: profile?.code ?? null,
    link: profile ? `${siteUrl(env)}/r/${profile.code}` : null,
    rate,
    admin_rate_override: profile?.admin_rate_override ?? null,
    tier: { count_90d: count, rate: tierRateFor(count, settings.tiers), window_days: TIER_WINDOW_DAYS, next: nextTier(count, settings.tiers) },
    discount_percent: discount,
    membership_split: splitView(membershipSplit(discount, rate)),
    booking_split: splitView(bookingSplit(discount, rate, settings.booking_rate)),
    leaderboard_opt_out: profile?.leaderboard_opt_out ?? false,
    balance: {
      pending_cents: await heldCommissionCents(d1, userId),
      approved_cents: await balanceCents(d1, userId),
      processing_cents: await sumPayouts(d1, userId, 'pending'),
      paid_cents: await sumPayouts(d1, userId, 'paid'),
    },
    commissions: (commissionRows ?? []).map(r => ({
      id: str(r, 'id'),
      source_kind: str(r, 'source_kind'),
      referee: maskEmail(strOrNull(r, 'referee_email')),
      base_amount_cents: num(r, 'base_amount_cents'),
      commission_percent: num(r, 'commission_percent'),
      commission_cents: num(r, 'commission_cents'),
      status: str(r, 'status'),
      paid_at: strOrNull(r, 'paid_at'),
      hold_until: str(r, 'hold_until'),
      approved_at: strOrNull(r, 'approved_at'),
      reversed_at: strOrNull(r, 'reversed_at'),
    })),
    payouts: (payoutRows ?? []).map(rowToPayout).map(p => ({
      id: p.id, period: p.period, method: p.method, gross_cents: p.gross_cents, deduction_bp: p.deduction_bp,
      deduction_cents: p.deduction_cents, net_cents: p.net_cents, net_vnd: p.net_vnd, status: p.status,
      transaction_ref: p.transaction_ref, paid_at: p.paid_at,
    })),
    payout_profile: payoutProfile ? { status: payoutProfile.status, method: payoutProfile.method } : null,
    next_close_date: nextCloseDate(membersRuntime.now()),
    program: {
      tiers: settings.tiers, hold_days: settings.hold_days, booking_rate: settings.booking_rate,
      payout_threshold_cents: settings.payout_threshold_cents, vn_deduction_bp: settings.vn_deduction_bp,
      paypal_deduction_bp: settings.paypal_deduction_bp,
    },
  };
}

const ME_FIELDS = ['discount_percent', 'leaderboard_opt_out'];

/** `PATCH me`: the referee discount d (integer, 0 ≤ d ≤ current R) and the leaderboard opt-out. */
export async function updateReferralMe(d1: D1DatabaseLike, env: RuntimeEnv, userId: string, body: Record<string, unknown>): Promise<ReferralMeView> {
  const unknownKey = Object.keys(body).find(k => !ME_FIELDS.includes(k));
  if (unknownKey) throw new AppError(400, 'invalid_field', `${unknownKey} cannot be changed here`, { field: unknownKey });
  if (!ME_FIELDS.some(k => k in body)) throw new AppError(400, 'invalid_request', 'Provide discount_percent and/or leaderboard_opt_out');

  const profile = await profileFor(d1, userId, await isActiveReferrer(d1, userId));
  if (!profile) throw new AppError(403, 'referrer_not_eligible', 'Referral links are available to members with an active plan');
  const settings = await getReferralSettings(d1);
  const rate = effectiveRate(profile, settings);

  let discount = profile.discount_percent;
  if ('discount_percent' in body) {
    const d = body.discount_percent;
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > rate || clampDiscount(d, rate) !== d) {
      throw new AppError(400, 'invalid_field', `discount_percent must be an integer between 0 and your rate ${rate}`, { field: 'discount_percent', max: rate });
    }
    discount = d;
  }
  let optOut = profile.leaderboard_opt_out;
  if ('leaderboard_opt_out' in body) {
    if (typeof body.leaderboard_opt_out !== 'boolean') throw new AppError(400, 'invalid_field', 'leaderboard_opt_out must be a boolean', { field: 'leaderboard_opt_out' });
    optOut = body.leaderboard_opt_out;
  }
  await d1.prepare('UPDATE referral_profiles SET discount_percent = ?, leaderboard_opt_out = ?, updated_at = ? WHERE user_id = ?')
    .bind(discount, optOut ? 1 : 0, iso(membersRuntime.now()), userId).run();
  await logReferralEvent(d1, { actor: userId, action: 'profile.updated', subjectUserId: userId, detail: { discount_percent: discount, leaderboard_opt_out: optOut } });
  return buildReferralMe(d1, env, userId);
}

/** `POST bind`: a signed-in member without a referrer enters a code. */
export async function bindReferralCode(d1: D1DatabaseLike, userId: string, code: unknown, ipHash: string | null = null): Promise<{ bound: true; code: string }> {
  const result = await bindReferrerByCode(d1, userId, code, ipHash);
  if (result.bound) {
    const profile = await getReferralProfile(d1, result.referrerUserId);
    return { bound: true, code: profile?.code ?? String(code).trim().toLowerCase() };
  }
  if (result.reason === 'already_bound') throw new AppError(409, 'referral_already_bound', 'Your account already has a referrer');
  const messages = {
    invalid_code: 'This referral code is not active',
    self_referral: 'You cannot use your own referral code',
    not_eligible: 'Referral codes apply only to accounts that have never paid',
  } as const;
  throw new AppError(400, 'referral_code_invalid', messages[result.reason], { reason: result.reason });
}
