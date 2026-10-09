import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import type { Row } from '../members/runtime';
import { num, numOrNull, str } from '../members/runtime';
import type { CommissionSource } from './commissions';
import { recordReferralCommission } from './commissions';

/**
 * Repair for commission captures that failed on the payment path (a transient D1 error, a missing exchange
 * rate): the payment is already recorded, so the provider never retries. Every run looks for paid referred
 * sources with neither a commission nor a refund/cancel marker and captures them again through the same
 * idempotent `recordReferralCommission`. Payer text from the original webhook is not stored, so that one soft
 * signal is unavailable on a recapture.
 */
export const RECAPTURE_BATCH = 50;

const MISSING = (kind: string, alias: string) => `NOT EXISTS (SELECT 1 FROM referral_commissions c WHERE c.source_kind = '${kind}' AND c.source_id = ${alias}.id)
  AND NOT EXISTS (SELECT 1 FROM referral_source_reversals r WHERE r.source_kind = '${kind}' AND r.source_id = ${alias}.id)`;

async function candidates(d1: D1DatabaseLike, limit: number): Promise<CommissionSource[]> {
  const out: CommissionSource[] = [];
  const orders = await d1.prepare(
    `SELECT o.id FROM billing_orders o WHERE o.referrer_user_id IS NOT NULL AND o.status = 'paid' AND ${MISSING('billing_order', 'o')}
     ORDER BY o.paid_at LIMIT ?`
  ).bind(limit).all<Row>();
  for (const r of orders.results ?? []) out.push({ kind: 'billing_order', id: str(r, 'id') });
  const bookings = await d1.prepare(
    `SELECT b.id FROM bookings b WHERE b.referrer_user_id IS NOT NULL AND b.status = 'confirmed' AND ${MISSING('booking', 'b')}
     ORDER BY b.updated_at LIMIT ?`
  ).bind(limit).all<Row>();
  for (const r of bookings.results ?? []) out.push({ kind: 'booking', id: str(r, 'id') });
  const cards = await d1.prepare(
    `SELECT s.id, s.first_payment_id, s.first_payment_cents, s.first_payment_tax_cents FROM card_subscriptions s
     WHERE s.referrer_user_id IS NOT NULL AND s.first_payment_id IS NOT NULL AND s.first_payment_cents IS NOT NULL AND ${MISSING('card_subscription', 's')}
     ORDER BY s.first_payment_at LIMIT ?`
  ).bind(limit).all<Row>();
  for (const r of cards.results ?? []) {
    out.push({
      kind: 'card_subscription', id: str(r, 'id'), paymentId: str(r, 'first_payment_id'),
      collectedCents: num(r, 'first_payment_cents') - (numOrNull(r, 'first_payment_tax_cents') ?? 0),
    });
  }
  return out;
}

export interface RecaptureResult {
  checked: number;
  created: number;
  /** Sources whose capture still fails (e.g. USD_VND_RATE missing); retried on the next run. */
  failed: { source_kind: CommissionSource['kind']; source_id: string; error: string }[];
}

export async function recaptureMissingCommissions(d1: D1DatabaseLike, env: RuntimeEnv, limit = RECAPTURE_BATCH): Promise<RecaptureResult> {
  const sources = await candidates(d1, limit);
  const result: RecaptureResult = { checked: sources.length, created: 0, failed: [] };
  for (const source of sources) {
    try {
      if ((await recordReferralCommission(d1, env, source)).created) result.created++;
    } catch (err) {
      result.failed.push({ source_kind: source.kind, source_id: source.id, error: err instanceof Error ? err.message : 'unknown' });
    }
  }
  if (result.failed.length) console.error(`referral recapture: ${result.failed.length} source(s) still failing`);
  return result;
}
