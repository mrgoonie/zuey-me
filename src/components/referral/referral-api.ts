// Validated client views of the member referral APIs (`/api/v1/referrals/*`). Money is USD cents.
import { isRecord, numOr, records, str, strOrNull } from '../members/member-ui';

export interface Split { discount: number; commission: number }
export interface Tier { min: number; rate: number }

export interface ReferralCommissionItem {
  id: string;
  source_kind: string;
  referee: string | null;
  base_amount_cents: number;
  commission_percent: number;
  commission_cents: number;
  status: string;
  paid_at: string | null;
  hold_until: string;
}

export interface ReferralPayoutItem {
  id: string;
  period: string;
  method: string;
  gross_cents: number;
  deduction_bp: number;
  deduction_cents: number;
  net_cents: number;
  net_vnd: number | null;
  status: string;
  transaction_ref: string | null;
  paid_at: string | null;
}

export interface ReferralProgram {
  tiers: Tier[];
  hold_days: number;
  booking_rate: number;
  payout_threshold_cents: number;
  vn_deduction_bp: number;
  paypal_deduction_bp: number;
}

export interface ReferralMe {
  eligible: boolean;
  locked: boolean;
  code: string | null;
  link: string | null;
  rate: number;
  admin_rate_override: number | null;
  tier: { count_90d: number; rate: number; window_days: number; next: { min: number; rate: number; remaining: number } | null };
  discount_percent: number;
  membership_split: Split;
  booking_split: Split;
  leaderboard_opt_out: boolean;
  balance: { pending_cents: number; approved_cents: number; processing_cents: number; paid_cents: number };
  commissions: ReferralCommissionItem[];
  payouts: ReferralPayoutItem[];
  payout_profile: { status: string; method: string } | null;
  next_close_date: string;
  program: ReferralProgram;
}

const numOrNull = (r: Record<string, unknown>, k: string): number | null => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? Number(r[k]) : null);

function parseSplit(v: unknown): Split {
  const r = isRecord(v) ? v : {};
  return { discount: numOr(r, 'discount_percent'), commission: numOr(r, 'commission_percent') };
}

export function parseTiers(v: unknown): Tier[] {
  return records(v).map(t => ({ min: numOr(t, 'min'), rate: numOr(t, 'rate') }));
}

export function parseProgram(v: unknown): ReferralProgram {
  const p = isRecord(v) ? v : {};
  return {
    tiers: parseTiers(p.tiers),
    hold_days: numOr(p, 'hold_days', 30),
    booking_rate: numOr(p, 'booking_rate', 10),
    payout_threshold_cents: numOr(p, 'payout_threshold_cents', 5000),
    vn_deduction_bp: numOr(p, 'vn_deduction_bp', 1000),
    paypal_deduction_bp: numOr(p, 'paypal_deduction_bp', 1800),
  };
}

