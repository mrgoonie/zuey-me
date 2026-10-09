import type { D1DatabaseLike } from '../../db/store';
import type { Row } from '../members/runtime';
import { strOrNull } from '../members/runtime';
import type { ReferralProfile } from './codes';
import { getReferralProfile, getReferralProfileByCode } from './codes';
import { getReferralSettings } from './config';
import { isActiveReferrer, isEligibleReferee, isSelfReferral } from './eligibility';
import { bookingSplit, effectiveRate, membershipSplit } from './rates';

/** Courses split R like memberships (d / R − d). */
export type ReferralProduct = 'membership' | 'booking' | 'course';

export interface CheckoutReferral {
  referrerUserId: string;
  code: string;
  /** Referrer's rate R at checkout (snapshotted on the order). */
  rate: number;
  discountPercent: number;
  commissionPercent: number;
  /** Where the referrer came from: the account's permanent binding, a code typed at checkout, or the cookie. */
  source: 'bound' | 'entered' | 'cookie';
}

export interface CheckoutReferralInput {
  /** Signed-in member; omitted for booking guests. */
  userId?: string;
  /** Payer email (member email or booking guest email). */
  email?: string | null;
  cookieCode?: string | null;
  enteredCode?: string | null;
  product: ReferralProduct;
}

/**
 * Decides the referral terms for a checkout, or null when none apply. A bound account always uses its
 * referrer (a typed code cannot switch it); otherwise the typed code wins over the cookie. The referrer must
 * be active, the payer must never have paid before and must not be the referrer (account, email or OAuth
 * identity). Memberships split R as d / R − d; bookings share the fixed booking rate in the d/R ratio.
 */
export async function resolveReferralForCheckout(d1: D1DatabaseLike, input: CheckoutReferralInput): Promise<CheckoutReferral | null> {
  let profile: ReferralProfile | null = null;
  let source: CheckoutReferral['source'] = 'bound';
  const user = input.userId
    ? await d1.prepare('SELECT referred_by_user_id FROM users WHERE id = ? AND deleted_at IS NULL').bind(input.userId).first<Row>()
    : null;
  const boundTo = user ? strOrNull(user, 'referred_by_user_id') : null;
  if (boundTo) {
    profile = await getReferralProfile(d1, boundTo);
  } else {
    for (const [code, from] of [[input.enteredCode, 'entered'], [input.cookieCode, 'cookie']] as const) {
      profile = code ? await getReferralProfileByCode(d1, code) : null;
      if (profile) {
        source = from;
        break;
      }
    }
  }
  if (!profile || profile.locked_at) return null;
  if (!(await isActiveReferrer(d1, profile.user_id))) return null;
  if (await isSelfReferral(d1, profile.user_id, { userId: input.userId, email: input.email })) return null;
  if (!(await isEligibleReferee(d1, { userId: input.userId, email: input.email }))) return null;

  const settings = await getReferralSettings(d1);
  const rate = effectiveRate(profile, settings);
  if (rate <= 0) return null;
  const split = input.product === 'booking'
    ? bookingSplit(profile.discount_percent, rate, settings.booking_rate)
    : membershipSplit(profile.discount_percent, rate);
  return { referrerUserId: profile.user_id, code: profile.code, rate, ...split, source };
}
