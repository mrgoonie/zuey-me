import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { JPEG_BYTES, PNG_BYTES, createFakeR2 } from './helpers/r2';
import type { RuntimeEnv } from '../src/env';
import { AppError } from '../src/lib/http';
import { membersRuntime } from '../src/lib/members/runtime';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { ensureReferralProfile, getReferralProfile } from '../src/lib/referrals/codes';
import { getReferralSettings } from '../src/lib/referrals/config';
import { closePayoutPeriod, creditApprovedCommissions, matureCommissions, recomputeTiers } from '../src/lib/referrals/jobs';
import { balanceCents } from '../src/lib/referrals/ledger';
import { decidePayoutProfile, readIdImage } from '../src/lib/referrals/payout-profile-review';
import { getPayoutProfile, savePayoutProfile, uploadIdImage } from '../src/lib/referrals/payout-profiles';
import { cancelPayout, listPayouts, markPayoutPaid, payoutsCsv } from '../src/lib/referrals/payouts';
import { effectiveRate } from '../src/lib/referrals/rates';
import { reverseCommission } from '../src/lib/referrals/refunds';
import { nextCloseDate, previousSaigonMonth, saigonMonthRange } from '../src/lib/referrals/saigon-calendar';
import { POST as jobsApi } from '../src/pages/api/v1/referrals/jobs/run';

const T0 = Date.parse('2026-10-05T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
/** 2026-11-01 00:30 in Asia/Saigon (UTC+7): the day-1 close of period 2026-10. */
const NOV_1 = Date.parse('2026-10-31T17:30:00.000Z');
/** 2026-12-01 08:00 in Asia/Saigon. */
const DEC_1 = Date.parse('2026-12-01T01:00:00.000Z');
const RATE = 26350;

let d1: ReturnType<typeof createTestD1>;
let r2: ReturnType<typeof createFakeR2>;
let now: number;
let seq = 0;
let emails: { to: string; subject: string }[];
let envOverrides: Partial<RuntimeEnv>;

function env(): RuntimeEnv {
  return { DB: d1, REFERRAL_KYC: r2, PUBLIC_SITE_URL: 'https://zuey.test', USD_VND_RATE: String(RATE), RESEND_API_KEY: 're_test', CRON_SECRET: 'cron-secret', ...envOverrides };
}

async function referrer(email: string): Promise<string> {
  const { user } = await findOrCreateVerifiedUser(d1, { email });
  await ensureReferralProfile(d1, user.id);
  await d1.prepare('UPDATE referral_profiles SET admin_enabled = 1 WHERE user_id = ?').bind(user.id).run();
  return user.id;
}

/** Inserts a commission row as the payment path would have recorded it. */
async function commission(referrerId: string, opts: { cents?: number; status?: string; paidAt?: number; holdUntil?: number } = {}): Promise<string> {
  const id = `rcm_test_${++seq}`;
  const paidAt = new Date(opts.paidAt ?? T0).toISOString();
  const hold = new Date(opts.holdUntil ?? (opts.paidAt ?? T0) + 30 * DAY).toISOString();
  const cents = opts.cents ?? 1000;
  await d1.prepare(
    `INSERT INTO referral_commissions (id, source_kind, source_id, referrer_user_id, referee_email, base_amount_cents, commission_percent,
       commission_cents, status, hold_until, paid_at, created_at, updated_at)
     VALUES (?, 'billing_order', ?, ?, ?, ?, 10, ?, ?, ?, ?, ?, ?)`
  ).bind(id, `ord_${seq}`, referrerId, `referee${seq}@example.com`, cents * 10, cents, opts.status ?? 'pending', hold, paidAt, paidAt, paidAt).run();
  return id;
}

/** An approved, credited commission of `cents`. */
async function credit(referrerId: string, cents: number): Promise<string> {
  const id = await commission(referrerId, { cents, status: 'approved' });
  await creditApprovedCommissions(d1, now, id);
  return id;
}

async function verifiedProfile(userId: string, method: 'vn_bank' | 'paypal'): Promise<void> {
  const stamp = new Date(T0).toISOString();
  await d1.prepare(
    `INSERT INTO referral_payout_profiles (user_id, method, full_name, bank_name, bank_account, national_id, address, paypal_email, status, verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?, ?)`
  ).bind(userId, method, method === 'vn_bank' ? 'Nguyen Van A' : null, method === 'vn_bank' ? 'VCB' : null, method === 'vn_bank' ? '0011223344' : null,
    method === 'vn_bank' ? '001234567890' : null, method === 'vn_bank' ? '1 Le Loi, Q1, HCM' : null, method === 'paypal' ? 'pp@example.com' : null, stamp, stamp, stamp).run();
}

async function statusOf(id: string): Promise<string> {
  return String((await d1.prepare('SELECT status FROM referral_commissions WHERE id = ?').bind(id).first<{ status: string }>())?.status);
}

async function ledgerCount(): Promise<number> {
  return Number((await d1.prepare('SELECT COUNT(*) AS n FROM referral_ledger').first<{ n: number }>())?.n ?? 0);
}

async function rejectsWith(promise: Promise<unknown>): Promise<{ status: number; code: string; message: string } | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    if (err instanceof AppError) return { status: err.status, code: err.code, message: err.message };
    throw err;
  }
}

