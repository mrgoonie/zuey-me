import { beforeEach, describe, expect, it } from 'bun:test';
import { getCourseOrderByCode } from '../src/lib/courses/course-orders';
import { DEFAULT_PLAN_DISCOUNTS, quoteCoursePrice } from '../src/lib/courses/course-pricing';
import type { CourseRecord } from '../src/lib/courses/course-types';
import { createPromo } from '../src/lib/promos/promo-codes';
import { POST as checkoutApi } from '../src/pages/api/v1/courses/[course]/checkout';
import { POST as sepayWebhook } from '../src/pages/api/webhooks/sepay';
import type { Member } from './helpers/courses';
import { ctx, field, member, publishedCourse, read, resetCourseState, sepayTime, state } from './helpers/courses';

let txId = 9500;

async function buy(m: Member, course: string, extra: Record<string, unknown> = {}) {
  return read(await checkoutApi(ctx({ method: 'POST', body: { provider: 'sepay', accept_terms: true, ...extra }, headers: m.browser, params: { course } })));
}

async function payRow(code: string): Promise<Record<string, unknown> | null> {
  return state.d1.prepare('SELECT * FROM course_orders WHERE code = ?').bind(code).first<Record<string, unknown>>();
}

beforeEach(() => {
  resetCourseState();
});

describe('course pricing with a promo', () => {
  const course = { price_usd_cents: 10_000, plan_discounts: null } as unknown as CourseRecord;
  const quote = (plans: string[], referralPct: number, promoPct: number) =>
    quoteCoursePrice({ course, table: DEFAULT_PLAN_DISCOUNTS, activePlans: plans as never, referralPct, promoPct, usdVndRate: 26_000 });

  it('takes the largest discount; ties go subscriber, then referral, then promo', () => {
    expect(quote([], 0, 30)).toMatchObject({ applied_pct: 30, discount_source: 'promo', amount_usd_cents: 7_000 });
    expect(quote([], 30, 30)).toMatchObject({ discount_source: 'referral' });
    expect(quote(['community'], 0, 40)).toMatchObject({ discount_source: 'subscriber' });
    expect(quote(['community'], 20, 50)).toMatchObject({ applied_pct: 50, discount_source: 'promo' });
    expect(quote([], 0, 100)).toMatchObject({ amount_usd_cents: 0, amount_vnd: 0 });
  });
});

describe('course checkout with a promo', () => {
  it('charges the promo price, redeems on payment and activates the invoice request', async () => {
    const { course } = await publishedCourse();
    await createPromo(state.d1, { code: 'HOC30', percent: 30, products: ['course'] }, 'test');
    const m = await member('lan@example.com');
    const res = await buy(m, course.slug, { discount_code: 'hoc30', invoice: { tax_id: '0312345678', email: 'ketoan@acme.vn' } });
    expect(res.status).toBe(201);
    expect(field(res.data, 'discount_source')).toBe('promo');
    expect(field(res.data, 'promo_code')).toBe('HOC30');
    expect(field(res.data, 'amount_usd_cents')).toBe(3430);
    expect(field(res.data, 'invoice', 'status')).toBe('awaiting_payment');

    const code = String(field(res.data, 'code'));
    const order = await getCourseOrderByCode(state.d1, code);
    const id = ++txId;
    await sepayWebhook(ctx({
      method: 'POST', headers: { Authorization: 'Apikey sepay-key' },
      body: { id, gateway: 'MBBank', transactionDate: sepayTime(state.now), accountNumber: '0123456789', content: `CK ${code}`, transferType: 'in', transferAmount: order?.amount_vnd, referenceCode: `FT${id}` },
    }));
    expect((await payRow(code))?.status).toBe('paid');
    const use = await state.d1.prepare('SELECT status FROM promo_redemptions WHERE source_code = ?').bind(code).first<{ status: string }>();
    expect(use?.status).toBe('redeemed');
    const inv = await state.d1.prepare('SELECT status FROM invoice_requests WHERE source_code = ?').bind(code).first<{ status: string }>();
    expect(inv?.status).toBe('requested');
    expect(state.emails.some(s => s.includes(code))).toBe(true);
  });

  it('enrols at once with a 100% code and rejects a code limited to another course', async () => {
    const { course } = await publishedCourse();
    await createPromo(state.d1, { code: 'FREECOURSE', percent: 100 }, 'test');
    await createPromo(state.d1, { code: 'OTHERCOURSE', percent: 50, course_ids: ['crs_other'] }, 'test');
    const m = await member('lan@example.com');
    const other = await buy(m, course.slug, { discount_code: 'OTHERCOURSE' });
    expect(other.code).toBe('promo_code_invalid');
    const free = await buy(m, course.slug, { discount_code: 'FREECOURSE' });
    expect(free.status).toBe(201);
    expect(field(free.data, 'status')).toBe('paid');
    expect(field(free.data, 'amount_usd_cents')).toBe(0);
  });
});
