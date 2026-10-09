/**
 * The seam between course orders and the referral program (src/lib/referrals).
 *
 * - An account bound to a referrer gets the referee discount and earns its referrer commission on EVERY
 *   course it buys, as long as the referrer is still active (not locked, not paused), is not the buyer, and
 *   nobody behind the account or mailbox had paid before the binding.
 * - An unbound account follows the program's first-order rule (typed code or `zr_ref` cookie, never paid
 *   before, one discounted checkout open at a time); a typed code binds the account once the order exists.
 * - Paid orders capture a commission on what was actually collected; refunds, chargebacks and disputes
 *   reverse it. Course orders snapshot the referrer, the discount and the commission percent at checkout.
 */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { strOrNull } from '../members/runtime';
import { bindEnteredReferral, parseReferralCodeField, resolveCheckoutReferral } from '../referrals/checkout';
import { getReferralProfile } from '../referrals/codes';
import { captureReferralCommission } from '../referrals/commissions';
import { getReferralSettings } from '../referrals/config';
import { isActiveReferrer, isEligibleBoundReferee, isSelfReferral } from '../referrals/eligibility';
import { effectiveRate, membershipSplit } from '../referrals/rates';
import { reverseCommission } from '../referrals/refunds';
import type { CheckoutReferral } from '../referrals/resolve-checkout-referral';

export interface CourseReferral {
  /** Referee discount percent offered by the referral (0 when none). */
  pct: number;
  referrerUserId: string | null;
  code: string | null;
  /** Referrer commission percent snapshotted on the order (null when no referral applies). */
  commissionPercent: number | null;
  /** Full terms, kept so a typed code can bind the account after the order is stored. */
  terms: CheckoutReferral | null;
}

export const NO_REFERRAL: CourseReferral = { pct: 0, referrerUserId: null, code: null, commissionPercent: null, terms: null };

export interface CourseOrderRef { id: string; code: string; user_id: string; amount_usd_cents: number; referrer_user_id: string | null }

function toCourseReferral(terms: CheckoutReferral | null): CourseReferral {
  if (!terms) return NO_REFERRAL;
  return { pct: terms.discountPercent, referrerUserId: terms.referrerUserId, code: terms.code, commissionPercent: terms.commissionPercent, terms };
}

/** Terms from the account's permanent referrer, or null when unbound or the referrer can no longer earn. */
async function boundReferral(d1: D1DatabaseLike, userId: string): Promise<CheckoutReferral | null | 'unbound'> {
  const user = await d1.prepare('SELECT referred_by_user_id FROM users WHERE id = ? AND deleted_at IS NULL').bind(userId).first<Row>();
  const referrerId = user ? strOrNull(user, 'referred_by_user_id') : null;
  if (!referrerId) return 'unbound';
  const profile = await getReferralProfile(d1, referrerId);
  if (!profile || profile.locked_at) return null;
  if (!(await isActiveReferrer(d1, referrerId))) return null;
  if (await isSelfReferral(d1, referrerId, { userId })) return null;
  if (!(await isEligibleBoundReferee(d1, { userId, referrerUserId: referrerId }))) return null;
  const rate = effectiveRate(profile, await getReferralSettings(d1));
  if (rate <= 0) return null;
  return { referrerUserId: referrerId, code: profile.code, rate, ...membershipSplit(profile.discount_percent, rate), source: 'bound' };
}

export async function resolveCourseReferral(
  d1: D1DatabaseLike, _env: RuntimeEnv, userId: string, body: Record<string, unknown>, request?: Request,
): Promise<CourseReferral> {
  const enteredCode = parseReferralCodeField(body);
  const bound = await boundReferral(d1, userId);
  if (bound !== 'unbound') {
    // A bound account keeps its referrer: a typed code never switches it, and fails only when nothing applies.
    if (!bound && enteredCode) {
      throw new AppError(400, 'referral_code_invalid', 'This referral code cannot be applied to your purchase', { field: 'referral_code' });
    }
    return toCourseReferral(bound);
  }
  return toCourseReferral(await resolveCheckoutReferral(d1, { userId, enteredCode, request, product: 'course' }));
}

/** After the order row exists: a code typed by an unbound member binds them to that referrer for good. */
export async function bindCourseReferral(d1: D1DatabaseLike, env: RuntimeEnv, userId: string, referral: CourseReferral, request?: Request): Promise<void> {
  await bindEnteredReferral(d1, env, userId, referral.terms, request);
}

/** Called after a course order is paid; `captureReferralCommission` never throws into the payment path. */
export async function onCourseOrderPaid(d1: D1DatabaseLike, env: RuntimeEnv, order: CourseOrderRef, payerText: string | null = null): Promise<void> {
  if (!order.referrer_user_id) return;
  await captureReferralCommission(d1, env, { kind: 'course_order', id: order.id, payerText });
}

/** Called after a paid course order is refunded, charged back or disputed. */
export async function onCourseOrderReversed(d1: D1DatabaseLike, order: CourseOrderRef, reason: string): Promise<void> {
  if (!order.referrer_user_id) return;
  await reverseCommission(d1, { sourceKind: 'course_order', sourceId: order.id }, reason);
}
