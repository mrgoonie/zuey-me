import type { D1DatabaseLike } from '../../db/store';
import type { Row } from '../members/runtime';
import { str, strOrNull } from '../members/runtime';
import { getEntitlements } from '../members/subscriptions';
import { getReferralProfile, normalizeEmailForSelfCheck } from './codes';

/**
 * Who may refer and who may be referred.
 * Referrer: not locked, and admin-enabled or holding an active plan (the link pauses while the plan lapses).
 * Referee: never paid for anything before, matched by account and by canonical email (Gmail dots, +tags).
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

/** Domains whose addresses can share a canonical mailbox (gmail.com and googlemail.com fold together). */
function domainSuffixes(canonical: string): string[] {
  const domain = canonical.slice(canonical.lastIndexOf('@'));
  return domain === '@gmail.com' ? ['@gmail.com', '@googlemail.com'] : [domain];
}

/**
 * Distinct raw values of `column` in `table` whose canonical email equals `canonical`. SQL narrows by
 * domain (exact suffix, no LIKE wildcards); the canonical comparison happens here.
 */
async function rawEmailsMatching(d1: D1DatabaseLike, table: 'users' | 'bookings' | 'card_subscriptions', column: string, canonical: string): Promise<string[]> {
  const out = new Set<string>();
  for (const suffix of domainSuffixes(canonical)) {
    const { results } = await d1.prepare(`SELECT DISTINCT ${column} AS email FROM ${table} WHERE ${column} IS NOT NULL AND substr(lower(${column}), -?) = ?`)
      .bind(suffix.length, suffix).all<Row>();
    for (const r of results ?? []) {
      const email = str(r, 'email');
      if (normalizeEmailForSelfCheck(email) === canonical) out.add(email);
    }
  }
  return [...out];
}

/** Live and deleted accounts that are the referee: the given user plus every account on the same canonical mailbox. */
async function refereeUserIds(d1: D1DatabaseLike, userId: string | undefined, canonical: string | null): Promise<string[]> {
  const ids = new Set<string>(userId ? [userId] : []);
  if (canonical) {
    const emails = await rawEmailsMatching(d1, 'users', 'email', canonical);
    if (emails.length) {
      const { results } = await d1.prepare(`SELECT id FROM users WHERE email IN (${placeholders(emails.length)})`).bind(...emails).all<Row>();
      for (const r of results ?? []) ids.add(str(r, 'id'));
    }
  }
  return [...ids];
}

async function anyRow(d1: D1DatabaseLike, sql: string, params: unknown[]): Promise<boolean> {
  return (await d1.prepare(sql).bind(...params).first<Row>()) !== null;
}

/**
 * True when nobody behind this account or mailbox has ever paid: no paid SePay order, no card subscription
 * that got past its first charge, no paid or confirmed booking. Commission is first-order only.
 * `excludeSourceId` ignores one order/card/booking (ids are prefixed per table, so they never collide):
 * at commission time the order being paid must not count as "paid before".
 */
export async function isEligibleReferee(
  d1: D1DatabaseLike, input: { userId?: string; email?: string | null; excludeSourceId?: string | null },
): Promise<boolean> {
  const exclude = input.excludeSourceId ?? '';
  let canonical = normalizeEmailForSelfCheck(input.email);
  if (!canonical && input.userId) {
    const row = await d1.prepare('SELECT email FROM users WHERE id = ?').bind(input.userId).first<Row>();
    canonical = row ? normalizeEmailForSelfCheck(str(row, 'email')) : null;
  }
  if (!canonical && !input.userId) return false;
  const ids = await refereeUserIds(d1, input.userId, canonical);

  if (ids.length) {
    const inIds = placeholders(ids.length);
    if (await anyRow(d1, `SELECT 1 FROM billing_orders WHERE user_id IN (${inIds}) AND id <> ? AND (status = 'paid' OR paid_at IS NOT NULL) LIMIT 1`, [...ids, exclude])) return false;
    if (await anyRow(d1, `SELECT 1 FROM card_subscriptions WHERE user_id IN (${inIds}) AND id <> ? AND (status IN ${CARD_PAID_STATUSES} OR first_payment_id IS NOT NULL) LIMIT 1`, [...ids, exclude])) return false;
  }
  if (!canonical) return true;
  const cardEmails = await rawEmailsMatching(d1, 'card_subscriptions', 'customer_email', canonical);
  if (cardEmails.length && await anyRow(d1,
    `SELECT 1 FROM card_subscriptions WHERE customer_email IN (${placeholders(cardEmails.length)}) AND id <> ? AND (status IN ${CARD_PAID_STATUSES} OR first_payment_id IS NOT NULL) LIMIT 1`,
    [...cardEmails, exclude])) return false;
  const guestEmails = await rawEmailsMatching(d1, 'bookings', 'guest_email', canonical);
  if (guestEmails.length && await anyRow(d1,
    `SELECT 1 FROM bookings WHERE guest_email IN (${placeholders(guestEmails.length)}) AND id <> ? AND (status = 'confirmed' OR COALESCE(amount_paid, 0) > 0) LIMIT 1`,
    [...guestEmails, exclude])) return false;
  return true;
}

/** Canonical mailboxes of an account: its email plus the emails of its linked OAuth identities. */
async function accountMailboxes(d1: D1DatabaseLike, userId: string): Promise<Set<string>> {
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
