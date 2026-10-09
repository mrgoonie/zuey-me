import type { D1DatabaseLike } from '../../db/store';
import type { Row } from '../members/runtime';
import { iso, membersRuntime } from '../members/runtime';
import type { CommissionSourceKind, ReferralCommission } from './commissions';
import { getCommission, getCommissionBySource } from './commissions';
import { appendLedger, logReferralEvent } from './ledger';
import { markSourceReversed } from './source-reversals';

/**
 * Refunds, chargebacks and admin reversals. A commission still in its hold (pending/review) simply becomes
 * `reversed`. One already approved was credited to the ledger, so a negative `reversal` line is appended;
 * if that credit was already paid out, the referrer's balance goes negative and the next close deducts it.
 * Idempotent: repeating a reversal changes nothing and never appends a second ledger line.
 */
export type CommissionRef = { commissionId: string } | { sourceKind: CommissionSourceKind; sourceId: string };

export type ReversalOutcome = 'reversed' | 'already_reversed' | 'not_reversible' | 'not_found';

export interface ReversalResult {
  outcome: ReversalOutcome;
  commission: ReferralCommission | null;
  /** True when this call appended the negative ledger line. */
  ledger_reversed: boolean;
}

const REVERSIBLE = "('pending', 'review', 'approved')";

async function findCommission(d1: D1DatabaseLike, ref: CommissionRef): Promise<ReferralCommission | null> {
  return 'commissionId' in ref ? getCommission(d1, ref.commissionId) : getCommissionBySource(d1, ref.sourceKind, ref.sourceId);
}

/** Appends the negative ledger line when (and only when) the commission was credited. */
async function reverseLedgerCredit(d1: D1DatabaseLike, c: ReferralCommission, reason: string): Promise<boolean> {
  const credit = await d1.prepare("SELECT amount_cents FROM referral_ledger WHERE kind = 'commission' AND commission_id = ?").bind(c.id).first<Row>();
  const amount = Number(credit?.amount_cents ?? 0);
  if (!credit || amount <= 0) return false;
  const { inserted } = await appendLedger(d1, { referrerUserId: c.referrer_user_id, kind: 'reversal', amountCents: -amount, commissionId: c.id, note: reason });
  return inserted;
}

/**
 * Reverses a commission by id or by its source order. `reason` is recorded on the audit trail (e.g.
 * `refund`, `dispute_opened`, `admin_cancel`); `actor` is `system` for webhooks or the admin's identity.
 * A referred source with no commission yet (capture failed or pending retry) is marked reversed instead, so a
 * later recapture never creates one.
 */
export async function reverseCommission(d1: D1DatabaseLike, ref: CommissionRef, reason: string, actor = 'system'): Promise<ReversalResult> {
  const commission = await findCommission(d1, ref);
  if (!commission) {
    if ('sourceKind' in ref && await markSourceReversed(d1, ref.sourceKind, ref.sourceId, reason)) {
      await logReferralEvent(d1, { actor, action: 'source.reversed_before_commission', detail: { source_kind: ref.sourceKind, source_id: ref.sourceId, reason } });
    }
    return { outcome: 'not_found', commission: null, ledger_reversed: false };
  }
  if (commission.status === 'blocked') return { outcome: 'not_reversible', commission, ledger_reversed: false };

  const nowIso = iso(membersRuntime.now());
  const res = await d1.prepare(
    `UPDATE referral_commissions SET status = 'reversed', reversed_at = ?, updated_at = ? WHERE id = ? AND status IN ${REVERSIBLE}`
  ).bind(nowIso, nowIso, commission.id).run();
  const changed = res.meta?.changes === 1;
  // Also run on a repeat so a reversal interrupted between the two writes still gets its ledger line.
  const ledgerReversed = await reverseLedgerCredit(d1, commission, reason);
  if (changed || ledgerReversed) {
    await logReferralEvent(d1, {
      actor, action: 'commission.reversed', subjectUserId: commission.referrer_user_id,
      detail: { commission_id: commission.id, reason, previous_status: commission.status, ledger_reversed: ledgerReversed },
    });
  }
  const fresh = (await getCommission(d1, commission.id)) ?? commission;
  return { outcome: changed ? 'reversed' : 'already_reversed', commission: fresh, ledger_reversed: ledgerReversed };
}
