import type { D1DatabaseLike } from '../../db/store';
import type { Row } from '../members/runtime';
import { DAY_MS, iso, membersRuntime, num, str, strOrNull } from '../members/runtime';
import { getReferralProfile, normalizeEmailForSelfCheck } from './codes';
import { accountMailboxes, isEligibleReferee, isSelfReferral } from './eligibility';
import type { ReferralFraudSnapshot } from './fraud';
import { payerTextMatches } from './fraud';

/** How far back the referrer's sign-in IPs are compared with the referee's signup IP. */
const SHARED_IP_LOOKBACK_DAYS = 90;

export interface FraudSignalInput {
  referrerUserId: string;
  refereeUserId: string | null;
  refereeEmail: string | null;
  /** The order/card/booking being paid, ignored by the "previously paid" check. */
  sourceId: string;
  /** Free-form payer text: SePay transfer content (payer name or account) or the PayPal payer's name. */
  payerText?: string | null;
  /** Payer's email as reported by the provider (PayPal). */
  payerEmail?: string | null;
  /** Route to admin review regardless of the soft signals (bookings). */
  manualReview?: boolean;
}

/**
 * Whether the referee's binding IP hash (signup link or checkout code entry) equals an IP the referrer used:
 * a magic-link request, a member session opened at sign-in (covers Google/GitHub logins), or their own binding.
 */
async function sharedSignupIp(d1: D1DatabaseLike, referrerUserId: string, refereeUserId: string | null): Promise<boolean> {
  if (!refereeUserId) return false;
  const referee = await d1.prepare('SELECT referral_signup_ip_hash FROM users WHERE id = ?').bind(refereeUserId).first<Row>();
  const hash = referee ? strOrNull(referee, 'referral_signup_ip_hash') : null;
  if (!hash) return false;
  const since = iso(membersRuntime.now() - SHARED_IP_LOOKBACK_DAYS * DAY_MS);
  const hit = await d1.prepare(
    `SELECT 1 FROM login_tokens WHERE ip_hash = ? AND created_at >= ?
       AND (user_id = ? OR email = (SELECT email FROM users WHERE id = ?))
     UNION ALL
     SELECT 1 FROM member_sessions WHERE user_id = ? AND ip_hash = ? AND created_at >= ?
     UNION ALL
     SELECT 1 FROM users WHERE id = ? AND referral_signup_ip_hash = ?
     LIMIT 1`
  ).bind(hash, since, referrerUserId, referrerUserId, referrerUserId, hash, since, referrerUserId, hash).first<Row>();
  return hit !== null;
}

/**
 * Whether the payer looks like the referrer: the payer text names the payout account holder or contains the
 * account number, or the payer's email is one of the referrer's mailboxes (account, OAuth identities) or
 * their PayPal payout email.
 */
async function payerMatchesReferrer(
  d1: D1DatabaseLike, referrerUserId: string, payerText: string | null | undefined, payerEmail: string | null | undefined,
): Promise<boolean> {
  const payout = await d1.prepare('SELECT full_name, bank_account, paypal_email FROM referral_payout_profiles WHERE user_id = ?').bind(referrerUserId).first<Row>();
  if (payerText && payout && payerTextMatches(payerText, { fullName: strOrNull(payout, 'full_name'), bankAccount: strOrNull(payout, 'bank_account') })) {
    return true;
  }
  const canonical = normalizeEmailForSelfCheck(payerEmail);
  if (!canonical) return false;
  if (payout && normalizeEmailForSelfCheck(strOrNull(payout, 'paypal_email')) === canonical) return true;
  return (await accountMailboxes(d1, referrerUserId)).has(canonical);
}

/**
 * Accounts bound to the referrer within 24 hours either side of this referee's binding, so a farm of accounts
 * created together is caught however long they wait before paying. Guests (bookings) have no binding: the
 * 24 hours before now are used instead.
 */
async function boundSignupsAroundReferee(d1: D1DatabaseLike, referrerUserId: string, refereeUserId: string | null): Promise<number> {
  const referee = refereeUserId
    ? await d1.prepare('SELECT referred_at FROM users WHERE id = ? AND referred_by_user_id = ?').bind(refereeUserId, referrerUserId).first<Row>()
    : null;
  const anchor = referee ? Date.parse(str(referee, 'referred_at')) : Number.NaN;
  const [from, to] = Number.isNaN(anchor)
    ? [membersRuntime.now() - DAY_MS, membersRuntime.now()]
    : [anchor - DAY_MS, anchor + DAY_MS];
  const row = await d1.prepare('SELECT COUNT(*) AS n FROM users WHERE referred_by_user_id = ? AND referred_at >= ? AND referred_at <= ?')
    .bind(referrerUserId, iso(from), iso(to)).first<Row>();
  return row ? num(row, 'n') : 0;
}

/** Collects every fact `assessReferral` needs for one paid referred order. */
export async function gatherFraudSnapshot(d1: D1DatabaseLike, input: FraudSignalInput): Promise<ReferralFraudSnapshot> {
  const referee = { userId: input.refereeUserId ?? undefined, email: input.refereeEmail };
  const profile = await getReferralProfile(d1, input.referrerUserId);
  let refereeEmail = input.refereeEmail;
  if (!refereeEmail && input.refereeUserId) {
    const row = await d1.prepare('SELECT email FROM users WHERE id = ?').bind(input.refereeUserId).first<Row>();
    refereeEmail = row ? str(row, 'email') : null;
  }
  return {
    selfReferral: await isSelfReferral(d1, input.referrerUserId, referee),
    refereePreviouslyPaid: !(await isEligibleReferee(d1, { ...referee, excludeSourceId: input.sourceId })),
    referrerLocked: profile?.locked_at != null,
    refereeEmail,
    sharedIp: await sharedSignupIp(d1, input.referrerUserId, input.refereeUserId),
    payerMatchesReferrer: await payerMatchesReferrer(d1, input.referrerUserId, input.payerText, input.payerEmail),
    boundSignupsLast24h: await boundSignupsAroundReferee(d1, input.referrerUserId, input.refereeUserId),
    manualReview: input.manualReview ?? false,
  };
}
