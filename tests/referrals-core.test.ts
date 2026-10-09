import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestD1 } from './helpers/d1';
import { membersRuntime } from '../src/lib/members/runtime';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import {
  REFERRAL_CODE_RE, ensureReferralProfile, generateReferralCode, getReferralProfileByCode, normalizeEmailForSelfCheck,
} from '../src/lib/referrals/codes';
import { DEFAULT_TIERS, getReferralSettings, updateReferralSettings } from '../src/lib/referrals/config';
import { isActiveReferrer } from '../src/lib/referrals/eligibility';
import { appendLedger, balanceCents, heldCommissionCents } from '../src/lib/referrals/ledger';
import { applyPercent, bookingSplit, clampDiscount, effectiveRate, membershipSplit, tierRateFor } from '../src/lib/referrals/rates';

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

async function member(email: string): Promise<string> {
  return (await findOrCreateVerifiedUser(d1, { email })).user.id;
}

describe('migration 0014', () => {
  it('applies on a fresh database and seeds the default settings row', async () => {
    const settings = await getReferralSettings(d1);
    expect(settings.tiers).toEqual(DEFAULT_TIERS);
    expect(settings).toMatchObject({ hold_days: 30, booking_rate: 10, payout_threshold_cents: 5000, vn_deduction_bp: 1000, paypal_deduction_bp: 1800, cookie_days: 30 });
    const cols = (table: string) => d1.raw.query(`PRAGMA table_info(${table})`).all().map(c => (c && typeof c === 'object' && 'name' in c ? c.name : ''));
    expect(cols('users')).toEqual(expect.arrayContaining(['referred_by_user_id', 'referred_at', 'referral_signup_ip_hash']));
    for (const t of ['billing_orders', 'card_subscriptions', 'bookings']) {
      expect(cols(t)).toEqual(expect.arrayContaining(['referrer_user_id', 'referral_rate', 'referral_discount_percent', 'referral_commission_percent', 'amount_before_referral', 'referral_ref']));
    }
    expect(cols('card_subscriptions')).toContain('first_payment_id');
  });
});

describe('rates', () => {
  it('maps the 90-day success count onto tier boundaries', () => {
    const cases: Array<[number, number]> = [[0, 20], [2, 20], [3, 25], [9, 25], [10, 30], [25, 40], [50, 50], [99, 50]];
    for (const [count, rate] of cases) expect(tierRateFor(count, DEFAULT_TIERS)).toBe(rate);
  });

  it('uses the larger of the admin override and the tier rate', () => {
    const settings = { tiers: DEFAULT_TIERS };
    expect(effectiveRate({ admin_rate_override: null, tier_count_90d: 3 }, settings)).toBe(25);
    expect(effectiveRate({ admin_rate_override: 40, tier_count_90d: 3 }, settings)).toBe(40);
    expect(effectiveRate({ admin_rate_override: 20, tier_count_90d: 10 }, settings)).toBe(30);
    expect(effectiveRate({ admin_rate_override: 99, tier_count_90d: 0 }, settings)).toBe(50);
  });

  it('clamps the chosen discount to the current rate when R drops', () => {
    expect(clampDiscount(25, 20)).toBe(20);
    expect(clampDiscount(15, 30)).toBe(15);
    expect(clampDiscount(-5, 30)).toBe(0);
    expect(membershipSplit(25, 20)).toEqual({ discountPercent: 20, commissionPercent: 0 });
    expect(membershipSplit(15, 25)).toEqual({ discountPercent: 15, commissionPercent: 10 });
  });

  it('splits the booking rate in the d/R ratio', () => {
    expect(bookingSplit(15, 30, 10)).toEqual({ discountPercent: 5, commissionPercent: 5 });
    expect(bookingSplit(0, 30, 10)).toEqual({ discountPercent: 0, commissionPercent: 10 });
    expect(bookingSplit(30, 30, 10)).toEqual({ discountPercent: 10, commissionPercent: 0 });
    expect(bookingSplit(10, 30, 10)).toEqual({ discountPercent: 3, commissionPercent: 7 });
    expect(bookingSplit(5, 0, 10)).toEqual({ discountPercent: 0, commissionPercent: 0 });
  });

  it('applies percent discounts in cents (USD) and whole 1,000 VND', () => {
    expect(applyPercent(18240, 15)).toBe(15504);
    expect(applyPercent(199900, 5)).toBe(189905);
    expect(applyPercent(999, 15)).toBe(850);
    expect(applyPercent(1_234_000, 15, 'VND')).toBe(1_049_000);
    expect(applyPercent(100_000, 0, 'VND')).toBe(100_000);
  });
});

