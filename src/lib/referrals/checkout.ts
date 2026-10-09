import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { BillingMonths, PlanId } from '../members/plans';
import { BILLING_MONTHS, PLANS, PREPAY_DISCOUNT_PERCENT, getPlan, parseUsdVndRate, prepayUsdCents, prepayVnd } from '../members/plans';
import { ipHash } from '../members/login-tokens';
import { parseVndPrice } from '../payments/sepay';
import { activeReferrerByCode, bindReferrerByCode, readRefCookie } from './attribution';
import { normalizeReferralCode } from './codes';
import { getReferralSettings } from './config';
import { hasPendingReferralCheckout } from './pending-referral-checkout';
import { bookingSplit, effectiveRate, membershipSplit, applyPercent } from './rates';
import type { CheckoutReferral, ReferralProduct } from './resolve-checkout-referral';
import { resolveReferralForCheckout } from './resolve-checkout-referral';

/**
 * Referral pricing at checkout. The server always recomputes the discounted amount from the plan price,
 * the prepay term and the referrer's snapshotted discount; client-sent amounts are never used.
 * The referral discount stacks after the prepay discount.
 */

/** Consultation list price on the USD card rail (PayPal), in cents ($1,999.00); the booking store re-exports it. */
export const BOOKING_PRICE_USD_CENTS = 199_900;

export interface SepayReferralAmounts {
  /** Prepaid totals before the referral discount. */
  beforeUsdCents: number;
  beforeVnd: number;
  /** Amounts the member pays. */
  usdCents: number;
  vnd: number;
}

/** SePay prepaid order amounts: prepay term discount first, then the referral discount (VND keeps 1,000 steps). */
export function sepayReferralAmounts(plan: PlanId, months: BillingMonths, usdVndRate: number, discountPercent: number): SepayReferralAmounts {
  const price = getPlan(plan).price_usd_cents;
  const beforeUsdCents = prepayUsdCents(price, months);
  const beforeVnd = prepayVnd(price, months, usdVndRate);
  return {
    beforeUsdCents,
    beforeVnd,
    usdCents: applyPercent(beforeUsdCents, discountPercent, 'USD'),
    vnd: applyPercent(beforeVnd, discountPercent, 'VND'),
  };
}

/** First card (Dodo) charge after the referral discount, in USD cents. Later renewals are at list price. */
export function cardFirstChargeCents(plan: PlanId, discountPercent: number): number {
  return applyPercent(getPlan(plan).price_usd_cents, discountPercent, 'USD');
}

/**
 * Validates an optional `referral_code` field from an untrusted body. Absent/empty → null; anything that
 * cannot be a referral code → 400 so the buyer sees why no discount was applied.
 */
export function parseReferralCodeField(body: Record<string, unknown>): string | null {
  const raw = body.referral_code;
  if (raw === undefined || raw === null || raw === '') return null;
  const code = normalizeReferralCode(raw);
  if (!code) throw new AppError(400, 'invalid_field', 'referral_code must be 6–16 letters or digits', { field: 'referral_code' });
  return code;
}

/**
 * Resolves the referral for a checkout from the account binding, a typed code and the `zr_ref` cookie.
 * A typed code that cannot apply (unknown, paused, self, previously paid) is a 400 rather than a silent
 * full-price charge; an account already bound to a referrer keeps that referrer. While another discounted
 * checkout of this referee is still open, no referral applies (list price, not an error). A typed code is
 * NOT bound here: call `bindEnteredReferral` once the order or checkout row is persisted.
 */
export async function resolveCheckoutReferral(
  d1: D1DatabaseLike,
  input: { userId?: string; email?: string | null; enteredCode: string | null; request?: Request; product: ReferralProduct },
): Promise<CheckoutReferral | null> {
  if (await hasPendingReferralCheckout(d1, { userId: input.userId, email: input.email })) return null;
  const referral = await resolveReferralForCheckout(d1, {
    userId: input.userId,
    email: input.email,
    enteredCode: input.enteredCode,
    cookieCode: input.request ? readRefCookie(input.request) : null,
    product: input.product,
  });
  if (input.enteredCode && (!referral || referral.source === 'cookie')) {
    throw new AppError(400, 'referral_code_invalid', 'This referral code cannot be applied to your purchase', { field: 'referral_code' });
  }
  return referral;
}

/**
 * After the order or card checkout row exists: a code typed by an unbound member binds them permanently to
 * that referrer, with the hashed client IP for the shared-IP fraud check. No-op for other referral sources.
 */
export async function bindEnteredReferral(
  d1: D1DatabaseLike, env: RuntimeEnv, userId: string, referral: CheckoutReferral | null, request?: Request,
): Promise<void> {
  if (referral?.source !== 'entered') return;
  await bindReferrerByCode(d1, userId, referral.code, request ? await ipHash(env, request) : null);
}

// ---------------------------------------------------------------------------
// Public quote (GET /api/v1/referrals/quote)
// ---------------------------------------------------------------------------

