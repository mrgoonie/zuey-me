import type { D1DatabaseLike } from '../../db/store';
import type { Row } from '../members/runtime';
import { iso, membersRuntime } from '../members/runtime';
import type { CommissionSourceKind } from './commissions';

/**
 * Refund/cancel markers for referred sources that had no commission yet when the money went back (its capture
 * failed, or was still pending a retry). Commission capture and the recapture job skip marked sources, so a
 * repaired capture can never pay commission on an order that was refunded or cancelled in the meantime.
 */
const SOURCE_TABLE: Record<CommissionSourceKind, string> = {
  billing_order: 'billing_orders',
  card_subscription: 'card_subscriptions',
  booking: 'bookings',
};

export async function isSourceReversed(d1: D1DatabaseLike, kind: CommissionSourceKind, sourceId: string): Promise<boolean> {
  const row = await d1.prepare('SELECT 1 AS hit FROM referral_source_reversals WHERE source_kind = ? AND source_id = ?').bind(kind, sourceId).first<Row>();
  return row !== null;
}

/** Marks a referred source as reversed (idempotent). Sources without a referral snapshot are not recorded. */
export async function markSourceReversed(d1: D1DatabaseLike, kind: CommissionSourceKind, sourceId: string, reason: string): Promise<boolean> {
  const res = await d1.prepare(
    `INSERT OR IGNORE INTO referral_source_reversals (source_kind, source_id, reason, created_at)
     SELECT ?, id, ?, ? FROM ${SOURCE_TABLE[kind]} WHERE id = ? AND referrer_user_id IS NOT NULL`
  ).bind(kind, reason, iso(membersRuntime.now()), sourceId).run();
  return res.meta?.changes === 1;
}