describe('settings', () => {
  it('validates and persists an admin update', async () => {
    const next = await updateReferralSettings(d1, { tiers: [{ min: 0, rate: 15 }, { min: 5, rate: 35 }], hold_days: 14 });
    expect(next.tiers).toEqual([{ min: 0, rate: 15 }, { min: 5, rate: 35 }]);
    expect((await getReferralSettings(d1)).hold_days).toBe(14);
  });

  it('rejects malformed tiers and unknown keys', async () => {
    await expect(updateReferralSettings(d1, { tiers: [{ min: 1, rate: 20 }] })).rejects.toMatchObject({ code: 'invalid_field' });
    await expect(updateReferralSettings(d1, { tiers: [{ min: 0, rate: 20 }, { min: 0, rate: 30 }] })).rejects.toMatchObject({ code: 'invalid_field' });
    await expect(updateReferralSettings(d1, { tiers: [{ min: 0, rate: 60 }] })).rejects.toMatchObject({ code: 'invalid_field' });
    await expect(updateReferralSettings(d1, { hold_days: 1.5 })).rejects.toMatchObject({ code: 'invalid_field' });
    await expect(updateReferralSettings(d1, { bogus: 1 })).rejects.toMatchObject({ code: 'invalid_field' });
    await expect(updateReferralSettings(d1, {})).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('codes and profiles', () => {
  it('generates valid codes and creates one profile per member', async () => {
    expect(generateReferralCode()).toMatch(REFERRAL_CODE_RE);
    const id = await member('ref@example.com');
    const a = await ensureReferralProfile(d1, id);
    const b = await ensureReferralProfile(d1, id);
    expect(b.code).toBe(a.code);
    expect(a).toMatchObject({ discount_percent: 0, admin_rate_override: null, admin_enabled: false, tier_rate: 20 });
    expect((await getReferralProfileByCode(d1, ` ${a.code.toUpperCase()} `))?.user_id).toBe(id);
    expect(await getReferralProfileByCode(d1, 'bad code!')).toBeNull();
  });

  it('canonicalizes mailboxes for self checks', () => {
    expect(normalizeEmailForSelfCheck('J.Doe+promo@GoogleMail.com')).toBe('jdoe@gmail.com');
    expect(normalizeEmailForSelfCheck('a.b+x@example.com')).toBe('a.b@example.com');
    expect(normalizeEmailForSelfCheck('not-an-email')).toBeNull();
  });
});

describe('referrer eligibility', () => {
  it('requires an active plan or admin enablement and no lock', async () => {
    const id = await member('ref@example.com');
    await ensureReferralProfile(d1, id);
    expect(await isActiveReferrer(d1, id)).toBe(false);
    await d1.prepare("INSERT INTO subscriptions (id, user_id, plan, status, current_period_end, created_at, updated_at) VALUES ('s1', ?, 'knowledges', 'active', ?, ?, ?)")
      .bind(id, new Date(T0 + 10 * DAY).toISOString(), new Date(T0).toISOString(), new Date(T0).toISOString()).run();
    expect(await isActiveReferrer(d1, id)).toBe(true);
    membersRuntime.now = () => T0 + 11 * DAY;
    expect(await isActiveReferrer(d1, id)).toBe(false);
    await d1.prepare('UPDATE referral_profiles SET admin_enabled = 1 WHERE user_id = ?').bind(id).run();
    expect(await isActiveReferrer(d1, id)).toBe(true);
    await d1.prepare("UPDATE referral_profiles SET locked_at = 'x' WHERE user_id = ?").bind(id).run();
    expect(await isActiveReferrer(d1, id)).toBe(false);
  });
});

describe('ledger', () => {
  it('sums credits, reversals and payouts and ignores duplicate commission lines', async () => {
    const id = await member('ref@example.com');
    expect(await appendLedger(d1, { referrerUserId: id, kind: 'commission', amountCents: 3000, commissionId: 'c1' })).toEqual({ inserted: true });
    expect(await appendLedger(d1, { referrerUserId: id, kind: 'commission', amountCents: 3000, commissionId: 'c1' })).toEqual({ inserted: false });
    await appendLedger(d1, { referrerUserId: id, kind: 'commission', amountCents: 2500, commissionId: 'c2' });
    await appendLedger(d1, { referrerUserId: id, kind: 'reversal', amountCents: -2500, commissionId: 'c2' });
    expect(await appendLedger(d1, { referrerUserId: id, kind: 'reversal', amountCents: -2500, commissionId: 'c2' })).toEqual({ inserted: false });
    expect(await balanceCents(d1, id)).toBe(3000);
    await appendLedger(d1, { referrerUserId: id, kind: 'payout', amountCents: -3000, payoutId: 'p1' });
    await appendLedger(d1, { referrerUserId: id, kind: 'reversal', amountCents: -3000, commissionId: 'c1', note: 'refund after payout' });
    expect(await balanceCents(d1, id)).toBe(-3000);
    expect(await heldCommissionCents(d1, id)).toBe(0);
  });

  it('rejects lines with the wrong sign or no commission reference', async () => {
    const id = await member('ref@example.com');
    await expect(appendLedger(d1, { referrerUserId: id, kind: 'commission', amountCents: -1, commissionId: 'c1' })).rejects.toMatchObject({ code: 'invalid_ledger_amount' });
    await expect(appendLedger(d1, { referrerUserId: id, kind: 'payout', amountCents: 10 })).rejects.toMatchObject({ code: 'invalid_ledger_amount' });
    await expect(appendLedger(d1, { referrerUserId: id, kind: 'reversal', amountCents: -10 })).rejects.toMatchObject({ code: 'invalid_ledger_entry' });
  });
});
