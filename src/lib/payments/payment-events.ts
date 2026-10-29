/**
 * The `payment_events` idempotency record shared by every payment rail (memberships, bookings, courses). A rail writes
 * the record as the first statement of the D1 batch that applies the event, so the record and what the event changes
 * commit together or not at all, and a record is never deleted.
 */
import type { D1DatabaseLike } from '../../db/store';

/**
 * True when `err` is the unique key of `payment_events` (provider, event_id): another delivery of the same event
 * recorded it first. Any other constraint failure is a real error.
 */
export function isPaymentEventConflict(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed: payment_events\.provider, payment_events\.event_id\b/i.test(err.message);
}

/** True when this provider event is already recorded. */
export async function paymentEventRecorded(d1: D1DatabaseLike, provider: string, eventId: string): Promise<boolean> {
  return (await d1.prepare('SELECT 1 AS found FROM payment_events WHERE provider = ? AND event_id = ?').bind(provider, eventId).first()) !== null;
}