export interface QuotePlanPrice {
  plan: PlanId;
  months: BillingMonths;
  prepay_discount_percent: number;
  amount_usd_cents: number;
  amount_vnd: number | null;
  discounted_usd_cents: number;
  discounted_vnd: number | null;
}

export interface ReferralQuote {
  referral: {
    code: string;
    /** Membership discount (stacks after the prepay discount; card: first month only). */
    discount_percent: number;
    booking_discount_percent: number;
    source: CheckoutReferral['source'];
    /** True when the visitor is anonymous: referee eligibility is checked again at checkout. */
    provisional: boolean;
  } | null;
  /** SePay prepaid totals for every plan and term. */
  plans: QuotePlanPrice[];
  /** Card (Dodo) first monthly charge per plan. */
  card_first_month: { plan: PlanId; amount_usd_cents: number; discounted_usd_cents: number }[];
  booking: { amount_usd_cents: number; discounted_usd_cents: number; amount_vnd: number | null; discounted_vnd: number | null };
}

interface QuoteTerms {
  code: string;
  discountPercent: number;
  bookingDiscountPercent: number;
  source: CheckoutReferral['source'];
  provisional: boolean;
}

/**
 * Terms for the quote. A signed-in member gets the full checkout resolution (binding, eligibility, self
 * checks). An anonymous visitor only learns the referrer's public terms for a live code: whether they are an
 * eligible referee is unknown until they sign in, and checkout re-checks everything.
 */
async function quoteTerms(d1: D1DatabaseLike, input: { userId?: string; enteredCode: string | null; cookieCode: string | null }): Promise<QuoteTerms | null> {
  const settings = await getReferralSettings(d1);
  if (input.userId) {
    // Mirrors checkout: no discount is quoted while another discounted checkout is still open.
    if (await hasPendingReferralCheckout(d1, { userId: input.userId })) return null;
    const r = await resolveReferralForCheckout(d1, { userId: input.userId, enteredCode: input.enteredCode, cookieCode: input.cookieCode, product: 'membership' });
    if (!r) return null;
    const booking = bookingSplit(r.discountPercent, r.rate, settings.booking_rate);
    return { code: r.code, discountPercent: r.discountPercent, bookingDiscountPercent: booking.discountPercent, source: r.source, provisional: false };
  }
  for (const [code, source] of [[input.enteredCode, 'entered'], [input.cookieCode, 'cookie']] as const) {
    const profile = code ? await activeReferrerByCode(d1, code) : null;
    if (!profile) continue;
    const rate = effectiveRate(profile, settings);
    if (rate <= 0) return null;
    const membership = membershipSplit(profile.discount_percent, rate);
    const booking = bookingSplit(profile.discount_percent, rate, settings.booking_rate);
    return { code: profile.code, discountPercent: membership.discountPercent, bookingDiscountPercent: booking.discountPercent, source, provisional: true };
  }
  return null;
}

/** Discounted prices for every plan/term, the card first month and the consultation, for the visitor. */
export async function referralQuote(
  d1: D1DatabaseLike, env: RuntimeEnv, input: { userId?: string; enteredCode: string | null; request: Request },
): Promise<ReferralQuote> {
  const terms = await quoteTerms(d1, { userId: input.userId, enteredCode: input.enteredCode, cookieCode: readRefCookie(input.request) });
  const d = terms?.discountPercent ?? 0;
  const bd = terms?.bookingDiscountPercent ?? 0;
  const rate = parseUsdVndRate(env);
  const plans: QuotePlanPrice[] = [];
  for (const plan of PLANS) {
    for (const months of BILLING_MONTHS) {
      const usd = prepayUsdCents(plan.price_usd_cents, months);
      const vnd = rate === null ? null : prepayVnd(plan.price_usd_cents, months, rate);
      plans.push({
        plan: plan.id,
        months,
        prepay_discount_percent: PREPAY_DISCOUNT_PERCENT[months],
        amount_usd_cents: usd,
        amount_vnd: vnd,
        discounted_usd_cents: applyPercent(usd, d, 'USD'),
        discounted_vnd: vnd === null ? null : applyPercent(vnd, d, 'VND'),
      });
    }
  }
  const vndPrice = parseVndPrice(env);
  return {
    referral: terms ? {
      code: terms.code, discount_percent: d, booking_discount_percent: bd, source: terms.source, provisional: terms.provisional,
    } : null,
    plans,
    card_first_month: PLANS.map(p => ({ plan: p.id, amount_usd_cents: p.price_usd_cents, discounted_usd_cents: cardFirstChargeCents(p.id, d) })),
    booking: {
      amount_usd_cents: BOOKING_PRICE_USD_CENTS,
      discounted_usd_cents: applyPercent(BOOKING_PRICE_USD_CENTS, bd, 'USD'),
      amount_vnd: vndPrice,
      discounted_vnd: vndPrice === null ? null : applyPercent(vndPrice, bd, 'VND'),
    },
  };
}
