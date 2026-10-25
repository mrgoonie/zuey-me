import type { D1DatabaseLike, D1PreparedStatementLike, SqlCondition } from '../../db/store';
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
  course_order: 'course_orders',
};

export async function isSourceReversed(d1: D1DatabaseLike, kind: CommissionSourceKind, sourceId: string): Promise<boolean> {
  const row = await d1.prepare('SELECT 1 AS hit FROM referral_source_reversals WHERE source_kind = ? AND source_id = ?').bind(kind, sourceId).first<Row>();
  return row !== null;
}

/**
 * The marker of a referred source as a statement for a D1 batch (with `onlyIf`, inserted only while it holds).
 * Idempotent; sources without a referral snapshot are not recorded.
 */
export function markSourceReversedStatement(
  d1: D1DatabaseLike, kind: CommissionSourceKind, sourceId: string, reason: string, onlyIf?: SqlCondition,
): D1PreparedStatementLike {
  return d1.prepare(
    `INSERT OR IGNORE INTO referral_source_reversals (source_kind, source_id, reason, created_at)
     SELECT ?, id, ?, ? FROM ${SOURCE_TABLE[kind]} WHERE id = ? AND referrer_user_id IS NOT NULL${onlyIf ? ` AND ${onlyIf.sql}` : ''}`
  ).bind(kind, reason, iso(membersRuntime.now()), sourceId, ...(onlyIf?.params ?? []));
}

/** Marks a referred source as reversed (idempotent). Sources without a referral snapshot are not recorded. */
export async function markSourceReversed(d1: D1DatabaseLike, kind: CommissionSourceKind, sourceId: string, reason: string): Promise<boolean> {
  const res = await markSourceReversedStatement(d1, kind, sourceId, reason).run();
  return res.meta?.changes === 1;
}

/** The source still has a referral snapshot and no marker when the statement runs. */
export function sourceUnmarked(kind: CommissionSourceKind, sourceId: string): SqlCondition {
  return {
    sql: `EXISTS (SELECT 1 FROM ${SOURCE_TABLE[kind]} WHERE id = ? AND referrer_user_id IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM referral_source_reversals WHERE source_kind = ? AND source_id = ?)`,
    params: [sourceId, kind, sourceId],
  };
}