function imageRequest(bytes: Uint8Array, type: string, length?: number): Request {
  const headers: Record<string, string> = { 'Content-Type': type };
  if (length !== undefined) headers['Content-Length'] = String(length);
  return new Request('https://zuey.test/api/v1/referrals/payout-profile/id-images/front', { method: 'PUT', headers, body: new Blob([bytes.slice()]) });
}

const VN_DETAILS = { method: 'vn_bank', full_name: 'Nguyễn Văn An', bank_name: 'Vietcombank', bank_account: '0011 2233 44', national_id: '001234567890', address: '12 Lê Lợi, Quận 1, TP.HCM' };

beforeEach(() => {
  d1 = createTestD1();
  r2 = createFakeR2();
  now = T0;
  emails = [];
  envOverrides = {};
  membersRuntime.now = () => now;
  membersRuntime.fetch = async (input: string, init?: RequestInit) => {
    if (input === 'https://api.resend.com/emails') {
      const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      const rec = typeof body === 'object' && body !== null ? Object.fromEntries(Object.entries(body)) : {};
      emails.push({ to: String(Array.isArray(rec.to) ? rec.to[0] : rec.to), subject: String(rec.subject) });
      return new Response(JSON.stringify({ id: `email_${emails.length}` }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('unexpected', { status: 500 });
  };
});

afterEach(() => {
  membersRuntime.now = () => Date.now();
});

describe('Asia/Saigon calendar', () => {
  it('closes the month that just ended and bounds months in local time', () => {
    expect(previousSaigonMonth(NOV_1)).toBe('2026-10');
    expect(previousSaigonMonth(Date.parse('2026-01-01T00:00:00+07:00'))).toBe('2025-12');
    expect(nextCloseDate(T0)).toBe('2026-11-01');
    expect(nextCloseDate(NOV_1)).toBe('2026-11-01');
    expect(nextCloseDate(Date.parse('2026-12-15T00:00:00Z'))).toBe('2027-01-01');
    expect(saigonMonthRange('2026-10')).toEqual({ start: '2026-09-30T17:00:00.000Z', end: '2026-10-31T17:00:00.000Z' });
    expect(saigonMonthRange('2026-13')).toBeNull();
  });
});

describe('maturity', () => {
  it('approves pending commissions once the 30-day hold passes and credits the ledger exactly once', async () => {
    const ref = await referrer('ref@example.com');
    const c = await commission(ref, { cents: 1234 });
    now = T0 + 29 * DAY;
    expect(await matureCommissions(d1, now)).toEqual({ approved: 0, credited: 0 });
    expect(await statusOf(c)).toBe('pending');
    expect(await balanceCents(d1, ref)).toBe(0);

    now = T0 + 30 * DAY;
    expect(await matureCommissions(d1, now)).toEqual({ approved: 1, credited: 1 });
    expect(await statusOf(c)).toBe('approved');
    expect(await balanceCents(d1, ref)).toBe(1234);
    expect(await matureCommissions(d1, now)).toEqual({ approved: 0, credited: 0 });
    expect(await ledgerCount()).toBe(1);
  });

  it('never auto-approves review, skips locked referrers, and approves zero-cent commissions without a ledger line', async () => {
    const ref = await referrer('ref@example.com');
    const review = await commission(ref, { status: 'review' });
    const zero = await commission(ref, { cents: 0 });
    const locked = await referrer('locked@example.com');
    const held = await commission(locked);
    await d1.prepare("UPDATE referral_profiles SET locked_at = ?, lock_reason = 'fraud' WHERE user_id = ?").bind(new Date(T0).toISOString(), locked).run();

    now = T0 + 40 * DAY;
    expect(await matureCommissions(d1, now)).toEqual({ approved: 1, credited: 0 });
    expect(await statusOf(review)).toBe('review');
    expect(await statusOf(zero)).toBe('approved');
    expect(await statusOf(held)).toBe('pending');
    expect(await ledgerCount()).toBe(0);
  });

  it('repairs an approval whose credit was interrupted, and never credits a reversed commission', async () => {
    const ref = await referrer('ref@example.com');
    const approvedNoCredit = await commission(ref, { cents: 700, status: 'approved' });
    await commission(ref, { cents: 900, status: 'reversed' });
    expect((await matureCommissions(d1, now)).credited).toBe(1);
    expect(await balanceCents(d1, ref)).toBe(700);
    expect(await statusOf(approvedNoCredit)).toBe('approved');
  });
});

describe('tiers', () => {
  it('3 successes in 90 days lift R to 25 %; review, reversed, blocked and older ones do not count', async () => {
    const ref = await referrer('ref@example.com');
    now = T0 + 60 * DAY;
    await commission(ref, { status: 'approved', paidAt: T0 });
    await commission(ref, { status: 'approved', paidAt: T0 + 5 * DAY });
    await commission(ref, { status: 'review', paidAt: T0 });
    await commission(ref, { status: 'reversed', paidAt: T0 });
    await commission(ref, { status: 'blocked', paidAt: T0 });
    await commission(ref, { status: 'approved', paidAt: now - 91 * DAY });
    // Pending but still in its hold: not yet a success.
    await commission(ref, { status: 'pending', paidAt: now - DAY });
    expect(await recomputeTiers(d1, now)).toEqual({ updated: 1 });
    let profile = await getReferralProfile(d1, ref);
    expect(profile?.tier_count_90d).toBe(2);
    expect(profile?.tier_rate).toBe(20);

    // Pending with the hold passed counts (e.g. a locked referrer's commission or before the job ran).
    await commission(ref, { status: 'pending', paidAt: T0 + 10 * DAY, holdUntil: now - DAY });
    expect(await recomputeTiers(d1, now)).toEqual({ updated: 1 });
    profile = await getReferralProfile(d1, ref);
    expect(profile?.tier_count_90d).toBe(3);
    expect(profile?.tier_rate).toBe(25);
    expect(profile && effectiveRate(profile, await getReferralSettings(d1))).toBe(25);
    expect(await recomputeTiers(d1, now)).toEqual({ updated: 0 });

    // Successes age out of the 90-day window.
    now = T0 + 101 * DAY;
    await recomputeTiers(d1, now);
    expect((await getReferralProfile(d1, ref))?.tier_rate).toBe(20);
  });
});

describe('day-1 close', () => {
  it('creates VN (−10 %, VND) and PayPal (−18 %) payouts; carries $49.99 and unverified balances; is idempotent', async () => {
    const vn = await referrer('vn@example.com');
    const pp = await referrer('pp@example.com');
    const small = await referrer('small@example.com');
    const unverified = await referrer('unverified@example.com');
    await credit(vn, 10_000);
    await credit(pp, 6_000);
    await credit(small, 4_999);
    await credit(unverified, 7_000);
    await verifiedProfile(vn, 'vn_bank');
    await verifiedProfile(pp, 'paypal');
    await verifiedProfile(small, 'vn_bank');
    await savePayoutProfile(d1, env(), unverified, { method: 'paypal', paypal_email: 'u@example.com' });

    // 2026-10-31 23:59 local: not day 1.
    expect((await closePayoutPeriod(d1, env(), Date.parse('2026-10-31T16:59:00.000Z'))).ran).toBe(false);

    now = NOV_1;
    const first = await closePayoutPeriod(d1, env(), now);
    expect(first.ran).toBe(true);
    expect(first.period).toBe('2026-10');
    expect(first.skipped).toEqual([{ user_id: unverified, reason: 'payout_profile_not_verified' }]);
    const payouts = await listPayouts(d1, { period: '2026-10' });
    expect(payouts).toHaveLength(2);
    const vnPayout = payouts.find(p => p.referrer_user_id === vn);
    expect(vnPayout).toMatchObject({ method: 'vn_bank', gross_cents: 10_000, deduction_bp: 1000, deduction_cents: 1000, net_cents: 9000, usd_vnd_rate: RATE, net_vnd: 2_371_500, status: 'pending' });
    expect(vnPayout?.payee.national_id).toBe('001234567890');
    expect(payouts.find(p => p.referrer_user_id === pp)).toMatchObject({ method: 'paypal', gross_cents: 6000, deduction_bp: 1800, deduction_cents: 1080, net_cents: 4920, net_vnd: null });
    expect(await balanceCents(d1, vn)).toBe(0);
    expect(await balanceCents(d1, pp)).toBe(0);
    expect(await balanceCents(d1, small)).toBe(4_999);
    expect(await balanceCents(d1, unverified)).toBe(7_000);

    const ledgerBefore = await ledgerCount();
    const second = await closePayoutPeriod(d1, env(), now + 5 * 60 * 1000);
    expect(second.created).toEqual([]);
    expect(await ledgerCount()).toBe(ledgerBefore);
    expect(await listPayouts(d1, { period: '2026-10' })).toHaveLength(2);
    expect((await closePayoutPeriod(d1, env(), now + DAY)).ran).toBe(false);
  });

  it('honours the threshold and deduction settings and skips VN payouts without USD_VND_RATE', async () => {
    const vn = await referrer('vn@example.com');
    await credit(vn, 3_000);
    await verifiedProfile(vn, 'vn_bank');
    await d1.prepare("UPDATE referral_settings SET payout_threshold_cents = 2500, vn_deduction_bp = 500 WHERE id = 'default'").run();
    envOverrides = { USD_VND_RATE: undefined };
    now = NOV_1;
    expect((await closePayoutPeriod(d1, env(), now)).skipped).toEqual([{ user_id: vn, reason: 'usd_vnd_rate_missing' }]);
    envOverrides = {};
    const res = await closePayoutPeriod(d1, env(), now);
    expect(res.created).toEqual([expect.objectContaining({ gross_cents: 3000, deduction_cents: 150, net_cents: 2850 })]);
  });

  it('deducts a refund of already paid-out commission at the next close', async () => {
    const ref = await referrer('ref@example.com');
    await verifiedProfile(ref, 'paypal');
    const refunded = await credit(ref, 10_000);
    now = NOV_1;
    const nov = await closePayoutPeriod(d1, env(), now);
    expect(nov.created[0]?.gross_cents).toBe(10_000);
    await markPayoutPaid(d1, env(), nov.created[0].id, 'PAYPAL-TX-1', 'boss@example.com');

    now = NOV_1 + 3 * DAY;
    const reversal = await reverseCommission(d1, { commissionId: refunded }, 'refund');
    expect(reversal).toMatchObject({ outcome: 'reversed', ledger_reversed: true });
    expect(await balanceCents(d1, ref)).toBe(-10_000);
    await credit(ref, 15_000);
    expect(await balanceCents(d1, ref)).toBe(5_000);

    now = DEC_1;
    const dec = await closePayoutPeriod(d1, env(), now);
    expect(dec.period).toBe('2026-11');
    expect(dec.created).toEqual([expect.objectContaining({ referrer_user_id: ref, gross_cents: 5_000, net_cents: 4_100 })]);
    expect(await balanceCents(d1, ref)).toBe(0);
  });
});

describe('admin payout actions', () => {
  async function onePayout(): Promise<{ ref: string; id: string }> {
    const ref = await referrer('ref@example.com');
    await verifiedProfile(ref, 'vn_bank');
    await credit(ref, 8_000);
    now = NOV_1;
    const { created } = await closePayoutPeriod(d1, env(), now);
    return { ref, id: created[0].id };
  }

  it('marks paid with a transaction reference, emails the referrer once, and refuses to cancel afterwards', async () => {
    const { id } = await onePayout();
    expect((await rejectsWith(markPayoutPaid(d1, env(), id, '  ', 'boss@example.com')))?.status).toBe(400);
    const paid = await markPayoutPaid(d1, env(), id, 'VCB-123456', 'boss@example.com');
    expect(paid).toMatchObject({ outcome: 'paid', email: 'sent', payout: { status: 'paid', transaction_ref: 'VCB-123456', paid_by: 'boss@example.com' } });
    expect(emails).toEqual([{ to: 'ref@example.com', subject: 'Zuey đã thanh toán hoa hồng giới thiệu kỳ 2026-10' }]);
    const log = await d1.prepare("SELECT kind, status FROM email_log WHERE idempotency_key = ?").bind(`referral_payout:${id}`).first();
    expect(log).toEqual({ kind: 'referral_payout', status: 'sent' });

    expect((await markPayoutPaid(d1, env(), id, 'VCB-123456', 'boss@example.com')).outcome).toBe('already_paid');
    expect(emails).toHaveLength(1);
    expect((await rejectsWith(cancelPayout(d1, id, 'boss@example.com')))?.code).toBe('payout_paid');
    expect((await rejectsWith(markPayoutPaid(d1, env(), 'rpo_missing', 'x', 'boss@example.com')))?.status).toBe(404);
  });

  it('cancels an unpaid payout back into the balance exactly once', async () => {
    const { ref, id } = await onePayout();
    expect(await balanceCents(d1, ref)).toBe(0);
    expect((await cancelPayout(d1, id, 'boss@example.com', 'wrong account')).outcome).toBe('cancelled');
    expect(await balanceCents(d1, ref)).toBe(8_000);
    expect((await cancelPayout(d1, id, 'boss@example.com')).outcome).toBe('already_cancelled');
    expect(await balanceCents(d1, ref)).toBe(8_000);
    expect((await rejectsWith(markPayoutPaid(d1, env(), id, 'ref', 'boss@example.com')))?.code).toBe('payout_cancelled');
  });

  it('exports a period as CSV with payee details and formula-safe cells', async () => {
    const { id } = await onePayout();
    await d1.prepare("UPDATE referral_payout_profiles SET address = '=HYPERLINK(\"x\")' WHERE 1 = 1").run();
    const csv = await payoutsCsv(d1, '2026-10');
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith('"payout_id","period","status","email"');
    expect(lines[1]).toContain(`"${id}","2026-10","pending","ref@example.com","vn_bank","Nguyen Van A","001234567890","'=HYPERLINK(""x"")"`);
    expect(lines[1]).toContain('"80.00","1000","8.00","72.00","26350","1897200"');
  });
});

describe('payout profiles and national-ID images', () => {
  it('requires both images before review, replaces images, and approval deletes both R2 objects in the same request', async () => {
    const ref = await referrer('ref@example.com');
    const saved = await savePayoutProfile(d1, env(), ref, VN_DETAILS);
    expect(saved).toMatchObject({ method: 'vn_bank', status: 'draft', bank_account: '0011223344', has_id_front: false });

    await uploadIdImage(d1, env(), ref, 'front', imageRequest(JPEG_BYTES, 'image/jpeg'));
    await uploadIdImage(d1, env(), ref, 'front', imageRequest(JPEG_BYTES, 'image/jpeg'));
    expect(r2.objects.size).toBe(1);
    const ready = await uploadIdImage(d1, env(), ref, 'back', imageRequest(PNG_BYTES, 'image/png'));
    expect(ready).toMatchObject({ status: 'submitted', has_id_front: true, has_id_back: true });
    expect(JSON.stringify(ready)).not.toContain('kyc/');
    expect(r2.objects.size).toBe(2);
    for (const key of r2.objects.keys()) expect(key).toMatch(/^kyc\/[A-Za-z0-9_-]{32}$/);

    const image = await readIdImage(d1, env(), ref, 'back', 'boss@example.com');
    expect(image.contentType).toBe('image/png');
    expect(new Uint8Array(image.body)).toEqual(PNG_BYTES);
    const viewed = await d1.prepare("SELECT actor FROM referral_events WHERE action = 'payout_profile.image_viewed'").first();
    expect(viewed).toEqual({ actor: 'boss@example.com' });

    const approved = await decidePayoutProfile(d1, env(), ref, 'approve', 'boss@example.com');
    expect(approved).toMatchObject({ status: 'verified', verified_by: 'boss@example.com', has_id_front: false, has_id_back: false });
    expect(r2.objects.size).toBe(0);
    const keys = await d1.prepare('SELECT id_front_key, id_back_key FROM referral_payout_profiles WHERE user_id = ?').bind(ref).first();
    expect(keys).toEqual({ id_front_key: null, id_back_key: null });
    expect((await rejectsWith(decidePayoutProfile(d1, env(), ref, 'approve', 'boss@example.com')))?.code).toBe('invalid_state');

    // Changing details later needs a fresh review (and fresh images).
    expect((await savePayoutProfile(d1, env(), ref, { ...VN_DETAILS, bank_account: '99887766' })).status).toBe('draft');
  });

  it('rejection also deletes the images; PayPal profiles are reviewable without images', async () => {
    const ref = await referrer('ref@example.com');
    await savePayoutProfile(d1, env(), ref, VN_DETAILS);
    await uploadIdImage(d1, env(), ref, 'front', imageRequest(JPEG_BYTES, 'image/jpeg'));
    expect((await rejectsWith(decidePayoutProfile(d1, env(), ref, 'approve', 'boss@example.com')))?.code).toBe('invalid_state');
    await uploadIdImage(d1, env(), ref, 'back', imageRequest(JPEG_BYTES, 'image/jpeg'));
    expect((await rejectsWith(decidePayoutProfile(d1, env(), ref, 'reject', 'boss@example.com')))?.status).toBe(400);
    const rejected = await decidePayoutProfile(d1, env(), ref, 'reject', 'boss@example.com', 'Ảnh mờ');
    expect(rejected).toMatchObject({ status: 'rejected', reject_reason: 'Ảnh mờ' });
    expect(r2.objects.size).toBe(0);

    await uploadIdImage(d1, env(), ref, 'front', imageRequest(JPEG_BYTES, 'image/jpeg'));
    const paypal = await savePayoutProfile(d1, env(), ref, { method: 'paypal', paypal_email: 'Me@Example.com' });
    expect(paypal).toMatchObject({ status: 'submitted', paypal_email: 'me@example.com', full_name: null, has_id_front: false });
    expect(r2.objects.size).toBe(0);
    expect((await decidePayoutProfile(d1, env(), ref, 'approve', 'boss@example.com')).status).toBe('verified');
  });

  it('validates details and uploads, and names the missing REFERRAL_KYC binding', async () => {
    const ref = await referrer('ref@example.com');
    expect((await rejectsWith(uploadIdImage(d1, env(), ref, 'front', imageRequest(JPEG_BYTES, 'image/jpeg'))))?.code).toBe('payout_profile_required');
    expect((await rejectsWith(savePayoutProfile(d1, env(), ref, { ...VN_DETAILS, national_id: '12345' })))?.code).toBe('invalid_field');
    expect((await rejectsWith(savePayoutProfile(d1, env(), ref, { method: 'paypal', paypal_email: 'nope' })))?.code).toBe('invalid_field');
    expect((await rejectsWith(savePayoutProfile(d1, env(), ref, { method: 'cash' })))?.code).toBe('invalid_field');
    await savePayoutProfile(d1, env(), ref, VN_DETAILS);

    expect((await rejectsWith(uploadIdImage(d1, env(), ref, 'front', imageRequest(JPEG_BYTES, 'image/gif'))))?.status).toBe(415);
    expect((await rejectsWith(uploadIdImage(d1, env(), ref, 'front', imageRequest(PNG_BYTES, 'image/jpeg'))))?.status).toBe(415);
    expect((await rejectsWith(uploadIdImage(d1, env(), ref, 'front', imageRequest(new Uint8Array(0), 'image/jpeg'))))?.status).toBe(400);
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(JPEG_BYTES);
    expect((await rejectsWith(uploadIdImage(d1, env(), ref, 'front', imageRequest(big, 'image/jpeg'))))?.status).toBe(413);
    expect((await rejectsWith(uploadIdImage(d1, env(), ref, 'front', imageRequest(JPEG_BYTES, 'image/jpeg', 6 * 1024 * 1024))))?.status).toBe(413);
    expect(r2.objects.size).toBe(0);

    envOverrides = { REFERRAL_KYC: undefined };
    const missing = await rejectsWith(uploadIdImage(d1, env(), ref, 'front', imageRequest(JPEG_BYTES, 'image/jpeg')));
    expect(missing?.status).toBe(503);
    expect(missing?.message).toContain('REFERRAL_KYC');
    expect((await getPayoutProfile(d1, ref))?.has_id_front).toBe(false);
  });
});

describe('POST /api/v1/referrals/jobs/run', () => {
  async function call(auth?: string): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = auth;
    const request = new Request('https://zuey.test/api/v1/referrals/jobs/run', { method: 'POST', headers, body: '{}' });
    // Handlers only read request/locals; a full APIContext is not constructible in tests.
    const partial = { request, params: {}, url: new URL(request.url), locals: { runtime: { env: env() } } };
    return jobsApi(partial as unknown as APIContext);
  }

  it('runs maturity, tiers and the close for the cron secret only', async () => {
    const ref = await referrer('ref@example.com');
    await commission(ref, { cents: 6_000 });
    await verifiedProfile(ref, 'paypal');
    expect((await call()).status).toBe(401);
    expect((await call('Bearer wrong')).status).toBe(401);

    now = NOV_1 + 30 * DAY; // 2026-12-01 00:30 local, after the hold
    const res = await call('Bearer cron-secret');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body: unknown = await res.json();
    const text = JSON.stringify(body);
    expect(text).not.toContain('"status":"error"');
    expect(text).toContain('"approved":1');
    expect(text).toContain('"period":"2026-11"');
    expect(await balanceCents(d1, ref)).toBe(0);
    expect(await listPayouts(d1, { period: '2026-11' })).toHaveLength(1);
  });
});
