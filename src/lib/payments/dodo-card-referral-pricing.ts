import type { PlanId } from '../members/plans';
import { getPlan } from '../members/plans';
import { cardFirstChargeCents } from '../referrals/checkout';

/**
 * Card (Dodo) amounts a referral card may legitimately be charged. The referral discount covers the FIRST
 * charge only: renewals are checked against list price. A first charge above the discounted price means the
 * pre-applied Dodo discount code was not honoured, and the referee paid more than they were quoted.
 */
interface ReferralCardTerms {
  referrer_user_id: string | null;
  referral_discount_percent: number | null;
}

function discountPercent(card: ReferralCardTerms): number {
  return card.referrer_user_id && card.referral_discount_percent ? card.referral_discount_percent : 0;
}

/** Smallest acceptable charge: the discounted first-cycle price for a referral card's first charge, else list price. */
export function minimumChargeCents(card: ReferralCardTerms, plan: PlanId, firstCharge: boolean): number {
  const d = firstCharge ? discountPercent(card) : 0;
  return d > 0 ? cardFirstChargeCents(plan, d) : getPlan(plan).price_usd_cents;
}

/** Recurring amounts a subscription event may report: list price, plus the discounted price on first activation. */
export function allowedSubscriptionAmounts(card: ReferralCardTerms, plan: PlanId, firstActivation: boolean): Set<number> {
  return new Set([getPlan(plan).price_usd_cents, minimumChargeCents(card, plan, firstActivation)]);
}

/** True when a referral card's first charge, net of tax, exceeds the discounted price the referee was quoted. */
export function referralDiscountNotApplied(card: ReferralCardTerms, plan: PlanId, chargedNetOfTaxCents: number): boolean {
  return discountPercent(card) > 0 && chargedNetOfTaxCents > minimumChargeCents(card, plan, true);
}
