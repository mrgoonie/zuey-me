import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestD1 } from './helpers/d1';
import { confirmEmailChange } from '../src/lib/members/login-tokens';
import { iso, membersRuntime, sha256Hex } from '../src/lib/members/runtime';
import { deleteAccount, findOrCreateVerifiedUser, getUserById } from '../src/lib/members/users';
import type { CanonicalEmailRow } from '../src/lib/referrals/canonical-email-backfill';
import {
  CANONICAL_EMAIL_SOURCES, canonicalEmailBackfillStatements, canonicalEmailSelectSql,
} from '../src/lib/referrals/canonical-email-backfill';
import { isEligibleReferee } from '../src/lib/referrals/eligibility';
import { hasPendingReferralCheckout } from '../src/lib/referrals/pending-referral-checkout';

const T0 = Date.parse('2026-10-09T03:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
let d1: ReturnType<typeof createTestD1>;

beforeEach(() => {
  d1 = createTestD1();
  membersRuntime.now = () => T0;
});

afterEach(() => {
  membersRuntime.now = () => Date.now();
});

function canonicalOf(table: string, id: string): unknown {
  return (d1.raw.query(`SELECT canonical_email AS c FROM ${table} WHERE id = ?`).get(id) as { c: unknown } | null)?.c;
}

/** Rows as the app wrote them before migration 0019: raw email only, `canonical_email` left NULL. */
function insertLegacyRows(): void {
  const at = iso(T0 - 2 * DAY);
  d1.raw.run(`INSERT INTO users (id, email, locale, created_at, updated_at) VALUES ('usr_old', 'j.doe+old@googlemail.com', 'vi', ?, ?)`, [at, at]);
  d1.raw.run(
    `INSERT INTO card_subscriptions (id, provider, user_id, plan, status, customer_email, first_payment_id, created_at, updated_at)
     VALUES ('csub_old', 'dodo', NULL, NULL, 'cancelled', 'Card.Holder+x@Example.com', 'pay_old', ?, ?)`, [at, at]);
  d1.raw.run(
    `INSERT INTO bookings (id, code, slot_start, slot_end, duration_min, status, hold_expires_at, guest_name, guest_email, payment_method, manage_token_hash, created_at, updated_at)
     VALUES ('bk_old', 'BKOLD', ?, ?, 60, 'confirmed', ?, 'Guest', 'g.u.e.s.t@gmail.com', 'paypal', 'h', ?, ?)`, [at, iso(T0 - 2 * DAY + 3600000), at, at, at]);
  d1.raw.run(`INSERT INTO billing_orders (id, code, user_id, plan, months, amount_usd_cents, usd_vnd_rate, amount_vnd, status, paid_at, expires_at, created_at, updated_at)
     VALUES ('ord_old', 'ZOLD', 'usr_old', 'combo', 1, 1900, 25000, 475000, 'paid', ?, ?, ?, ?)`, [at, at, at, at]);
}

function runBackfill(): number {
  let applied = 0;
  for (const source of CANONICAL_EMAIL_SOURCES) {
    const rows = d1.raw.query(canonicalEmailSelectSql(source)).all() as CanonicalEmailRow[];
    for (const statement of canonicalEmailBackfillStatements(source, rows)) {
      d1.raw.run(statement);
      applied++;
    }
  }
  return applied;
}

describe('canonical_email on member write paths', () => {
  it('is set on signup and email change, and cleared on account deletion', async () => {
    const { user } = await findOrCreateVerifiedUser(d1, { email: 'j.doe+promo@googlemail.com' });
    expect(canonicalOf('users', user.id)).toBe('jdoe@gmail.com');

    const token = 'email-change-token-0123456789';
    d1.raw.run(
      `INSERT INTO login_tokens (id, token_hash, purpose, email, user_id, created_at, expires_at) VALUES ('lt_1', ?, 'email_change', 'new.mail+x@example.com', ?, ?, ?)`,
      [await sha256Hex(token), user.id, iso(T0), iso(T0 + DAY)],
    );
    await confirmEmailChange(d1, {}, new Request('https://zuey.test/account/email-confirm'), token);
    expect(canonicalOf('users', user.id)).toBe('new.mail@example.com');

    const changed = await getUserById(d1, user.id);
    if (!changed) throw new Error('user missing');
    await deleteAccount(d1, changed);
    expect(canonicalOf('users', user.id)).toBeNull();
  });
});

describe('canonical_email backfill', () => {
  it('makes pre-migration rows visible to the eligibility checks, and is idempotent', async () => {
    insertLegacyRows();
    // Before the backfill the equality lookups cannot see the legacy rows.
    expect(await isEligibleReferee(d1, { email: 'jdoe@gmail.com' })).toBe(true);
    expect(await isEligibleReferee(d1, { email: 'card.holder@example.com' })).toBe(true);
    expect(await isEligibleReferee(d1, { email: 'guest@googlemail.com' })).toBe(true);

    expect(runBackfill()).toBe(3);
    expect(canonicalOf('users', 'usr_old')).toBe('jdoe@gmail.com');
    expect(canonicalOf('card_subscriptions', 'csub_old')).toBe('card.holder@example.com');
    expect(canonicalOf('bookings', 'bk_old')).toBe('guest@gmail.com');
    expect(await isEligibleReferee(d1, { email: 'J.D.O.E@gmail.com' })).toBe(false);
    expect(await isEligibleReferee(d1, { email: 'card.holder+again@example.com' })).toBe(false);
    expect(await isEligibleReferee(d1, { email: 'guest@googlemail.com' })).toBe(false);

    expect(runBackfill()).toBe(0);
  });

  it('skips deleted accounts and never overwrites a row whose email changed after it was read', () => {
    insertLegacyRows();
    d1.raw.run(`UPDATE users SET email = 'deleted+usr_old@deleted.invalid', deleted_at = ? WHERE id = 'usr_old'`, [iso(T0)]);
    const users = CANONICAL_EMAIL_SOURCES[0];
    expect(d1.raw.query(canonicalEmailSelectSql(users)).all()).toEqual([]);

    const bookings = CANONICAL_EMAIL_SOURCES[2];
    const rows = d1.raw.query(canonicalEmailSelectSql(bookings)).all() as CanonicalEmailRow[];
    const [statement] = canonicalEmailBackfillStatements(bookings, rows);
    d1.raw.run(`UPDATE bookings SET guest_email = 'other@example.com' WHERE id = 'bk_old'`);
    d1.raw.run(statement);
    expect(canonicalOf('bookings', 'bk_old')).toBeNull();
  });

  it('escapes quotes and leaves values that are not emails NULL', () => {
    const users = CANONICAL_EMAIL_SOURCES[0];
    expect(canonicalEmailBackfillStatements(users, [
      { id: 'usr_q', email: "o'brien@example.com", canonical_email: null },
      { id: 'usr_bad', email: 'not-an-email', canonical_email: null },
      { id: 'usr_stale', email: 'not-an-email', canonical_email: 'stale@example.com' },
    ])).toEqual([
      "UPDATE users SET canonical_email = 'o''brien@example.com' WHERE id = 'usr_q' AND email = 'o''brien@example.com';",
      "UPDATE users SET canonical_email = NULL WHERE id = 'usr_stale' AND email = 'not-an-email';",
    ]);
  });
});

describe('canonical_email lookups', () => {
  it('finds a pending discounted booking hold by canonical mailbox', async () => {
    d1.raw.run(
      `INSERT INTO bookings (id, code, slot_start, slot_end, duration_min, status, hold_expires_at, guest_name, guest_email, canonical_email,
         payment_method, manage_token_hash, referrer_user_id, created_at, updated_at)
       VALUES ('bk_hold', 'BKHOLD', ?, ?, 60, 'held', ?, 'Guest', 'g.uest+x@gmail.com', 'guest@gmail.com', 'paypal', 'h', 'usr_ref', ?, ?)`,
      [iso(T0 + DAY), iso(T0 + DAY + 3600000), iso(T0 + 600000), iso(T0), iso(T0)],
    );
    expect(await hasPendingReferralCheckout(d1, { email: 'Guest@googlemail.com' })).toBe(true);
    expect(await hasPendingReferralCheckout(d1, { email: 'someone@gmail.com' })).toBe(false);
  });

  it('uses the canonical_email indexes', () => {
    const plan = (sql: string) => JSON.stringify(d1.raw.query(`EXPLAIN QUERY PLAN ${sql}`).all());
    expect(plan("SELECT id FROM users WHERE canonical_email = 'a@gmail.com'")).toContain('idx_users_canonical_email');
    expect(plan(`SELECT 1 FROM card_subscriptions WHERE canonical_email = 'a@gmail.com' AND id <> '' AND (status IN ('active', 'on_hold', 'paused', 'expired') OR first_payment_id IS NOT NULL) LIMIT 1`))
      .toContain('idx_card_subscriptions_canonical_email');
    expect(plan(`SELECT 1 FROM bookings WHERE canonical_email = 'a@gmail.com' AND id <> '' AND (status = 'confirmed' OR COALESCE(amount_paid, 0) > 0) LIMIT 1`))
      .toContain('idx_bookings_canonical_email');
  });
});
