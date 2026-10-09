import type { D1DatabaseLike } from '../../db/store';
import type { Row } from '../members/runtime';
import { str, strOrNull } from '../members/runtime';
import { getEntitlements } from '../members/subscriptions';
import { getReferralProfile, normalizeEmailForSelfCheck } from './codes';
import { isPaidEmailRecorded } from './paid-email-hashes';

/**
 * Who may refer and who may be referred.
 * Referrer: not locked, and admin-enabled or holding an active plan (the link pauses while the plan lapses).
 * Referee: never paid for anything before (memberships, bookings or courses), matched by account and by canonical email (Gmail dots, +tags)
 * through the indexed `canonical_email` columns (written on every insert/update, see migration 0019),
 * including mailboxes of deleted accounts that had paid (kept only as hashes, see `paid-email-hashes.ts`).
 */

/** Card subscription statuses that are only reachable after a successful first charge. */
const CARD_PAID_STATUSES = "('active', 'on_hold', 'paused', 'expired')";

export async function isActiveReferrer(d1: D1DatabaseLike, userId: string): Promise<boolean> {
  const user = await d1.prepare('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL').bind(userId).first<Row>();
  if (!user) return false;
  const profile = await getReferralProfile(d1, userId);
  if (profile?.locked_at) return false;
  if (profile?.admin_enabled) return true;
  const { plans } = await getEntitlements(d1, userId);
  return plans.length > 0;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/**
 * Accounts that are the referee: the given user plus every live account on the same canonical mailbox.
 * Deleted accounts no longer carry their email (it is scrubbed), so they are covered by the paid-email
 * hashes in `isEligibleReferee` instead.
 */
export async function refereeUserIds(d1: D1DatabaseLike, userId: string | undefined, canonical: string | null): Promise<string[]> {
  const ids = new Set<string>(userId ? [userId] : []);
  if (canonical) {
    const { results } = await d1.prepare('SELECT id FROM users WHERE canonical_email = ?').bind(canonical).all<Row>();
    for (const r of results ?? []) ids.add(str(r, 'id'));
  }
  return [...ids];
}

async function anyRow(d1: D1DatabaseLike, sql: string, params: unknown[]): Promise<boolean> {
  return (await d1.prepare(sql).bind(...params).first<Row>()) !== null;
}

/**
 * True when nobody behind this account or mailbox has ever paid: no paid SePay order, no card subscription
 * that got past its first charge, no paid or confirmed booking, and no deleted account on this mailbox that had paid. Commission is first-order only.
 * `excludeSourceId` ignores one order/card/booking (ids are prefixed per table, so they never collide):
 * at commission time the order being paid must not count as "paid before".
 */
export async function isEligibleReferee(
  d1: D1DatabaseLike, input: { userId?: string; email?: string | null; excludeSourceId?: string | null; ownPaymentsSince?: string | null },
): Promise<boolean> {
  const exclude = input.excludeSourceId ?? '';
  // Repeat course orders of a bound referee: payments made after binding are allowed (see `isEligibleBoundReferee`).
  const since = input.ownPaymentsSince ?? null;
  const before = (col: string) => (since ? ` AND ${col} < ?` : '');
  const sinceArg = since ? [since] : [];
  let canonical = normalizeEmailForSelfCheck(input.email);
  if (!canonical && input.userId) {
    const row = await d1.prepare('SELECT email FROM users WHERE id = ?').bind(input.userId).first<Row>();
    canonical = row ? normalizeEmailForSelfCheck(str(row, 'email')) : null;
  }
  if (!canonical && !input.userId) return false;
  const ids = await refereeUserIds(d1, input.userId, canonical);

  if (ids.length) {
    const inIds = placeholders(ids.length);
    // Other accounts on the same mailbox always count; with `ownPaymentsSince`, the buyer's own later payments do not.
    const own = since && input.userId ? ` AND (user_id <> ? OR COALESCE(%s, created_at) < ?)` : '';
    const ownArgs = since && input.userId ? [input.userId, since] : [];
    if (await anyRow(d1, `SELECT 1 FROM billing_orders WHERE user_id IN (${inIds}) AND id <> ? AND (status = 'paid' OR paid_at IS NOT NULL)${own.replace('%s', 'paid_at')} LIMIT 1`, [...ids, exclude, ...ownArgs])) return false;
    if (await anyRow(d1, `SELECT 1 FROM card_subscriptions WHERE user_id IN (${inIds}) AND id <> ? AND (status IN ${CARD_PAID_STATUSES} OR first_payment_id IS NOT NULL)${own.replace('%s', 'first_payment_at')} LIMIT 1`, [...ids, exclude, ...ownArgs])) return false;
    if (await anyRow(d1, `SELECT 1 FROM course_orders WHERE user_id IN (${inIds}) AND id <> ? AND paid_at IS NOT NULL${own.replace('%s', 'paid_at')} LIMIT 1`, [...ids, exclude, ...ownArgs])) return false;
  }
  if (!canonical) return true;
  if (await isPaidEmailRecorded(d1, canonical)) return false;
  if (await anyRow(d1,
    `SELECT 1 FROM card_subscriptions WHERE canonical_email = ? AND id <> ? AND (status IN ${CARD_PAID_STATUSES} OR first_payment_id IS NOT NULL)${before('COALESCE(first_payment_at, created_at)')} LIMIT 1`,
    [canonical, exclude, ...sinceArg])) return false;
  if (await anyRow(d1,
    `SELECT 1 FROM bookings WHERE canonical_email = ? AND id <> ? AND (status = 'confirmed' OR COALESCE(amount_paid, 0) > 0)${before('created_at')} LIMIT 1`,
    [canonical, exclude, ...sinceArg])) return false;
  return true;
}

/**
 * A referee bound to `referrerUserId` keeps earning that referrer commission on repeat course orders, but only if
 * nobody behind the account or mailbox had paid before it was bound (signup binding does not check this itself).
 * Null when the account is not bound to that referrer.
 */
export async function isEligibleBoundReferee(
  d1: D1DatabaseLike, input: { userId: string; referrerUserId: string; excludeSourceId?: string | null },
): Promise<boolean | null> {
  const row = await d1.prepare('SELECT referred_at FROM users WHERE id = ? AND referred_by_user_id = ?').bind(input.userId, input.referrerUserId).first<Row>();
  const referredAt = row ? strOrNull(row, 'referred_at') : null;
  if (!row) return null;
  // A binding without a timestamp cannot prove when the payments happened: apply the first-order rule.
  return isEligibleReferee(d1, { userId: input.userId, excludeSourceId: input.excludeSourceId, ownPaymentsSince: referredAt });
}

/** Canonical mailboxes of an account: its email plus the emails of its linked OAuth identities. */
export async function accountMailboxes(d1: D1DatabaseLike, userId: string): Promise<Set<string>> {
  const out = new Set<string>();
  const user = await d1.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first<Row>();
  const userEmail = user ? normalizeEmailForSelfCheck(str(user, 'email')) : null;
  if (userEmail) out.add(userEmail);
  const { results } = await d1.prepare('SELECT email FROM user_identities WHERE user_id = ?').bind(userId).all<Row>();
  for (const r of results ?? []) {
    const email = normalizeEmailForSelfCheck(strOrNull(r, 'email'));
    if (email) out.add(email);
  }
  return out;
}

/**
 * Hard block for self-referral: same account, or the referee's mailbox (given email, account email or a
 * linked OAuth identity email) canonically equals one of the referrer's.
 */
export async function isSelfReferral(d1: D1DatabaseLike, referrerUserId: string, referee: { userId?: string; email?: string | null }): Promise<boolean> {
  if (referee.userId && referee.userId === referrerUserId) return true;
  const referrerMailboxes = await accountMailboxes(d1, referrerUserId);
  const refereeMailboxes = referee.userId ? await accountMailboxes(d1, referee.userId) : new Set<string>();
  const given = normalizeEmailForSelfCheck(referee.email);
  if (given) refereeMailboxes.add(given);
  for (const mailbox of refereeMailboxes) if (referrerMailboxes.has(mailbox)) return true;
  return false;
}
