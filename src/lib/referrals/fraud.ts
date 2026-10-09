import { isDisposableEmail } from './disposable-domains';

/**
 * Pure fraud verdict for a referred order. Hard signals block the commission outright; soft signals send
 * it to the admin review queue. Gathering the facts from the database lives in `fraud-signals.ts`.
 */
export type FraudVerdict = 'block' | 'review' | 'ok';

export type BlockReason = 'self_referral' | 'referee_previously_paid' | 'referrer_locked';
export type ReviewReason = 'shared_ip' | 'payer_matches_referrer' | 'disposable_email' | 'signup_velocity';
export type FraudReason = BlockReason | ReviewReason;

/** More bound signups than this for one referrer within 24 hours is a velocity signal. */
export const VELOCITY_MAX_SIGNUPS_24H = 5;

export interface ReferralFraudSnapshot {
  /** Same account, canonical mailbox or OAuth identity email as the referrer. */
  selfReferral: boolean;
  /** Any other paid order, card subscription or booking by this referee (account or mailbox). */
  refereePreviouslyPaid: boolean;
  referrerLocked: boolean;
  refereeEmail: string | null;
  /** Referee's signup IP hash equals one the referrer recently signed in from. */
  sharedIp: boolean;
  /** Bank transfer payer name/account matches the referrer's payout profile. */
  payerMatchesReferrer: boolean;
  /** Accounts bound to this referrer in the 24 hours before this order. */
  boundSignupsLast24h: number;
}

export interface FraudAssessment {
  verdict: FraudVerdict;
  reasons: FraudReason[];
}

export function assessReferral(s: ReferralFraudSnapshot): FraudAssessment {
  const block: FraudReason[] = [];
  if (s.selfReferral) block.push('self_referral');
  if (s.refereePreviouslyPaid) block.push('referee_previously_paid');
  if (s.referrerLocked) block.push('referrer_locked');
  const review: FraudReason[] = [];
  if (s.sharedIp) review.push('shared_ip');
  if (s.payerMatchesReferrer) review.push('payer_matches_referrer');
  if (isDisposableEmail(s.refereeEmail)) review.push('disposable_email');
  if (s.boundSignupsLast24h > VELOCITY_MAX_SIGNUPS_24H) review.push('signup_velocity');
  if (block.length) return { verdict: 'block', reasons: [...block, ...review] };
  if (review.length) return { verdict: 'review', reasons: review };
  return { verdict: 'ok', reasons: [] };
}

/** Upper-case ASCII letters/digits with Vietnamese diacritics folded (Đ → D), single-spaced. */
export function foldForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'D')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/**
 * Whether bank-transfer text (SePay content, where banks put the payer's name) names the referrer's payout
 * account holder (two or more words) or contains their account number (six or more digits).
 */
export function payerTextMatches(payerText: string | null | undefined, payout: { fullName: string | null; bankAccount: string | null }): boolean {
  if (!payerText) return false;
  const text = ` ${foldForMatch(payerText)} `;
  const name = payout.fullName ? foldForMatch(payout.fullName) : '';
  if (name.split(' ').length >= 2 && text.includes(` ${name} `)) return true;
  const account = (payout.bankAccount ?? '').replace(/\D/g, '');
  return account.length >= 6 && payerText.replace(/\D/g, '').includes(account);
}
