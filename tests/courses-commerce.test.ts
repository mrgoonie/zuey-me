import { beforeEach, describe, expect, it } from 'bun:test';
import { ownsCourse } from '../src/lib/courses/course-access';
import { getCourseOrderByCode } from '../src/lib/courses/course-orders';
import { applyDodoCourseWebhook } from '../src/lib/courses/course-payment-webhooks';
import { DEFAULT_PLAN_DISCOUNTS, quoteCoursePrice } from '../src/lib/courses/course-pricing';
import type { CourseRecord } from '../src/lib/courses/course-types';
import { GET as catalogApi } from '../src/pages/api/v1/courses/index';
import { POST as checkoutApi } from '../src/pages/api/v1/courses/[course]/checkout';
import { POST as resolveApi } from '../src/pages/api/v1/admin/course-orders/[code]/resolve';
import { POST as sepayWebhook } from '../src/pages/api/webhooks/sepay';
import type { Member } from './helpers/courses';
import { ctx, env, field, member, publishedCourse, read, resetCourseState, sepayTime, state } from './helpers/courses';

let txId = 7000;

function checkout(m: Member | null, body: Record<string, unknown>, course = 'ai-product') {
  return checkoutApi(ctx({ method: 'POST', body, headers: m?.browser ?? {}, params: { course } }));
}

async function sepayOrder(m: Member): Promise<{ code: string; amount: number }> {
  const res = await read(await checkout(m, { provider: 'sepay', accept_terms: true }));
  expect(res.status).toBe(201);
  return { code: String(field(res.data, 'code')), amount: Number(field(res.data, 'amount_vnd')) };
}

async function payTransfer(code: string, amount: number, id = ++txId) {
  const res = await sepayWebhook(ctx({
    method: 'POST',
    headers: { Authorization: 'Apikey sepay-key' },
    body: { id, gateway: 'MBBank', transactionDate: sepayTime(state.now), accountNumber: '0123456789', content: `CK ${code}`, transferType: 'in', transferAmount: amount, referenceCode: `FT${id}` },
  }));
  return field(await read(res), 'data');
}

function dodo(eventId: string, type: string, data: Record<string, unknown>) {
  return applyDodoCourseWebhook(state.d1, env(), eventId, { type, data });
}

beforeEach(() => {
  resetCourseState();
  txId = 7000;
});

describe('course pricing', () => {
  const course = { price_usd_cents: 10_000, plan_discounts: null } as unknown as CourseRecord;
  const quote = (plans: string[], referralPct: number) =>
    quoteCoursePrice({ course, table: DEFAULT_PLAN_DISCOUNTS, activePlans: plans as never, referralPct, usdVndRate: 26_000 });

  it('applies the best plan discount and never stacks it with a referral', () => {
    expect(quote([], 0)).toMatchObject({ amount_usd_cents: 10_000, discount_source: 'none' });
    expect(quote(['knowledges', 'community'], 0)).toMatchObject({ applied_pct: 40, subscriber_plan: 'community', amount_usd_cents: 6_000 });
    expect(quote(['combo'], 30)).toMatchObject({ applied_pct: 30, discount_source: 'referral', amount_usd_cents: 7_000 });
    expect(quote(['community'], 30)).toMatchObject({ applied_pct: 40, discount_source: 'subscriber' });
  });

  it('honours a per-course override of the plan table', () => {
    const special = { price_usd_cents: 10_000, plan_discounts: { community: 15 } } as unknown as CourseRecord;
    const q = quoteCoursePrice({ course: special, table: DEFAULT_PLAN_DISCOUNTS, activePlans: ['community'], referralPct: 0, usdVndRate: 26_000 });
    expect(q.applied_pct).toBe(15);
  });
});

