import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { strOrNull } from '../members/runtime';

/**
 * Where a payout is sent, copied from the referrer's VERIFIED payout profile when the monthly close creates
 * the payout. The admin list, the accountant CSV and mark-paid read only this snapshot, so a later profile
 * edit (unreviewed, possibly by someone holding a stolen session) can never redirect an existing payout.
 */
export interface PayoutPayee {
  full_name: string | null;
  bank_name: string | null;
  bank_account: string | null;
  national_id: string | null;
  address: string | null;
  paypal_email: string | null;
  /** When the profile this snapshot came from was verified by an admin; null means no usable snapshot. */
  verified_at: string | null;
}

/** Columns of `referral_payouts` holding the snapshot, in `PayoutPayee` field order. */
export const PAYEE_COLUMNS = [
  'payee_full_name', 'payee_bank_name', 'payee_bank_account', 'payee_national_id', 'payee_address', 'payee_paypal_email', 'payee_verified_at',
] as const;

/** Values for `PAYEE_COLUMNS`, read from a `referral_payout_profiles` row. */
export function payeeValuesFromProfile(profile: Row): (string | null)[] {
  return ['full_name', 'bank_name', 'bank_account', 'national_id', 'address', 'paypal_email', 'verified_at'].map(k => strOrNull(profile, k));
}

export function rowToPayee(row: Row): PayoutPayee {
  return {
    full_name: strOrNull(row, 'payee_full_name'),
    bank_name: strOrNull(row, 'payee_bank_name'),
    bank_account: strOrNull(row, 'payee_bank_account'),
    national_id: strOrNull(row, 'payee_national_id'),
    address: strOrNull(row, 'payee_address'),
    paypal_email: strOrNull(row, 'payee_paypal_email'),
    verified_at: strOrNull(row, 'payee_verified_at'),
  };
}

/**
 * Refuses to record a transfer unless the payout carries a payee snapshot taken from a verified profile with
 * the destination its method needs (bank account, or PayPal email).
 */
export function assertPayableSnapshot(method: 'vn_bank' | 'paypal', payee: PayoutPayee): void {
  const destination = method === 'paypal' ? payee.paypal_email : payee.bank_account;
  if (!payee.verified_at || !destination) {
    throw new AppError(409, 'payee_unverified', 'This payout has no payee snapshot from a verified payout profile; cancel it and let the next close recreate it');
  }
}

/** Last `visible` characters, the rest replaced by `•` (null stays null). */
export function maskTail(value: string | null, visible: number): string | null {
  if (value === null) return null;
  if (value.length <= visible) return '•'.repeat(value.length);
  return `${'•'.repeat(value.length - visible)}${value.slice(-visible)}`;
}

/** Payee with the national ID (last 3) and bank account (last 4) masked, for surfaces that feed LLM context. */
export function maskPayee(payee: PayoutPayee): PayoutPayee {
  return { ...payee, national_id: maskTail(payee.national_id, 3), bank_account: maskTail(payee.bank_account, 4) };
}
