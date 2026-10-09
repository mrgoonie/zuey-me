import { beforeEach, describe, expect, it } from 'bun:test';
import { getCourseOrderByCode } from '../src/lib/courses/course-orders';
import { reverseCourseOrder } from '../src/lib/courses/course-order-payments';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { ensureReferralProfile } from '../src/lib/referrals/codes';
import { POST as checkoutApi } from '../src/pages/api/v1/courses/[course]/checkout';
import { POST as sepayWebhook } from '../src/pages/api/webhooks/sepay';
import type { Member } from './helpers/courses';
import { ctx, field, member, publishedCourse, read, resetCourseState, sepayTime, state } from './helpers/courses';

let txId = 9000;

/** An admin-enabled referrer giving `discount` % of their rate to referees. */
async function referrer(email: string, discount: number): Promise<{ id: string; code: string }> {
  const { user } = await findOrCreateVerifiedUser(state.d1, { email });
  const { code } = await ensureReferralProfile(state.d1, user.id);
  await state.d1.prepare('UPDATE referral_profiles SET discount_percent = ?, admin_enabled = 1 WHERE user_id = ?').bind(discount, user.id).run();
  return { id: user.id, code };
}

async function buy(m: Member, course: string, extra: Record<string, unknown> = {}) {
  return read(await checkoutApi(ctx({ method: 'POST', body: { provider: 'sepay', accept_terms: true, ...extra }, headers: m.browser, params: { course } })));
}

async function pay(code: string): Promise<void> {
  const order = await getCourseOrderByCode(state.d1, code);
  const id = ++txId;
  await sepayWebhook(ctx({
    method: 'POST',
    headers: { Authorization: 'Apikey sepay-key' },
    body: { id, gateway: 'MBBank', transactionDate: sepayTime(state.now), accountNumber: '0123456789', content: `CK ${code}`, transferType: 'in', transferAmount: order?.amount_vnd, referenceCode: `FT${id}` },
  }));
}

async function commissionFor(orderId: string): Promise<Record<string, unknown> | null> {
  return state.d1.prepare("SELECT * FROM referral_commissions WHERE source_kind = 'course_order' AND source_id = ?").bind(orderId).first<Record<string, unknown>>();
}

async function boundTo(userId: string): Promise<unknown> {
  return (await state.d1.prepare('SELECT referred_by_user_id FROM users WHERE id = ?').bind(userId).first<Record<string, unknown>>())?.referred_by_user_id;
}

beforeEach(() => {
  resetCourseState();
  txId = 9000;
});

describe('course referrals', () => {
  it('discounts the first course with a typed code, binds the buyer and pays commission on what was collected', async () => {
    await publishedCourse();
    const ref = await referrer('ref@example.com', 10);
    const lan = await member('lan@example.com');
    const res = await buy(lan, 'ai-product', { referral_code: ref.code });
    expect(res.status).toBe(201);
    expect(field(res.data, 'discount_source')).toBe('referral');
    expect(field(res.data, 'amount_usd_cents')).toBe(4410);
    expect(await boundTo(lan.userId)).toBe(ref.id);

    const code = String(field(res.data, 'code'));
    await pay(code);
    const order = await getCourseOrderByCode(state.d1, code);
    expect(order?.status).toBe('paid');
    const commission = await commissionFor(order?.id ?? '');
    expect(commission?.referrer_user_id).toBe(ref.id);
    const base = Number(commission?.base_amount_cents);
    expect(Math.abs(base - 4410)).toBeLessThan(5);
    expect(commission?.commission_cents).toBe(Math.floor((base * Number(commission?.commission_percent)) / 100));
  });

  it('keeps earning commission on every later course of a bound account, and reverses it on refund', async () => {
    await publishedCourse();
    await publishedCourse({ slug: 'second-course', title: 'Khoá thứ hai' });
    const ref = await referrer('ref@example.com', 10);
    const lan = await member('lan@example.com');
    await pay(String(field((await buy(lan, 'ai-product', { referral_code: ref.code })).data, 'code')));

    // Already a paying customer: the first-order rule would refuse a new referee, but the binding still applies.
    const second = await buy(lan, 'second-course');
    expect(field(second.data, 'discount_source')).toBe('referral');
    const code = String(field(second.data, 'code'));
    await pay(code);
    const order = await getCourseOrderByCode(state.d1, code);
    expect((await commissionFor(order?.id ?? ''))?.status).toBe('pending');

    if (order) await reverseCourseOrder(state.d1, order, 'refunded', 'admin_refund');
    expect((await commissionFor(order?.id ?? ''))?.status).toBe('reversed');
  });

  it('refuses a code for a self-referral and for a buyer who already paid without a referrer', async () => {
    await publishedCourse();
    await publishedCourse({ slug: 'second-course', title: 'Khoá thứ hai' });
    const self = await referrer('lan@example.com', 10);
    const lan = await member('lan@example.com');
    expect((await buy(lan, 'ai-product', { referral_code: self.code })).code).toBe('referral_code_invalid');

    const ref = await referrer('ref@example.com', 10);
    const hoa = await member('hoa@example.com');
    await pay(String(field((await buy(hoa, 'ai-product')).data, 'code')));
    expect((await buy(hoa, 'second-course', { referral_code: ref.code })).code).toBe('referral_code_invalid');
    expect(await boundTo(hoa.userId)).toBeNull();
  });
});
