import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import type { Row } from '../members/runtime';
import { normalizeEmailForSelfCheck } from './codes';
import { isEligibleReferee } from './eligibility';
import { recordPaidEmail } from './paid-email-hashes';
import { getStored, toView } from './payout-profiles';

/**
 * Referral side of a member's data export and account deletion. Deletion removes the payout profile (tax
 * identity, bank details) and its national-ID images, and the member's email on commissions where they were
 * the referee. Payouts keep their payee snapshot and the ledger stays intact: both are accounting records.
 */

async function rows(d1: D1DatabaseLike, sql: string, ...params: unknown[]): Promise<Row[]> {
  const { results } = await d1.prepare(sql).bind(...params).all<Row>();
  return results ?? [];
}

/** Referral data for `exportAccount`: profile, payout profile (no image keys), commissions earned and payouts. */
export async function exportReferralData(d1: D1DatabaseLike, userId: string): Promise<Record<string, unknown>> {
  const payoutProfile = await getStored(d1, userId);
  return {
    profile: (await rows(d1,
      'SELECT code, discount_percent, leaderboard_opt_out, tier_rate, tier_count_90d, created_at, updated_at FROM referral_profiles WHERE user_id = ?', userId))[0] ?? null,
    referred_at: (await rows(d1, 'SELECT referred_at FROM users WHERE id = ?', userId))[0]?.referred_at ?? null,
    payout_profile: payoutProfile ? toView(payoutProfile) : null,
    // The referee's email belongs to someone else and is left out.
    commissions: await rows(d1,
      `SELECT id, source_kind, base_amount_cents, commission_percent, commission_cents, status, hold_until, paid_at, approved_at, reversed_at, created_at
       FROM referral_commissions WHERE referrer_user_id = ? ORDER BY created_at DESC`, userId),
    payouts: await rows(d1, 'SELECT * FROM referral_payouts WHERE referrer_user_id = ? ORDER BY period DESC', userId),
  };
}

/**
 * Runs BEFORE the account row is scrubbed, so a failure leaves the account intact and the deletion retryable:
 * remembers the mailbox (hashed) when this member ever paid, and deletes stored national-ID images. Without
 * the REFERRAL_KYC binding the images cannot be reached; that is logged and the deletion proceeds.
 */
export async function prepareReferralAccountDeletion(d1: D1DatabaseLike, env: RuntimeEnv, user: { id: string; email: string }): Promise<void> {
  const canonical = normalizeEmailForSelfCheck(user.email);
  if (canonical && !(await isEligibleReferee(d1, { userId: user.id, email: user.email }))) await recordPaidEmail(d1, canonical);

  const profile = await getStored(d1, user.id);
  const keys = [profile?.id_front_key ?? null, profile?.id_back_key ?? null].filter((k): k is string => Boolean(k));
  if (!keys.length) return;
  if (!env.REFERRAL_KYC) {
    console.error(`account ${user.id} deleted with ${keys.length} national-ID image(s) unreachable: REFERRAL_KYC binding missing`);
    return;
  }
  await env.REFERRAL_KYC.delete(keys);
}

/** Runs after the account row is scrubbed: removes the payout profile and the referee email on commissions. */
export async function scrubReferralAccountData(d1: D1DatabaseLike, userId: string): Promise<void> {
  await d1.prepare('DELETE FROM referral_payout_profiles WHERE user_id = ?').bind(userId).run();
  await d1.prepare('UPDATE referral_commissions SET referee_email = NULL WHERE referee_user_id = ?').bind(userId).run();
}