describe('course checkout and SePay', () => {
  it('lists the catalog publicly and requires sign-in and accepted terms to buy', async () => {
    await publishedCourse();
    const cat = await read(await catalogApi(ctx()));
    expect(cat.status).toBe(200);
    expect(Array.isArray(cat.data) ? cat.data.map(c => [field(c, 'slug'), field(c, 'trial_lesson_count'), field(c, 'price', 'amount_usd_cents')]) : null)
      .toEqual([['ai-product', 1, 4900]]);

    expect((await read(await checkout(null, { accept_terms: true }))).status).toBe(401);
    const lan = await member('lan@example.com');
    expect((await read(await checkout(lan, { provider: 'sepay' }))).code).toBe('terms_required');
  });

  it('grants the course once on a full transfer, ignores replays and refuses a second purchase', async () => {
    const { course } = await publishedCourse();
    const lan = await member('lan@example.com');
    const { code, amount } = await sepayOrder(lan);
    expect(code.startsWith('ZSC')).toBe(true);
    expect(amount).toBe(4900 * 260);

    expect(await payTransfer(code, amount, 1)).toMatchObject({ outcome: 'paid' });
    expect(await payTransfer(code, amount, 1)).toMatchObject({ outcome: 'duplicate_event' });
    expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(true);
    expect(state.emails.length).toBe(1);
    expect((await read(await checkout(lan, { provider: 'sepay', accept_terms: true }))).code).toBe('already_owned');
  });

  it('flags an underpaid transfer for the admin, who can grant it', async () => {
    const { course } = await publishedCourse();
    const lan = await member('lan@example.com');
    const boss = await member('boss@example.com');
    const { code, amount } = await sepayOrder(lan);
    expect(await payTransfer(code, amount - 1000)).toMatchObject({ outcome: 'needs_attention' });
    expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);

    const resolve = (m: Member, body: unknown) => resolveApi(ctx({ method: 'POST', body, headers: m.browser, params: { code } }));
    expect((await read(await resolve(lan, { action: 'grant' }))).status).toBe(403);
    expect((await read(await resolve(boss, { action: 'grant', reason: 'thiếu 1.000đ' }))).status).toBe(200);
    expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(true);
  });

  it('does not sell drafts or free courses', async () => {
    await publishedCourse({ status: 'draft' });
    const lan = await member('lan@example.com');
    expect((await read(await checkout(lan, { accept_terms: true }))).status).toBe(404);
  });
});

describe('Dodo course payments, refunds and disputes', () => {
  async function paidByCard(m: Member): Promise<string> {
    const res = await read(await checkout(m, { provider: 'dodo', accept_terms: true }));
    expect(res.status).toBe(201);
    expect(field(res.data, 'checkout_url')).toBe('https://checkout.dodo.test/cks_1');
    const code = String(field(res.data, 'code'));
    const result = await dodo(`evt_pay_${code}`, 'payment.succeeded', {
      payment_id: `pay_${code}`, total_amount: 4900, currency: 'USD', metadata: { course_order: code, user_id: m.userId },
    });
    expect(result).toMatchObject({ outcome: 'paid' });
    return code;
  }

  it('ignores Dodo events that are not about courses', async () => {
    expect(await dodo('evt_x', 'subscription.active', { subscription_id: 'sub_1' })).toBeNull();
    expect(await dodo('evt_y', 'payment.succeeded', { payment_id: 'p', metadata: {} })).toBeNull();
  });

  it('revokes on refund and on an opened dispute, and restores when the dispute is won', async () => {
    const { course } = await publishedCourse();
    const lan = await member('lan@example.com');
    const code = await paidByCard(lan);
    expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(true);

    expect(await dodo('evt_d1', 'dispute.opened', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'reversed' });
    expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
    expect(await dodo('evt_d2', 'dispute.won', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'restored' });
    expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(true);

    expect(await dodo('evt_r1', 'refund.succeeded', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'reversed' });
    expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
    expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('refunded');
  });

  it('flags a duplicate purchase and refunding it keeps the original access', async () => {
    const { course } = await publishedCourse();
    const lan = await member('lan@example.com');
    const transfer = await sepayOrder(lan);
    const card = await read(await checkout(lan, { provider: 'dodo', accept_terms: true }));
    const cardCode = String(field(card.data, 'code'));
    expect(await payTransfer(transfer.code, transfer.amount)).toMatchObject({ outcome: 'paid' });

    await dodo('evt_dup', 'payment.succeeded', { payment_id: 'pay_dup', total_amount: 4900, currency: 'USD', metadata: { course_order: cardCode, user_id: lan.userId } });
    expect((await getCourseOrderByCode(state.d1, cardCode))?.attention_reason).toBe('already_owned');
    await dodo('evt_dup_refund', 'refund.succeeded', { payment_id: 'pay_dup' });
    expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(true);
  });

  it('flags a card charge below the quoted price', async () => {
    const { course } = await publishedCourse();
    const lan = await member('lan@example.com');
    const card = await read(await checkout(lan, { provider: 'dodo', accept_terms: true }));
    const code = String(field(card.data, 'code'));
    const res = await dodo('evt_low', 'payment.succeeded', { payment_id: 'pay_low', total_amount: 100, currency: 'USD', metadata: { course_order: code, user_id: lan.userId } });
    expect(res).toMatchObject({ outcome: 'needs_attention' });
    expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
  });
});
