import type { PlanId } from '../members/plans';
import { getPlan } from '../members/plans';
import { cardFirstChargeCents } from '../referrals/checkout';

/**
 * Card (Dodo) amounts a discounted card may legitimately be charged. A referral discount covers the FIRST
 * charge only; a promo code covers its first `promo_cycles` charges. Other charges are checked against list
 * price. A discounted charge above the discounted price means the pre-applied Dodo discount code was not
 * honoured, and the buyer paid more than they were quoted.
 */
interface CardDiscountTerms {
  referrer_user_id: string | null;
  referral_discount_percent: number | null;
  promo_code_id?: string | null;
  promo_discount_percent?: number | null;
  promo_cycles?: number | null;
}

/** Percent off the `cycle`-th charge (1 = first charge) of this card. */
export function cardDiscountPercent(card: CardDiscountTerms, cycle: number): number {
  if (card.promo_code_id && card.promo_discount_percent) return cycle <= (card.promo_cycles ?? 1) ? card.promo_discount_percent : 0;
  if (card.referrer_user_id && card.referral_discount_percent) return cycle === 1 ? card.referral_discount_percent : 0;
  return 0;
}

/** Smallest acceptable charge for the `cycle`-th charge: the discounted price while a discount covers it, else list price. */
export function minimumChargeCents(card: CardDiscountTerms, plan: PlanId, cycle: number): number {
  const d = cardDiscountPercent(card, cycle);
  return d > 0 ? cardFirstChargeCents(plan, d) : getPlan(plan).price_usd_cents;
}

/** Recurring amounts a subscription event may report: list price, plus the discounted price while a discount applies. */
export function allowedSubscriptionAmounts(card: CardDiscountTerms, plan: PlanId, cycle: number): Set<number> {
  return new Set([getPlan(plan).price_usd_cents, minimumChargeCents(card, plan, cycle)]);
}

/** True when a discounted charge, net of tax, exceeds the discounted price the buyer was quoted. */
export function discountNotApplied(card: CardDiscountTerms, plan: PlanId, chargedNetOfTaxCents: number, cycle: number): boolean {
  return cardDiscountPercent(card, cycle) > 0 && chargedNetOfTaxCents > minimumChargeCents(card, plan, cycle);
}
