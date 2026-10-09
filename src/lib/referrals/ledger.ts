import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { isUniqueViolation, nowIso } from '../members/runtime';

/**
 * Append-only referral ledger in signed USD cents. A commission is credited only when it is approved
 * (after the hold), so the balance is exactly "approved and not yet paid out": credits minus reversals
 * minus payouts, plus adjustments. A negative balance (refund after payout) carries into the next close.
 */
export type LedgerKind = 'commission' | 'reversal' | 'payout' | 'adjustment';

export interface LedgerEntryInput {
  referrerUserId: string;
  kind: LedgerKind;
  amountCents: number;
  commissionId?: string | null;
  payoutId?: string | null;
  note?: string | null;
}

/** Sign each kind must carry; adjustments may go either way. */
function signAllowed(kind: LedgerKind, amount: number): boolean {
  if (kind === 'commission') return amount > 0;
  if (kind === 'reversal' || kind === 'payout') return amount < 0;
  return amount !== 0;
}

/**
 * Appends one ledger line. Commission and reversal lines are unique per commission, so a retried credit
 * or reversal returns `{ inserted: false }` instead of moving money twice.
 */
export async function appendLedger(d1: D1DatabaseLike, entry: LedgerEntryInput): Promise<{ inserted: boolean }> {
  const amount = entry.amountCents;
  if (!Number.isSafeInteger(amount) || !signAllowed(entry.kind, amount)) {
    throw new AppError(500, 'invalid_ledger_amount', `Invalid ${entry.kind} amount: ${amount}`);
  }
  if ((entry.kind === 'commission' || entry.kind === 'reversal') && !entry.commissionId) {
    throw new AppError(500, 'invalid_ledger_entry', `A ${entry.kind} line must reference its commission`);
  }
  try {
    await d1.prepare(
      `INSERT INTO referral_ledger (referrer_user_id, kind, amount_cents, commission_id, payout_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(entry.referrerUserId, entry.kind, amount, entry.commissionId ?? null, entry.payoutId ?? null, entry.note ?? null, nowIso()).run();
  } catch (err) {
    if (isUniqueViolation(err)) return { inserted: false };
    throw err;
  }
  return { inserted: true };
}

/** Current payable balance (approved, net of reversals and payouts); may be negative. */
export async function balanceCents(d1: D1DatabaseLike, userId: string): Promise<number> {
  const row = await d1.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM referral_ledger WHERE referrer_user_id = ?')
    .bind(userId).first<Row>();
  return Number(row?.total ?? 0);
}

/** Commissions still in their hold or under review: earned but not yet part of the balance. */
export async function heldCommissionCents(d1: D1DatabaseLike, userId: string): Promise<number> {
  const row = await d1.prepare(
    "SELECT COALESCE(SUM(commission_cents), 0) AS total FROM referral_commissions WHERE referrer_user_id = ? AND status IN ('pending', 'review')"
  ).bind(userId).first<Row>();
  return Number(row?.total ?? 0);
}

/** Audit trail entry for referral state changes; never blocks the action it records. */
export async function logReferralEvent(
  d1: D1DatabaseLike,
  input: { actor: string; action: string; subjectUserId?: string | null; detail?: Record<string, unknown> | null },
): Promise<void> {
  try {
    await d1.prepare('INSERT INTO referral_events (actor, action, subject_user_id, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(input.actor, input.action, input.subjectUserId ?? null, input.detail ? JSON.stringify(input.detail) : null, nowIso()).run();
  } catch (err) {
    console.error('referral_events insert failed:', err instanceof Error ? err.message : 'unknown');
  }
}
