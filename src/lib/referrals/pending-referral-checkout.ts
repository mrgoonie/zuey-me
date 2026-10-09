import type { D1DatabaseLike } from '../../db/store';
import type { Row } from '../members/runtime';
import { iso, membersRuntime, str } from '../members/runtime';
import { CARD_PENDING_TTL_MS } from '../payments/dodo-billing';
import { normalizeEmailForSelfCheck } from './codes';
import { rawEmailsMatching, refereeUserIds } from './eligibility';

/**
 * The referral discount is for the referee's first order, so only one discounted checkout may be open at a
 * time. A referee (account, or canonical mailbox for guest bookings) who already has an unexpired pending
 * SePay order, an unexpired pending card checkout or an active booking hold carrying a referral snapshot gets
 * list price on any further checkout until that one is paid, expires or is cancelled.
 */
function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

async function anyRow(d1: D1DatabaseLike, sql: string, params: unknown[]): Promise<boolean> {
  return (await d1.prepare(sql).bind(...params).first<Row>()) !== null;
}

export async function hasPendingReferralCheckout(d1: D1DatabaseLike, input: { userId?: string; email?: string | null }): Promise<boolean> {
  const nowMs = membersRuntime.now();
  const now = iso(nowMs);
  let canonical = normalizeEmailForSelfCheck(input.email);
  if (!canonical && input.userId) {
    const row = await d1.prepare('SELECT email FROM users WHERE id = ?').bind(input.userId).first<Row>();
    canonical = row ? normalizeEmailForSelfCheck(str(row, 'email')) : null;
  }
  const ids = await refereeUserIds(d1, input.userId, canonical);
  if (ids.length) {
    const inIds = placeholders(ids.length);
    if (await anyRow(d1,
      `SELECT 1 FROM billing_orders WHERE user_id IN (${inIds}) AND referrer_user_id IS NOT NULL AND status = 'pending' AND expires_at > ? LIMIT 1`,
      [...ids, now])) return true;
    // An abandoned card checkout stays `pending`; its single-use Dodo discount expires after CARD_PENDING_TTL_MS.
    if (await anyRow(d1,
      `SELECT 1 FROM card_subscriptions WHERE user_id IN (${inIds}) AND referrer_user_id IS NOT NULL AND status = 'pending'
         AND first_payment_id IS NULL AND created_at > ? LIMIT 1`,
      [...ids, iso(nowMs - CARD_PENDING_TTL_MS)])) return true;
  }
  if (!canonical) return false;
  const guestEmails = await rawEmailsMatching(d1, 'bookings', 'guest_email', canonical);
  return guestEmails.length > 0 && anyRow(d1,
    `SELECT 1 FROM bookings WHERE guest_email IN (${placeholders(guestEmails.length)}) AND referrer_user_id IS NOT NULL
       AND status = 'held' AND hold_expires_at > ? LIMIT 1`,
    [...guestEmails, now]);
}
