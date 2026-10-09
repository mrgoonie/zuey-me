/**
 * The single "Mã ưu đãi" checkout field. `discount_code` (or the older `referral_code`) may hold a promo code
 * or a referral code; promo codes are looked up first (names never collide). Referral and promo discounts never
 * stack: the larger percent wins and a tie goes to the referral, so the referrer still earns on the order.
 */
import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import { parseReferralCodeField } from '../referrals/checkout';
import { normalizeReferralCode } from '../referrals/codes';
import type { PromoCode } from './promo-codes';
import { getPromoByCode } from './promo-codes';

export interface DiscountCodeEntry {
  /** The promo code typed by the buyer (not yet checked for applicability). */
  promo: PromoCode | null;
  /** A typed code that is not a promo code, normalised as a referral code. */
  referralCode: string | null;
  /** Body field the code came from, for error messages. */
  field: 'discount_code' | 'referral_code';
}

/**
 * Reads the typed code. A code in `referral_code` that is not a promo code keeps the referral program's
 * validation (`invalid_field` for a malformed code); in `discount_code` a code that is neither is a 400.
 */
export async function readDiscountCode(d1: D1DatabaseLike, body: Record<string, unknown>): Promise<DiscountCodeEntry> {
  const hasDiscount = body.discount_code !== undefined && body.discount_code !== null && body.discount_code !== '';
  const field = hasDiscount ? 'discount_code' : 'referral_code';
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') return { promo: null, referralCode: null, field };
  if (typeof raw !== 'string' || raw.trim().length > 64) throw new AppError(400, 'invalid_field', `${field} must be a code`, { field });
  const promo = await getPromoByCode(d1, raw);
  if (promo) return { promo, referralCode: null, field };
  if (field === 'referral_code') return { promo: null, referralCode: parseReferralCodeField(body), field };
  const referralCode = normalizeReferralCode(raw);
  if (!referralCode) throw new AppError(400, 'discount_code_invalid', 'This code is not a valid promo or referral code', { field });
  return { promo: null, referralCode, field };
}

/** True when the promo beats the referral discount (strictly larger; ties go to the referral). */
export function promoWins(promoPercent: number | null | undefined, referralPercent: number | null | undefined): boolean {
  return (promoPercent ?? 0) > 0 && (promoPercent ?? 0) > (referralPercent ?? 0);
}
