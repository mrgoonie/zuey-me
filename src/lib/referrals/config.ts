import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { num, nowIso, str } from '../members/runtime';

/** One rung of the rate table: referrers with at least `min` successful referrals in 90 days earn `rate` %. */
export interface ReferralTier {
  min: number;
  rate: number;
}

export interface ReferralSettings {
  tiers: ReferralTier[];
  hold_days: number;
  /** Total percent of a booking shared between referee discount and referrer commission. */
  booking_rate: number;
  payout_threshold_cents: number;
  /** Deduction for VN bank payouts ("Thuế TNCN"), basis points. */
  vn_deduction_bp: number;
  /** Deduction for PayPal payouts ("Phí xử lý & thuế"), basis points. */
  paypal_deduction_bp: number;
  cookie_days: number;
  updated_at: string;
}

/** Hard ceiling of any referral rate (tier, override, discount), whole percent. */
export const MAX_REFERRAL_RATE = 50;

export const DEFAULT_TIERS: ReferralTier[] = [
  { min: 0, rate: 20 }, { min: 3, rate: 25 }, { min: 10, rate: 30 }, { min: 25, rate: 40 }, { min: 50, rate: 50 },
];

export const DEFAULT_REFERRAL_SETTINGS: ReferralSettings = {
  tiers: DEFAULT_TIERS,
  hold_days: 30,
  booking_rate: 10,
  payout_threshold_cents: 5000,
  vn_deduction_bp: 1000,
  paypal_deduction_bp: 1800,
  cookie_days: 30,
  updated_at: '',
};

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** Validates a tier table: non-empty, first `min` is 0, strictly ascending `min`, rates 0–50. Null when invalid. */
export function parseTiers(value: unknown): ReferralTier[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return null;
  const tiers: ReferralTier[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || !('min' in item) || !('rate' in item)) return null;
    const { min, rate } = item;
    if (!isInt(min, 0, 1_000_000) || !isInt(rate, 0, MAX_REFERRAL_RATE)) return null;
    if (tiers.length === 0 ? min !== 0 : min <= tiers[tiers.length - 1].min) return null;
    tiers.push({ min, rate });
  }
  return tiers;
}

function parseTiersJson(text: string): ReferralTier[] | null {
  try {
    return parseTiers(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Current program settings; falls back to the defaults when the row is missing or its tier JSON is corrupt. */
export async function getReferralSettings(d1: D1DatabaseLike): Promise<ReferralSettings> {
  const row = await d1.prepare("SELECT * FROM referral_settings WHERE id = 'default'").first<Row>();
  if (!row) return { ...DEFAULT_REFERRAL_SETTINGS };
  const tiers = parseTiersJson(str(row, 'tiers_json'));
  if (!tiers) console.error('referral_settings.tiers_json is invalid; using default tiers');
  return {
    tiers: tiers ?? DEFAULT_TIERS,
    hold_days: num(row, 'hold_days'),
    booking_rate: num(row, 'booking_rate'),
    payout_threshold_cents: num(row, 'payout_threshold_cents'),
    vn_deduction_bp: num(row, 'vn_deduction_bp'),
    paypal_deduction_bp: num(row, 'paypal_deduction_bp'),
    cookie_days: num(row, 'cookie_days'),
    updated_at: str(row, 'updated_at'),
  };
}

/** Integer bounds of every scalar setting an admin may change. */
const SCALAR_BOUNDS = {
  hold_days: [0, 365],
  booking_rate: [0, MAX_REFERRAL_RATE],
  payout_threshold_cents: [0, 10_000_000],
  vn_deduction_bp: [0, 10_000],
  paypal_deduction_bp: [0, 10_000],
  cookie_days: [1, 365],
} as const;

type ScalarKey = keyof typeof SCALAR_BOUNDS;
const SCALAR_KEYS: ScalarKey[] = ['hold_days', 'booking_rate', 'payout_threshold_cents', 'vn_deduction_bp', 'paypal_deduction_bp', 'cookie_days'];

/** Applies a validated partial update (admin). Unknown keys are rejected so typos never pass silently. */
export async function updateReferralSettings(d1: D1DatabaseLike, patch: Record<string, unknown>): Promise<ReferralSettings> {
  const bad = (field: string, msg: string): never => {
    throw new AppError(400, 'invalid_field', `${field} ${msg}`, { field });
  };
  const next = await getReferralSettings(d1);
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    const field = SCALAR_KEYS.find(k => k === key);
    if (key === 'tiers') {
      const tiers = parseTiers(value);
      if (!tiers) bad('tiers', 'must be a non-empty list of {min, rate} with min starting at 0, strictly ascending, and rate 0–50');
      else next.tiers = tiers;
    } else if (field) {
      const [min, max] = SCALAR_BOUNDS[field];
      if (!isInt(value, min, max)) bad(field, `must be an integer between ${min} and ${max}`);
      else next[field] = value;
    } else {
      bad(key, 'is not a referral setting');
    }
    changed = true;
  }
  if (!changed) throw new AppError(400, 'invalid_request', 'Provide at least one setting to change');
  next.updated_at = nowIso();
  await d1.prepare(
    `INSERT INTO referral_settings (id, tiers_json, hold_days, booking_rate, payout_threshold_cents, vn_deduction_bp, paypal_deduction_bp, cookie_days, updated_at)
     VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET tiers_json = excluded.tiers_json, hold_days = excluded.hold_days, booking_rate = excluded.booking_rate,
       payout_threshold_cents = excluded.payout_threshold_cents, vn_deduction_bp = excluded.vn_deduction_bp,
       paypal_deduction_bp = excluded.paypal_deduction_bp, cookie_days = excluded.cookie_days, updated_at = excluded.updated_at`
  ).bind(JSON.stringify(next.tiers), next.hold_days, next.booking_rate, next.payout_threshold_cents, next.vn_deduction_bp,
    next.paypal_deduction_bp, next.cookie_days, next.updated_at).run();
  return next;
}