/** `GET/PATCH /api/v1/referrals/me` → view, or null when the payload is not a referral view. */
export function parseReferralMe(v: unknown): ReferralMe | null {
  if (!isRecord(v) || typeof v.eligible !== 'boolean' || !isRecord(v.tier) || !isRecord(v.balance)) return null;
  const tier = v.tier;
  const next = isRecord(tier.next) ? tier.next : null;
  const bal = v.balance;
  const pp = isRecord(v.payout_profile) ? v.payout_profile : null;
  return {
    eligible: v.eligible,
    locked: v.locked === true,
    code: strOrNull(v, 'code'),
    link: strOrNull(v, 'link'),
    rate: numOr(v, 'rate'),
    admin_rate_override: numOrNull(v, 'admin_rate_override'),
    tier: {
      count_90d: numOr(tier, 'count_90d'),
      rate: numOr(tier, 'rate'),
      window_days: numOr(tier, 'window_days', 90),
      next: next ? { min: numOr(next, 'min'), rate: numOr(next, 'rate'), remaining: numOr(next, 'remaining') } : null,
    },
    discount_percent: numOr(v, 'discount_percent'),
    membership_split: parseSplit(v.membership_split),
    booking_split: parseSplit(v.booking_split),
    leaderboard_opt_out: v.leaderboard_opt_out === true,
    balance: {
      pending_cents: numOr(bal, 'pending_cents'),
      approved_cents: numOr(bal, 'approved_cents'),
      processing_cents: numOr(bal, 'processing_cents'),
      paid_cents: numOr(bal, 'paid_cents'),
    },
    commissions: records(v.commissions).map(c => ({
      id: str(c, 'id'), source_kind: str(c, 'source_kind'), referee: strOrNull(c, 'referee'),
      base_amount_cents: numOr(c, 'base_amount_cents'), commission_percent: numOr(c, 'commission_percent'),
      commission_cents: numOr(c, 'commission_cents'), status: str(c, 'status'), paid_at: strOrNull(c, 'paid_at'),
      hold_until: str(c, 'hold_until'),
    })),
    payouts: records(v.payouts).map(p => ({
      id: str(p, 'id'), period: str(p, 'period'), method: str(p, 'method'), gross_cents: numOr(p, 'gross_cents'),
      deduction_bp: numOr(p, 'deduction_bp'), deduction_cents: numOr(p, 'deduction_cents'), net_cents: numOr(p, 'net_cents'),
      net_vnd: numOrNull(p, 'net_vnd'), status: str(p, 'status'), transaction_ref: strOrNull(p, 'transaction_ref'),
      paid_at: strOrNull(p, 'paid_at'),
    })),
    payout_profile: pp ? { status: str(pp, 'status'), method: str(pp, 'method') } : null,
    next_close_date: str(v, 'next_close_date'),
    program: parseProgram(v.program),
  };
}

/** Progress (0–1) from the current tier's threshold to the next one; 1 at the top tier. */
export function tierProgress(count: number, tiers: Tier[]): number {
  const next = tiers.find(t => t.min > count);
  if (!next) return 1;
  const current = [...tiers].reverse().find(t => t.min <= count)?.min ?? 0;
  const span = next.min - current;
  return span > 0 ? Math.min(Math.max((count - current) / span, 0), 1) : 0;
}

export interface PayoutProfile {
  method: 'vn_bank' | 'paypal';
  status: string;
  full_name: string;
  bank_name: string;
  bank_account: string;
  national_id: string;
  address: string;
  paypal_email: string;
  has_id_front: boolean;
  has_id_back: boolean;
  reject_reason: string | null;
}

/** `{profile}` envelope of the payout-profile endpoints; null when the member has none yet. */
export function parsePayoutProfile(v: unknown): PayoutProfile | null {
  const p = isRecord(v) && isRecord(v.profile) ? v.profile : null;
  if (!p) return null;
  return {
    method: p.method === 'paypal' ? 'paypal' : 'vn_bank',
    status: str(p, 'status'),
    full_name: str(p, 'full_name'),
    bank_name: str(p, 'bank_name'),
    bank_account: str(p, 'bank_account'),
    national_id: str(p, 'national_id'),
    address: str(p, 'address'),
    paypal_email: str(p, 'paypal_email'),
    has_id_front: p.has_id_front === true,
    has_id_back: p.has_id_back === true,
    reject_reason: strOrNull(p, 'reject_reason'),
  };
}

export interface LeaderboardRow { rank: number; name: string; referrals: number }

export function parseLeaderboard(v: unknown): LeaderboardRow[] | null {
  if (!isRecord(v) || !Array.isArray(v.entries)) return null;
  return records(v.entries).map(e => ({ rank: numOr(e, 'rank'), name: str(e, 'name'), referrals: numOr(e, 'referrals') }));
}

/** Signed USD amount: `$12.50`, `−$3`. */
export function fmtCents(cents: number): string {
  const abs = Math.abs(cents);
  const body = `$${(abs / 100).toLocaleString('en-US', { minimumFractionDigits: abs % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
  return cents < 0 ? `−${body}` : body;
}

/** Basis points as a percent label: 1000 → `10%`, 1250 → `12.5%`. */
export function fmtBp(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`;
}

/** The last `count` local months (Asia/Saigon, UTC+7 without DST), newest first, as `YYYY-MM`. */
export function recentMonths(nowMs: number, count: number): string[] {
  const d = new Date(nowMs + 7 * 60 * 60 * 1000);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() + 1;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}
