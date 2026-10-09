/**
 * Pure referral arithmetic. Rates and discounts are whole percents; money is integer minor units.
 * R (the referrer's rate) = max(admin override, tier rate); the referrer gives d of R to the referee
 * as a discount and keeps R − d as commission.
 */
import type { ReferralSettings, ReferralTier } from './config';
import { MAX_REFERRAL_RATE } from './config';

function clampRate(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(Math.max(Math.trunc(v), 0), MAX_REFERRAL_RATE);
}

/** Rate of the highest tier whose `min` the 90-day success count reaches (tiers ascending by `min`). */
export function tierRateFor(count: number, tiers: ReferralTier[]): number {
  let rate = 0;
  for (const tier of tiers) {
    if (count >= tier.min) rate = tier.rate;
    else break;
  }
  return clampRate(rate);
}

/**
 * R = max(admin override, tier rate). The tier is recomputed from the stored 90-day count against the
 * current table, so an admin edit of the tier table takes effect before the daily job refreshes `tier_rate`.
 */
export function effectiveRate(
  profile: { admin_rate_override: number | null; tier_count_90d: number },
  settings: Pick<ReferralSettings, 'tiers'>,
): number {
  return Math.max(clampRate(profile.admin_rate_override ?? 0), tierRateFor(profile.tier_count_90d, settings.tiers));
}

/** The referrer's chosen discount, clamped to [0, R] at use (R may have dropped since it was chosen). */
export function clampDiscount(discount: number, rate: number): number {
  const r = clampRate(rate);
  if (!Number.isFinite(discount)) return 0;
  return Math.min(Math.max(Math.trunc(discount), 0), r);
}

/** Membership split: discount d (clamped to R) for the referee, R − d commission for the referrer. */
export function membershipSplit(discount: number, rate: number): { discountPercent: number; commissionPercent: number } {
  const r = clampRate(rate);
  const d = clampDiscount(discount, r);
  return { discountPercent: d, commissionPercent: r - d };
}

/**
 * Booking split: a fixed `bookingRate` % shared in the referrer's d/R proportion.
 * discount = round(bookingRate · d / R), commission = bookingRate − discount. R = 0 shares nothing.
 */
export function bookingSplit(discount: number, rate: number, bookingRate: number): { discountPercent: number; commissionPercent: number } {
  const r = clampRate(rate);
  const total = clampRate(bookingRate);
  if (r === 0) return { discountPercent: 0, commissionPercent: 0 };
  const d = clampDiscount(discount, r);
  const discountPercent = Math.round((total * d) / r);
  return { discountPercent, commissionPercent: total - discountPercent };
}

/**
 * Amount after a percent discount, in minor units. The discount is rounded down (the payer never gets
 * more than the stated percent): to whole cents for USD, to whole 1,000 VND for VND so prices keep the
 * 1,000-VND rounding of the plan price helpers.
 */
export function applyPercent(amount: number, percent: number, currency: 'USD' | 'VND' = 'USD'): number {
  const a = Math.max(Math.trunc(amount), 0);
  const p = Math.min(Math.max(Math.trunc(percent), 0), 100);
  const raw = (a * p) / 100;
  const discount = currency === 'VND' ? Math.floor(raw / 1000) * 1000 : Math.floor(raw);
  return a - discount;
}

