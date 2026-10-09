import type { D1DatabaseLike } from '../../db/store';
import type { Row } from '../members/runtime';
import { DAY_MS, iso, membersRuntime, num, str, strOrNull } from '../members/runtime';
import { getReferralProfile } from './codes';
import { isEligibleReferee, isSelfReferral } from './eligibility';
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
  /** Free-form bank transfer text (SePay content) that may carry the payer's name or account. */
  payerText?: string | null;
}

async function sharedSignupIp(d1: D1DatabaseLike, referrerUserId: string, refereeUserId: string | null): Promise<boolean> {
  if (!refereeUserId) return false;
  const referee = await d1.prepare('SELECT referral_signup_ip_hash FROM users WHERE id = ?').bind(refereeUserId).first<Row>();
  const hash = referee ? strOrNull(referee, 'referral_signup_ip_hash') : null;
  if (!hash) return false;
  const since = iso(membersRuntime.now() - SHARED_IP_LOOKBACK_DAYS * DAY_MS);
  const hit = await d1.prepare(
    `SELECT 1 FROM login_tokens WHERE ip_hash = ? AND created_at >= ?
       AND (user_id = ? OR email = (SELECT email FROM users WHERE id = ?)) LIMIT 1`
  ).bind(hash, since, referrerUserId, referrerUserId).first<Row>();
  if (hit) return true;
  const own = await d1.prepare('SELECT 1 FROM users WHERE id = ? AND referral_signup_ip_hash = ?').bind(referrerUserId, hash).first<Row>();
  return own !== null;
}

async function payerMatchesReferrer(d1: D1DatabaseLike, referrerUserId: string, payerText: string | null | undefined): Promise<boolean> {
  if (!payerText) return false;
  const payout = await d1.prepare('SELECT full_name, bank_account FROM referral_payout_profiles WHERE user_id = ?').bind(referrerUserId).first<Row>();
  if (!payout) return false;
  return payerTextMatches(payerText, { fullName: strOrNull(payout, 'full_name'), bankAccount: strOrNull(payout, 'bank_account') });
}

async function boundSignupsLast24h(d1: D1DatabaseLike, referrerUserId: string): Promise<number> {
  const row = await d1.prepare('SELECT COUNT(*) AS n FROM users WHERE referred_by_user_id = ? AND referred_at >= ?')
    .bind(referrerUserId, iso(membersRuntime.now() - DAY_MS)).first<Row>();
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
    payerMatchesReferrer: await payerMatchesReferrer(d1, input.referrerUserId, input.payerText),
    boundSignupsLast24h: await boundSignupsLast24h(d1, input.referrerUserId),
  };
}
