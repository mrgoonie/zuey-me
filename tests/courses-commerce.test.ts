import { beforeEach, describe, expect, it } from 'bun:test';
import { ownsCourse } from '../src/lib/courses/course-access';
import { getCourseOrderByCode } from '../src/lib/courses/course-orders';
import { resolveCourseOrder } from '../src/lib/courses/course-order-payments';
import { applyCourseSepayPayment, applyDodoCourseWebhook } from '../src/lib/courses/course-payment-webhooks';
import { DEFAULT_PLAN_DISCOUNTS, quoteCoursePrice } from '../src/lib/courses/course-pricing';
import type { CourseRecord } from '../src/lib/courses/course-types';
import { GET as catalogApi } from '../src/pages/api/v1/courses/index';
import { POST as checkoutApi } from '../src/pages/api/v1/courses/[course]/checkout';
import { POST as resolveApi } from '../src/pages/api/v1/admin/course-orders/[code]/resolve';
import { GET as listOrdersApi } from '../src/pages/api/v1/admin/course-orders/index';
import { DELETE as revokeOwnerApi, POST as grantOwnerApi } from '../src/pages/api/v1/admin/courses/[course]/owners';
import { coursesMcpModule } from '../src/lib/courses/course-mcp';
import type { McpContext } from '../src/lib/mcp/types';
import { POST as sepayWebhook } from '../src/pages/api/webhooks/sepay';
import { POST as dodoWebhook } from '../src/pages/api/webhooks/dodo';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { createPromo } from '../src/lib/promos/promo-codes';
import { ensureReferralProfile } from '../src/lib/referrals/codes';
import { experienceRuntime } from '../src/lib/experience/runtime';
import { signDodoPayload } from '../src/lib/payments/dodo';
import type { Member } from './helpers/courses';
import { crashingD1 as crashingTestD1 } from './helpers/d1';
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
  async function paidByCard(m: Member, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await read(await checkout(m, { provider: 'dodo', accept_terms: true, ...extra }));
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

  it('reports a chargeback only when a dispute is lost, and a won dispute is not a second purchase', async () => {
    await publishedCourse();
    const lan = await member('lan@example.com');
    const code = await paidByCard(lan);
    const events = (event: string) => state.d1.raw
      .query<{ dedupe_key: string; properties: string }, [string]>('SELECT dedupe_key, properties FROM analytics_outbox WHERE event = ? ORDER BY created_at')
      .all(event);
    expect(events('purchase')).toHaveLength(1);

    await dodo('evt_o1', 'dispute.opened', { payment_id: `pay_${code}` });
    expect(events('refund')).toHaveLength(0);
    await dodo('evt_w1', 'dispute.won', { payment_id: `pay_${code}` });
    expect(events('purchase')).toHaveLength(1);
    expect(events('refund')).toHaveLength(0);

    await dodo('evt_o2', 'dispute.opened', { payment_id: `pay_${code}` });
    await dodo('evt_l1', 'dispute.lost', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' });
    await dodo('evt_l2', 'dispute.lost', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' });
    const refunds = events('refund');
    expect(refunds).toHaveLength(1);
    expect(JSON.parse(refunds[0].properties)).toMatchObject({ provider: 'dodo', order_type: 'course', reason: 'chargeback', amount: 49, currency: 'USD' });
  });

  const refundKeys = () => state.d1.raw
    .query<{ dedupe_key: string }, []>("SELECT dedupe_key FROM analytics_outbox WHERE event = 'refund' ORDER BY created_at").all().map(r => r.dedupe_key);

  for (const outcome of ['dispute.accepted', 'dispute.expired']) {
    it(`revokes access and reports one chargeback on ${outcome}, whichever funds-lost outcome follows`, async () => {
      const { course } = await publishedCourse();
      const lan = await member('lan@example.com');
      const code = await paidByCard(lan);
      const order = await getCourseOrderByCode(state.d1, code);
      expect(await dodo('evt_lost', outcome, { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'reversed' });
      expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
      expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('charged_back');
      expect(await dodo('evt_lost_again', 'dispute.lost', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'ignored' });
      expect(refundKeys()).toEqual([`refund:dodo:course_order:${order?.id}:charged_back`]);
    });
  }

  it('restores access on dispute.cancelled after dispute.opened and reports no chargeback', async () => {
    const { course } = await publishedCourse();
    const lan = await member('lan@example.com');
    const code = await paidByCard(lan);
    expect(await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'reversed' });
    expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
    expect(await dodo('evt_cancel', 'dispute.cancelled', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'restored' });
    expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(true);
    expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('paid');
    expect(refundKeys()).toEqual([]);
  });

  for (const outcome of ['dispute.won', 'dispute.cancelled']) {
    it(`keeps access when ${outcome} arrives before its dispute.opened`, async () => {
      const { course } = await publishedCourse();
      const lan = await member('lan@example.com');
      const code = await paidByCard(lan);
      expect(await dodo('evt_end', outcome, { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'ignored' });
      expect(await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'ignored' });
      expect(await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'duplicate_event' });
      expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(true);
      expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('paid');
      expect(refundKeys()).toEqual([]);

      // A later dispute of the same payment still takes access away.
      expect(await dodo('evt_open_2', 'dispute.opened', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'reversed' });
      expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
    });
  }

  it('flags a won dispute of a deleted course for the admin without granting access', async () => {
    const { course } = await publishedCourse();
    const lan = await member('lan@example.com');
    const code = await paidByCard(lan);
    expect(await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'reversed' });
    await state.d1.prepare('UPDATE courses SET deleted_at = ? WHERE id = ?').bind(new Date(state.now).toISOString(), course.id).run();

    expect(await dodo('evt_won', 'dispute.won', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'needs_attention' });
    expect(await dodo('evt_won', 'dispute.won', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'duplicate_event' });
    expect(await getCourseOrderByCode(state.d1, code)).toMatchObject({ status: 'needs_attention', attention_reason: 'course_missing', amount_paid: 4900 });
    expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
    const attention = state.d1.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM analytics_outbox WHERE event = 'payment_needs_attention'").get()?.n;
    expect(attention).toBe(1);
  });

  it('counts the money back of a course order once when it is both refunded and lost in a dispute, in either order', async () => {
    await publishedCourse();
    const refundedFirst = await paidByCard(await member('lan@example.com'));
    const refundedOrder = await getCourseOrderByCode(state.d1, refundedFirst);
    expect(await dodo('evt_r_a', 'refund.succeeded', { payment_id: `pay_${refundedFirst}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'reversed' });
    // A Visa RDR resolution, or a chargeback filed after the refund, is the same money.
    expect(await dodo('evt_l_a', 'dispute.lost', { payment_id: `pay_${refundedFirst}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'ignored' });
    expect(refundKeys()).toEqual([`refund:dodo:course_order:${refundedOrder?.id}:refunded`]);

    const lostFirst = await paidByCard(await member('mai@example.com'));
    const lostOrder = await getCourseOrderByCode(state.d1, lostFirst);
    expect(await dodo('evt_l_b', 'dispute.lost', { payment_id: `pay_${lostFirst}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'reversed' });
    expect(await dodo('evt_r_b', 'refund.succeeded', { payment_id: `pay_${lostFirst}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'ignored' });
    expect(refundKeys()).toEqual([
      `refund:dodo:course_order:${refundedOrder?.id}:refunded`, `refund:dodo:course_order:${lostOrder?.id}:charged_back`,
    ]);
  });

  it('counts a chargeback after a partial refund of a course order, and no partial refund after a chargeback', async () => {
    const { course } = await publishedCourse();
    const lan = await member('lan@example.com');
    const partlyRefunded = await paidByCard(lan);
    const partlyOrder = await getCourseOrderByCode(state.d1, partlyRefunded);
    expect(await dodo('evt_pr_a', 'refund.succeeded', { payment_id: `pay_${partlyRefunded}`, amount: 1000, currency: 'USD' })).toMatchObject({ outcome: 'reversed' });
    // Any refund still revokes access.
    expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
    expect((await getCourseOrderByCode(state.d1, partlyRefunded))?.attention_reason).toBe('dodo_partial_refund');
    expect(await dodo('evt_pl_a', 'dispute.lost', { payment_id: `pay_${partlyRefunded}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'ignored' });
    expect(refundKeys()).toEqual([
      `refund:dodo:course_order:${partlyOrder?.id}:refunded`, `refund:dodo:course_order:${partlyOrder?.id}:charged_back`,
    ]);

    const lostFirst = await paidByCard(await member('mai@example.com'));
    const lostOrder = await getCourseOrderByCode(state.d1, lostFirst);
    expect(await dodo('evt_pl_b', 'dispute.lost', { payment_id: `pay_${lostFirst}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'reversed' });
    expect(await dodo('evt_pr_b', 'refund.succeeded', { payment_id: `pay_${lostFirst}`, amount: 1000, currency: 'USD' })).toMatchObject({ outcome: 'ignored' });
    expect(refundKeys()).toEqual([
      `refund:dodo:course_order:${partlyOrder?.id}:refunded`, `refund:dodo:course_order:${partlyOrder?.id}:charged_back`,
      `refund:dodo:course_order:${lostOrder?.id}:charged_back`,
    ]);
  });

  describe('a late payment of a refunded or disputed order', () => {
    const count = (sql: string, ...values: string[]) => state.d1.raw.query<{ n: number }, string[]>(sql).get(...values)?.n;
    const purchases = () => count("SELECT COUNT(*) AS n FROM analytics_outbox WHERE event = 'purchase'");
    const attentionEvents = () => count("SELECT COUNT(*) AS n FROM analytics_outbox WHERE event = 'payment_needs_attention'");
    const paidLogs = () => count("SELECT COUNT(*) AS n FROM user_activity WHERE action = 'courses.order_paid'");
    const attentionLogs = () => state.d1.raw
      .query<{ detail: string }, []>("SELECT detail FROM user_activity WHERE action = 'courses.order_attention'").all().map(r => JSON.parse(r.detail));
    const gateRows = (eventId: string) => count("SELECT COUNT(*) AS n FROM payment_events WHERE provider = 'dodo' AND event_id = ?", eventId);
    const reversals = () => count("SELECT COUNT(*) AS n FROM referral_events WHERE action = 'commission.reversed'");

    async function referredCardOrder(): Promise<{ code: string; userId: string; courseId: string; orderId: string }> {
      const { course } = await publishedCourse();
      const { user: ref } = await findOrCreateVerifiedUser(state.d1, { email: 'ref@example.com' });
      const { code: referralCode } = await ensureReferralProfile(state.d1, ref.id);
      await state.d1.prepare('UPDATE referral_profiles SET discount_percent = 10, admin_enabled = 1 WHERE user_id = ?').bind(ref.id).run();
      const lan = await member('lan@example.com');
      const code = await paidByCard(lan, { referral_code: referralCode });
      const order = await getCourseOrderByCode(state.d1, code);
      return { code, userId: lan.userId, courseId: course.id, orderId: order?.id ?? '' };
    }
    const commission = (orderId: string) => state.d1.prepare("SELECT status FROM referral_commissions WHERE source_kind = 'course_order' AND source_id = ?")
      .bind(orderId).first<{ status: string }>();
    const latePayment = (code: string, userId: string, paymentId = `pay_${code}`) => ({
      payment_id: paymentId, total_amount: 4900, currency: 'USD', metadata: { course_order: code, user_id: userId },
    });

    const reversedBy = [
      { name: 'a refund', status: 'refunded', reverse: (code: string) => dodo('evt_refund', 'refund.succeeded', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' }) },
      { name: 'an opened dispute', status: 'charged_back', reverse: (code: string) => dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` }) },
    ];
    for (const r of reversedBy) {
      it(`keeps an order reversed by ${r.name} when the payment.succeeded of the same payment arrives late, and records it once`, async () => {
        const { code, userId, courseId, orderId } = await referredCardOrder();
        expect(await r.reverse(code)).toMatchObject({ outcome: 'reversed' });
        const before = await getCourseOrderByCode(state.d1, code);
        const emails = state.emails.length;

        // A redelivery under a new event id, or an out-of-order delivery of the original payment.
        expect(await dodo('evt_late', 'payment.succeeded', latePayment(code, userId))).toMatchObject({ outcome: 'ignored' });
        expect(await dodo('evt_late', 'payment.succeeded', latePayment(code, userId))).toMatchObject({ outcome: 'duplicate_event' });
        expect(gateRows('evt_late')).toBe(1);
        expect(await getCourseOrderByCode(state.d1, code)).toMatchObject({
          status: r.status, attention_reason: before?.attention_reason, paid_at: before?.paid_at, amount_paid: 4900, provider_payment_id: `pay_${code}`,
        });
        expect(await ownsCourse(state.d1, userId, courseId)).toBe(false);
        expect((await commission(orderId))?.status).toBe('reversed');
        expect(reversals()).toBe(1);
        expect(purchases()).toBe(1);
        expect(paidLogs()).toBe(1);
        expect(attentionEvents()).toBe(0);
        expect(attentionLogs()).toEqual([]);
        expect(state.emails.length).toBe(emails);
      });

      it(`flags a new payment on an order reversed by ${r.name} for the admin without paying it or granting access`, async () => {
        const { code, userId, courseId, orderId } = await referredCardOrder();
        expect(await r.reverse(code)).toMatchObject({ outcome: 'reversed' });
        const before = await getCourseOrderByCode(state.d1, code);

        const reason = r.status === 'refunded' ? 'payment_after_refund' : 'payment_after_dispute';
        expect(await dodo('evt_new', 'payment.succeeded', latePayment(code, userId, 'pay_second'))).toMatchObject({ outcome: 'needs_attention' });
        expect(await dodo('evt_new', 'payment.succeeded', latePayment(code, userId, 'pay_second'))).toMatchObject({ outcome: 'duplicate_event' });
        expect(gateRows('evt_new')).toBe(1);
        // The order keeps its terminal status and payment id, so the refund and dispute flows still find it.
        expect(await getCourseOrderByCode(state.d1, code)).toMatchObject({
          status: r.status, attention_reason: before?.attention_reason, amount_paid: 4900, provider_payment_id: `pay_${code}`,
        });
        expect(await ownsCourse(state.d1, userId, courseId)).toBe(false);
        expect((await commission(orderId))?.status).toBe('reversed');
        expect(purchases()).toBe(1);
        expect(paidLogs()).toBe(1);
        expect(attentionEvents()).toBe(1);
        expect(attentionLogs()).toEqual([{ code, reason, amount: 4900, payment_id: 'pay_second' }]);
      });
    }

    it('still restores a disputed order that a late payment.succeeded left charged back when the dispute is won', async () => {
      const { code, userId, courseId } = await referredCardOrder();
      expect(await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'reversed' });
      expect(await dodo('evt_late', 'payment.succeeded', latePayment(code, userId))).toMatchObject({ outcome: 'ignored' });
      expect(await dodo('evt_won', 'dispute.won', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'restored' });
      expect(await ownsCourse(state.d1, userId, courseId)).toBe(true);
      expect(purchases()).toBe(1);
    });

    it('does not pay an order again when a refund lands between the read and the payment batch of a redelivery', async () => {
      const { course } = await publishedCourse();
      const lan = await member('lan@example.com');
      const code = String(field((await read(await checkout(lan, { provider: 'dodo', accept_terms: true }))).data, 'code'));
      // The redelivery read the order still pending; the first delivery pays it and the refund lands before its batch.
      let fired = false;
      const d1: D1DatabaseLike = {
        prepare: sql => state.d1.prepare(sql),
        async batch(statements) {
          if (!fired) {
            fired = true;
            expect(await dodo('evt_first', 'payment.succeeded', latePayment(code, lan.userId))).toMatchObject({ outcome: 'paid' });
            expect(await dodo('evt_refund', 'refund.succeeded', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'reversed' });
          }
          return state.d1.batch(statements);
        },
      };
      expect(await applyDodoCourseWebhook(d1, env(), 'evt_again', { type: 'payment.succeeded', data: latePayment(code, lan.userId) }))
        .toMatchObject({ outcome: 'ignored' });
      expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('refunded');
      expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
      expect(gateRows('evt_again')).toBe(1);
      expect(purchases()).toBe(1);
      expect(paidLogs()).toBe(1);
    });

    it('does not reopen a flagged order that an admin refunds between the read and the flag batch of a redelivery', async () => {
      await publishedCourse();
      const lan = await member('lan@example.com');
      const code = String(field((await read(await checkout(lan, { provider: 'dodo', accept_terms: true }))).data, 'code'));
      const low = { ...latePayment(code, lan.userId, 'pay_low'), total_amount: 100 };
      expect(await dodo('evt_low', 'payment.succeeded', low)).toMatchObject({ outcome: 'needs_attention' });
      let fired = false;
      const d1: D1DatabaseLike = {
        prepare: sql => state.d1.prepare(sql),
        async batch(statements) {
          if (!fired) {
            fired = true;
            expect((await resolveCourseOrder(state.d1, env(), code, 'refund', 'underpaid')).status).toBe('refunded');
          }
          return state.d1.batch(statements);
        },
      };
      expect(await applyDodoCourseWebhook(d1, env(), 'evt_low_again', { type: 'payment.succeeded', data: low })).toMatchObject({ outcome: 'ignored' });
      expect(await getCourseOrderByCode(state.d1, code)).toMatchObject({ status: 'refunded', attention_reason: 'underpaid', amount_paid: 100 });
      expect(gateRows('evt_low_again')).toBe(1);
      expect(attentionEvents()).toBe(1);
    });

    for (const from of [{ status: 'expired', reason: null }, { status: 'needs_attention', reason: 'underpaid' }]) {
      it(`still pays an ${from.status} card order on its payment.succeeded`, async () => {
        const { course } = await publishedCourse();
        const lan = await member('lan@example.com');
        const code = String(field((await read(await checkout(lan, { provider: 'dodo', accept_terms: true }))).data, 'code'));
        await state.d1.prepare('UPDATE course_orders SET status = ?, attention_reason = ? WHERE code = ?').bind(from.status, from.reason, code).run();
        expect(await dodo('evt_pay', 'payment.succeeded', latePayment(code, lan.userId))).toMatchObject({ outcome: 'paid' });
        expect(await dodo('evt_pay', 'payment.succeeded', latePayment(code, lan.userId))).toMatchObject({ outcome: 'duplicate_event' });
        expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('paid');
        expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(true);
        expect(purchases()).toBe(1);
      });
    }
  });

  describe('a refund while a dispute is open', () => {
    const refundRows = () => state.d1.raw
      .query<{ dedupe_key: string; properties: string }, []>("SELECT dedupe_key, properties FROM analytics_outbox WHERE event = 'refund' ORDER BY created_at").all();
    const purchases = () => state.d1.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM analytics_outbox WHERE event = 'purchase'").get()?.n;

    for (const refund of [{ kind: 'full', amount: 4900, reason: 'dodo_refund', partial: false }, { kind: 'partial', amount: 1000, reason: 'dodo_partial_refund', partial: true }]) {
      for (const outcome of ['dispute.won', 'dispute.cancelled']) {
        it(`counts a ${refund.kind} refund once and keeps access revoked when the dispute ends in ${outcome}`, async () => {
          const { course } = await publishedCourse();
          const lan = await member('lan@example.com');
          const code = await paidByCard(lan);
          const order = await getCourseOrderByCode(state.d1, code);
          const refundEvent = { payment_id: `pay_${code}`, amount: refund.amount, currency: 'USD' };
          expect(await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'reversed' });
          expect(await dodo('evt_refund', 'refund.succeeded', refundEvent)).toMatchObject({ outcome: 'reversed' });
          expect(await dodo('evt_refund', 'refund.succeeded', refundEvent)).toMatchObject({ outcome: 'duplicate_event' });
          expect(await getCourseOrderByCode(state.d1, code)).toMatchObject({ status: 'refunded', attention_reason: refund.reason });

          expect(await dodo('evt_end', outcome, { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'ignored' });
          expect(await dodo('evt_end', outcome, { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'duplicate_event' });
          expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
          expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('refunded');

          const rows = refundRows();
          expect(rows.map(r => r.dedupe_key)).toEqual([`refund:dodo:course_order:${order?.id}:refunded`]);
          expect(JSON.parse(rows[0].properties)).toMatchObject({
            provider: 'dodo', order_type: 'course', reason: 'refund', amount: refund.amount / 100, currency: 'USD', partial: refund.partial,
          });
          expect(purchases()).toBe(1);
        });
      }
    }

    it('reports no chargeback when a dispute refunded in full is then lost, and a partial refund keeps the chargeback', async () => {
      const { course } = await publishedCourse();
      const lan = await member('lan@example.com');
      const full = await paidByCard(lan);
      const fullOrder = await getCourseOrderByCode(state.d1, full);
      await dodo('evt_open_f', 'dispute.opened', { payment_id: `pay_${full}` });
      expect(await dodo('evt_refund_f', 'refund.succeeded', { payment_id: `pay_${full}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'reversed' });
      expect(await dodo('evt_lost_f', 'dispute.lost', { payment_id: `pay_${full}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'ignored' });
      expect(await dodo('evt_lost_f', 'dispute.lost', { payment_id: `pay_${full}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'duplicate_event' });
      expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
      expect(refundKeys()).toEqual([`refund:dodo:course_order:${fullOrder?.id}:refunded`]);

      // Partial refunds add up with a chargeback, as for a partial refund of a paid order.
      const partial = await paidByCard(await member('mai@example.com'));
      const partialOrder = await getCourseOrderByCode(state.d1, partial);
      await dodo('evt_open_p', 'dispute.opened', { payment_id: `pay_${partial}` });
      expect(await dodo('evt_refund_p', 'refund.succeeded', { payment_id: `pay_${partial}`, amount: 1000, currency: 'USD' })).toMatchObject({ outcome: 'reversed' });
      expect(await dodo('evt_lost_p', 'dispute.lost', { payment_id: `pay_${partial}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'ignored' });
      expect(await dodo('evt_lost_p', 'dispute.lost', { payment_id: `pay_${partial}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'duplicate_event' });
      expect(refundKeys()).toEqual([
        `refund:dodo:course_order:${fullOrder?.id}:refunded`,
        `refund:dodo:course_order:${partialOrder?.id}:refunded`, `refund:dodo:course_order:${partialOrder?.id}:charged_back`,
      ]);
    });

    it('reports no chargeback for any funds-lost outcome after a full refund during the dispute', async () => {
      const { course } = await publishedCourse();
      const lan = await member('lan@example.com');
      const code = await paidByCard(lan);
      const order = await getCourseOrderByCode(state.d1, code);
      await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` });
      expect(await dodo('evt_refund', 'refund.succeeded', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'reversed' });
      expect(await dodo('evt_accepted', 'dispute.accepted', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'ignored' });
      expect(await dodo('evt_lost', 'dispute.lost', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'ignored' });
      expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
      expect(refundKeys()).toEqual([`refund:dodo:course_order:${order?.id}:refunded`]);
    });

    it('reverses the referral commission once when the order is refunded during a dispute that is then won', async () => {
      await publishedCourse();
      const { user: ref } = await findOrCreateVerifiedUser(state.d1, { email: 'ref@example.com' });
      const { code: referralCode } = await ensureReferralProfile(state.d1, ref.id);
      await state.d1.prepare('UPDATE referral_profiles SET discount_percent = 10, admin_enabled = 1 WHERE user_id = ?').bind(ref.id).run();
      const code = await paidByCard(await member('lan@example.com'), { referral_code: referralCode });
      const order = await getCourseOrderByCode(state.d1, code);
      const commission = () => state.d1.prepare("SELECT status FROM referral_commissions WHERE source_kind = 'course_order' AND source_id = ?")
        .bind(order?.id ?? '').first<{ status: string }>();
      const reversals = () => state.d1.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM referral_events WHERE action = 'commission.reversed'").get()?.n;
      expect((await commission())?.status).toBe('pending');

      await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` });
      expect(await dodo('evt_refund', 'refund.succeeded', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'reversed' });
      expect(await dodo('evt_won', 'dispute.won', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'ignored' });
      expect((await commission())?.status).toBe('reversed');
      expect(reversals()).toBe(1);
    });

    describe('recorded by an admin', () => {
      const adminRefunds = () => state.d1.raw
        .query<{ detail: string }, []>("SELECT detail FROM user_activity WHERE action = 'courses.order_refunded'").all().map(r => JSON.parse(r.detail));

      it('refunds a disputed order once, keeps access revoked and reverses the commission once when the dispute is then won', async () => {
        const { course } = await publishedCourse();
        const { user: ref } = await findOrCreateVerifiedUser(state.d1, { email: 'ref@example.com' });
        const { code: referralCode } = await ensureReferralProfile(state.d1, ref.id);
        await state.d1.prepare('UPDATE referral_profiles SET discount_percent = 10, admin_enabled = 1 WHERE user_id = ?').bind(ref.id).run();
        const lan = await member('lan@example.com');
        const code = await paidByCard(lan, { referral_code: referralCode });
        const order = await getCourseOrderByCode(state.d1, code);
        const commission = () => state.d1.prepare("SELECT status FROM referral_commissions WHERE source_kind = 'course_order' AND source_id = ?")
          .bind(order?.id ?? '').first<{ status: string }>();
        const reversals = () => state.d1.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM referral_events WHERE action = 'commission.reversed'").get()?.n;

        expect(await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'reversed' });
        expect(reversals()).toBe(1);
        expect(await resolveCourseOrder(state.d1, env(), code, 'refund', 'refunded by bank transfer')).toMatchObject({ status: 'refunded', attention_reason: 'refunded by bank transfer' });
        expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
        expect(refundKeys()).toEqual([`refund:dodo:course_order:${order?.id}:refunded`]);
        expect(adminRefunds()).toEqual([{ code, reason: 'refunded by bank transfer', actor: 'admin' }]);
        await expect(resolveCourseOrder(state.d1, env(), code, 'refund', 'again')).rejects.toMatchObject({ status: 409, code: 'not_refundable' });

        expect(await dodo('evt_won', 'dispute.won', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'ignored' });
        expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
        expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('refunded');
        expect(refundKeys()).toEqual([`refund:dodo:course_order:${order?.id}:refunded`]);
        expect(purchases()).toBe(1);
        expect((await commission())?.status).toBe('reversed');
        expect(reversals()).toBe(1);
      });

      it('does not count a disputed order it refunded again when the dispute is then lost', async () => {
        const { course } = await publishedCourse();
        const lan = await member('lan@example.com');
        const code = await paidByCard(lan);
        const order = await getCourseOrderByCode(state.d1, code);
        await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` });
        expect((await resolveCourseOrder(state.d1, env(), code, 'refund', 'goodwill')).status).toBe('refunded');

        expect(await dodo('evt_lost', 'dispute.lost', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'ignored' });
        expect(await dodo('evt_lost', 'dispute.lost', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'duplicate_event' });
        expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('refunded');
        expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
        expect(refundKeys()).toEqual([`refund:dodo:course_order:${order?.id}:refunded`]);
      });

      it('still refuses a refund after a lost dispute and of orders that were never paid or already reversed', async () => {
        await publishedCourse();
        const lost = await paidByCard(await member('lan@example.com'));
        await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${lost}` });
        await dodo('evt_lost', 'dispute.lost', { payment_id: `pay_${lost}`, amount: 4900, currency: 'USD' });
        await expect(resolveCourseOrder(state.d1, env(), lost, 'refund', 'late')).rejects.toMatchObject({ status: 409, code: 'not_refundable', message: expect.stringMatching(/dispute .* was lost/) });
        expect((await getCourseOrderByCode(state.d1, lost))?.status).toBe('charged_back');

        const refunded = await paidByCard(await member('mai@example.com'));
        expect((await resolveCourseOrder(state.d1, env(), refunded, 'refund', 'goodwill')).status).toBe('refunded');
        await expect(resolveCourseOrder(state.d1, env(), refunded, 'refund', 'again')).rejects.toMatchObject({ status: 409, code: 'not_refundable' });

        const pending = String(field((await read(await checkout(await member('hoa@example.com'), { provider: 'dodo', accept_terms: true }))).data, 'code'));
        await expect(resolveCourseOrder(state.d1, env(), pending, 'refund', 'never paid')).rejects.toMatchObject({ status: 409, code: 'not_refundable' });
        expect((await getCourseOrderByCode(state.d1, pending))?.status).toBe('pending');
        expect(adminRefunds()).toHaveLength(1);
      });

      it('reports the money back of an admin refund with the amount and currency paid, for a paid and a disputed order', async () => {
        await publishedCourse();
        const paid = await paidByCard(await member('lan@example.com'));
        const disputed = await paidByCard(await member('mai@example.com'));
        await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${disputed}` });
        for (const code of [paid, disputed]) expect((await resolveCourseOrder(state.d1, env(), code, 'refund', 'goodwill')).status).toBe('refunded');

        const rows = refundRows();
        expect(rows.map(r => r.dedupe_key)).toEqual([
          `refund:dodo:course_order:${(await getCourseOrderByCode(state.d1, paid))?.id}:refunded`,
          `refund:dodo:course_order:${(await getCourseOrderByCode(state.d1, disputed))?.id}:refunded`,
        ]);
        for (const row of rows) {
          expect(JSON.parse(row.properties)).toMatchObject({ provider: 'dodo', order_type: 'course', reason: 'refund', amount: 49, currency: 'USD', partial: false });
        }
      });

      it('keeps a disputed order it refunded revoked when the dispute is then cancelled', async () => {
        const { course } = await publishedCourse();
        const { user: ref } = await findOrCreateVerifiedUser(state.d1, { email: 'ref@example.com' });
        const { code: referralCode } = await ensureReferralProfile(state.d1, ref.id);
        await state.d1.prepare('UPDATE referral_profiles SET discount_percent = 10, admin_enabled = 1 WHERE user_id = ?').bind(ref.id).run();
        const lan = await member('lan@example.com');
        const code = await paidByCard(lan, { referral_code: referralCode });
        const order = await getCourseOrderByCode(state.d1, code);
        const reversals = () => state.d1.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM referral_events WHERE action = 'commission.reversed'").get()?.n;
        await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` });
        expect((await resolveCourseOrder(state.d1, env(), code, 'refund', 'goodwill')).status).toBe('refunded');

        expect(await dodo('evt_cancel', 'dispute.cancelled', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'ignored' });
        expect(await dodo('evt_cancel', 'dispute.cancelled', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'duplicate_event' });
        expect(await getCourseOrderByCode(state.d1, code)).toMatchObject({ status: 'refunded', attention_reason: 'goodwill' });
        expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
        expect(refundKeys()).toEqual([`refund:dodo:course_order:${order?.id}:refunded`]);
        expect(purchases()).toBe(1);
        expect(reversals()).toBe(1);
      });
    });

    describe('a grant or dismiss of a disputed order', () => {
      /** The admin resolve through REST (`POST /admin/course-orders/:code/resolve`) or MCP (`course_order_resolve`). */
      const surfaces = {
        REST: async (d1: D1DatabaseLike, code: string, action: string): Promise<{ status: number; code?: string; message?: string }> => {
          const boss = await member('boss@example.com');
          const res = await resolveApi(ctx({ method: 'POST', body: { action, reason: 'admin note' }, headers: boss.browser, params: { code }, env: { ...env(), DB: d1 } }));
          const body: unknown = await res.json();
          return res.ok ? { status: res.status } : { status: res.status, code: String(field(body, 'error', 'code')), message: String(field(body, 'error', 'message')) };
        },
        MCP: async (d1: D1DatabaseLike, code: string, action: string): Promise<{ status: number; code?: string; message?: string }> => {
          const boss = await member('boss@example.com');
          const mcp: McpContext = {
            request: new Request('https://zuey.test/api/mcp', { headers: boss.browser }), env: env(), d1, async requireAdmin() {}, async isAdmin() { return true; },
          };
          return coursesMcpModule.call('course_order_resolve', { code, action, reason: 'admin note' }, mcp).then(
            () => ({ status: 200 }),
            (err: unknown) => ({ status: Number(field(err, 'status')), code: String(field(err, 'code')), message: err instanceof Error ? err.message : '' }),
          );
        },
      } as const;

      /** Everything a grant or dismiss could change: the order row, access, analytics, logs and the referral commission. */
      const snapshot = (code: string) => ({
        order: state.d1.raw.query<Record<string, unknown>, [string]>('SELECT * FROM course_orders WHERE code = ?').get(code),
        purchases: state.d1.raw.query<Record<string, unknown>, []>('SELECT * FROM course_purchases ORDER BY id').all(),
        outbox: state.d1.raw.query<{ dedupe_key: string }, []>('SELECT dedupe_key FROM analytics_outbox ORDER BY dedupe_key').all(),
        // The buyer's log: the admin's own sign-in is not part of the order.
        activity: state.d1.raw.query<{ action: string }, [string]>('SELECT action FROM user_activity WHERE user_id = (SELECT user_id FROM course_orders WHERE code = ?) ORDER BY id').all(code),
        commissions: state.d1.raw.query<Record<string, unknown>, []>('SELECT * FROM referral_commissions ORDER BY id').all(),
        referralEvents: state.d1.raw.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM referral_events').get()?.n,
        invites: state.d1.raw.query<Record<string, unknown>, []>('SELECT * FROM github_invites ORDER BY repo').all(),
      });

      async function referredDisputedOrder(): Promise<{ code: string; userId: string; courseId: string }> {
        const { course } = await publishedCourse({ github_repos: ['zuey/course-repo'] });
        const { user: ref } = await findOrCreateVerifiedUser(state.d1, { email: 'ref@example.com' });
        const { code: referralCode } = await ensureReferralProfile(state.d1, ref.id);
        await state.d1.prepare('UPDATE referral_profiles SET discount_percent = 10, admin_enabled = 1 WHERE user_id = ?').bind(ref.id).run();
        const lan = await member('lan@example.com');
        const code = await paidByCard(lan, { referral_code: referralCode });
        expect(await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'reversed' });
        return { code, userId: lan.userId, courseId: course.id };
      }

      for (const [surface, resolve] of Object.entries(surfaces)) {
        it(`through ${surface} refuses both with 409 while the dispute is open and changes nothing, so a won dispute still restores it`, async () => {
          const { code, userId, courseId } = await referredDisputedOrder();
          const before = snapshot(code);
          expect(await resolve(state.d1, code, 'grant')).toMatchObject({ status: 409, code: 'order_disputed', message: expect.stringMatching(/cannot be granted/) });
          expect(await resolve(state.d1, code, 'dismiss')).toMatchObject({ status: 409, code: 'order_disputed', message: expect.stringMatching(/cannot be dismissed/) });
          expect(snapshot(code)).toEqual(before);
          expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('charged_back');
          expect(await ownsCourse(state.d1, userId, courseId)).toBe(false);

          expect(await dodo('evt_won', 'dispute.won', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'restored' });
          expect(await getCourseOrderByCode(state.d1, code)).toMatchObject({ status: 'paid', attention_reason: 'dispute.won' });
          expect(await ownsCourse(state.d1, userId, courseId)).toBe(true);
        });

        it(`through ${surface} refuses grant, dismiss and refund after a lost dispute and changes nothing`, async () => {
          const { code } = await referredDisputedOrder();
          expect(await dodo('evt_lost', 'dispute.lost', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'ignored' });
          const before = snapshot(code);
          for (const action of ['grant', 'dismiss']) expect(await resolve(state.d1, code, action)).toMatchObject({ status: 409, code: 'order_disputed' });
          expect(await resolve(state.d1, code, 'refund')).toMatchObject({ status: 409, code: 'not_refundable' });
          expect(snapshot(code)).toEqual(before);
        });
      }

      /** A D1 that runs `meanwhile` once just before the first write matching `sql` (alone or in its batch). */
      function landingBefore(sql: RegExp, meanwhile: () => Promise<unknown>): D1DatabaseLike {
        let fired = false;
        const fire = async () => {
          if (fired) return;
          fired = true;
          await meanwhile();
        };
        const inner = new WeakMap<D1PreparedStatementLike, D1PreparedStatementLike>();
        const wrap = (stmt: D1PreparedStatementLike): D1PreparedStatementLike => {
          const statement: D1PreparedStatementLike = {
            bind: (...v: unknown[]) => wrap(stmt.bind(...v)),
            first: <T,>() => stmt.first<T>(),
            all: <T,>() => stmt.all<T>(),
            run: async () => {
              await fire();
              return stmt.run();
            },
          };
          inner.set(statement, stmt);
          return statement;
        };
        return {
          prepare: (s: string) => (sql.test(s) ? wrap(state.d1.prepare(s)) : state.d1.prepare(s)),
          batch: async statements => {
            if (statements.some(s => inner.has(s))) await fire();
            return state.d1.batch(statements.map(s => inner.get(s) ?? s));
          },
        };
      }

      async function flaggedCardOrder(): Promise<{ code: string; userId: string; courseId: string }> {
        const { course } = await publishedCourse();
        const lan = await member('lan@example.com');
        const res = await read(await checkout(lan, { provider: 'dodo', accept_terms: true }));
        const code = String(field(res.data, 'code'));
        expect(await dodo(`evt_pay_${code}`, 'payment.succeeded', {
          payment_id: `pay_${code}`, total_amount: 1000, currency: 'USD', metadata: { course_order: code, user_id: lan.userId },
        })).toMatchObject({ outcome: 'needs_attention' });
        return { code, userId: lan.userId, courseId: course.id };
      }

      for (const [action, write] of [['grant', /^UPDATE course_orders SET status = 'paid'/], ['dismiss', /^UPDATE course_orders SET status = 'cancelled'/]] as const) {
        it(`refuses a ${action} of a flagged order that a dispute charged back meanwhile`, async () => {
          const { code, userId, courseId } = await flaggedCardOrder();
          const d1 = landingBefore(write, () => dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` }));
          expect(await surfaces.REST(d1, code, action)).toMatchObject({ status: 409, code: 'order_disputed' });
          expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('charged_back');
          expect(await ownsCourse(state.d1, userId, courseId)).toBe(false);
          expect(await dodo('evt_won', 'dispute.won', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'restored' });
        });
      }

      it('still grants and dismisses the orders it can settle', async () => {
        const granted = await flaggedCardOrder();
        expect(await surfaces.MCP(state.d1, granted.code, 'grant')).toEqual({ status: 200 });
        expect((await getCourseOrderByCode(state.d1, granted.code))?.status).toBe('paid');
        expect(await ownsCourse(state.d1, granted.userId, granted.courseId)).toBe(true);
        expect(await surfaces.REST(state.d1, granted.code, 'dismiss')).toMatchObject({ status: 409, code: 'already_paid' });

        const pending = String(field((await read(await checkout(await member('mai@example.com'), { provider: 'dodo', accept_terms: true }))).data, 'code'));
        expect(await surfaces.REST(state.d1, pending, 'dismiss')).toEqual({ status: 200 });
        expect(await getCourseOrderByCode(state.d1, pending)).toMatchObject({ status: 'cancelled', attention_reason: 'dismissed:admin note' });
      });

      it('reports the refund 409 from the status the refund found, not the one read before it', async () => {
        const { code } = await referredDisputedOrder();
        const d1 = landingBefore(/^UPDATE course_orders SET status = 'refunded'/, () => dodo('evt_refund', 'refund.succeeded', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' }));
        await expect(resolveCourseOrder(d1, env(), code, 'refund', 'late')).rejects.toMatchObject({ status: 409, code: 'not_refundable', message: 'Order is already refunded' });
        expect(await getCourseOrderByCode(state.d1, code)).toMatchObject({ status: 'refunded', attention_reason: 'dodo_refund' });
        expect(refundKeys()).toHaveLength(1);
      });

      it('marks a charged-back order whose dispute was lost in the admin order list', async () => {
        const { code } = await referredDisputedOrder();
        const boss = await member('boss@example.com');
        const listed = async () => {
          const res = await read(await listOrdersApi(ctx({ headers: boss.browser, path: '/api/v1/admin/course-orders?status=charged_back' })));
          expect(res.status).toBe(200);
          return Array.isArray(res.data) ? res.data.map(o => [field(o, 'code'), field(o, 'dispute_lost')]) : null;
        };
        expect(await listed()).toEqual([[code, false]]);
        await dodo('evt_lost', 'dispute.lost', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' });
        expect(await listed()).toEqual([[code, true]]);
      });
    });

    /**
     * A D1 that runs `meanwhile` right after the handler checked whether `eventId` was already recorded, as a webhook
     * landing between the order read and the reversal batch.
     */
    function racing(eventId: string, meanwhile: () => Promise<unknown>): D1DatabaseLike {
      let fired = false;
      return {
        prepare(sql: string) {
          const stmt = state.d1.prepare(sql);
          if (!sql.startsWith('SELECT 1 AS found FROM payment_events')) return stmt;
          return {
            bind(...values: unknown[]) {
              const bound = stmt.bind(...values);
              if (fired || values[1] !== eventId) return bound;
              return {
                bind: (...v: unknown[]) => bound.bind(...v),
                async first<T>() {
                  const res = await bound.first<T>();
                  fired = true;
                  await meanwhile();
                  return res;
                },
                all<T>() { return bound.all<T>(); },
                run: () => bound.run(),
              };
            },
            first<T>() { return stmt.first<T>(); },
            all<T>() { return stmt.all<T>(); },
            run: () => stmt.run(),
          };
        },
        batch: statements => state.d1.batch(statements),
      };
    }
    const gateRows = (eventId: string) => state.d1.raw
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM payment_events WHERE provider = 'dodo' AND event_id = ?").get(eventId)?.n;

    it('applies a refund that races dispute.opened, so the won dispute restores nothing', async () => {
      const { course } = await publishedCourse();
      const lan = await member('lan@example.com');
      const code = await paidByCard(lan);
      const order = await getCourseOrderByCode(state.d1, code);
      const d1 = racing('evt_refund', () => dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` }));
      expect(await applyDodoCourseWebhook(d1, env(), 'evt_refund', { type: 'refund.succeeded', data: { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' } }))
        .toMatchObject({ outcome: 'reversed' });
      expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('refunded');
      expect(await dodo('evt_won', 'dispute.won', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'ignored' });
      expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
      expect(refundKeys()).toEqual([`refund:dodo:course_order:${order?.id}:refunded`]);
      // The first batch found the order charged back and wrote nothing; the retry wrote the record with the refund.
      expect(gateRows('evt_refund')).toBe(1);
      expect(await dodo('evt_refund', 'refund.succeeded', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'duplicate_event' });
    });

    it('applies a refund that races dispute.won, so access does not stay restored', async () => {
      const { course } = await publishedCourse();
      const lan = await member('lan@example.com');
      const code = await paidByCard(lan);
      const order = await getCourseOrderByCode(state.d1, code);
      await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` });
      const d1 = racing('evt_refund', () => dodo('evt_won', 'dispute.won', { payment_id: `pay_${code}` }));
      expect(await applyDodoCourseWebhook(d1, env(), 'evt_refund', { type: 'refund.succeeded', data: { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' } }))
        .toMatchObject({ outcome: 'reversed' });
      expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('refunded');
      expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
      expect(refundKeys()).toEqual([`refund:dodo:course_order:${order?.id}:refunded`]);
      expect(gateRows('evt_refund')).toBe(1);
    });

    /**
     * A D1 that runs `meanwhile` once inside the won handler's restore: right after the order's update to `paid` when
     * it runs alone, or just before the batch that carries it (D1 runs a batch as one unit, so that is the last point a
     * webhook can land before the restore).
     */
    function racingRestore(meanwhile: () => Promise<unknown>): D1DatabaseLike {
      let fired = false;
      const fire = async () => {
        if (fired) return;
        fired = true;
        await meanwhile();
      };
      const inner = new WeakMap<D1PreparedStatementLike, D1PreparedStatementLike>();
      const wrap = (stmt: D1PreparedStatementLike): D1PreparedStatementLike => {
        const statement: D1PreparedStatementLike = {
          bind: (...v: unknown[]) => wrap(stmt.bind(...v)),
          first: <T,>() => stmt.first<T>(),
          all: <T,>() => stmt.all<T>(),
          run: async () => {
            const res = await stmt.run();
            await fire();
            return res;
          },
        };
        inner.set(statement, stmt);
        return statement;
      };
      return {
        prepare: (sql: string) => /^UPDATE course_orders SET status = 'paid'/.test(sql) ? wrap(state.d1.prepare(sql)) : state.d1.prepare(sql),
        batch: async statements => {
          if (statements.some(s => inner.has(s))) await fire();
          return state.d1.batch(statements.map(s => inner.get(s) ?? s));
        },
      };
    }
    const inviteActions = () => state.d1.raw.query<{ action: string }, []>('SELECT action FROM github_invites ORDER BY repo').all().map(r => r.action);

    it('keeps access revoked when a refund lands while dispute.won restores the order', async () => {
      const { course } = await publishedCourse({ github_repos: ['zuey/course-repo'] });
      const lan = await member('lan@example.com');
      const code = await paidByCard(lan);
      const order = await getCourseOrderByCode(state.d1, code);
      await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` });
      const refund = { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' };
      const d1 = racingRestore(() => dodo('evt_refund', 'refund.succeeded', refund));
      expect(await applyDodoCourseWebhook(d1, env(), 'evt_won', { type: 'dispute.won', data: { payment_id: `pay_${code}` } })).toMatchObject({ outcome: 'ignored' });
      expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('refunded');
      expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
      expect(inviteActions()).toEqual(['remove']);
      expect(refundKeys()).toEqual([`refund:dodo:course_order:${order?.id}:refunded`]);
      expect(purchases()).toBe(1);
      expect(await dodo('evt_refund', 'refund.succeeded', refund)).toMatchObject({ outcome: 'duplicate_event' });
      expect(await dodo('evt_won', 'dispute.won', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'duplicate_event' });
    });

    it('restores access, the GitHub invite and the order logs once when a dispute is won', async () => {
      const { course } = await publishedCourse({ github_repos: ['zuey/course-repo'] });
      const lan = await member('lan@example.com');
      const code = await paidByCard(lan);
      const logs = (action: string) => state.d1.raw.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM user_activity WHERE action = ?').get(action)?.n;
      await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` });
      expect(inviteActions()).toEqual(['remove']);
      expect(await dodo('evt_won', 'dispute.won', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'restored' });
      expect(await dodo('evt_won', 'dispute.won', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'duplicate_event' });
      expect(await getCourseOrderByCode(state.d1, code)).toMatchObject({ status: 'paid', attention_reason: 'dispute.won' });
      expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(true);
      expect(inviteActions()).toEqual(['invite']);
      expect(logs('courses.granted')).toBe(2);
      expect(logs('courses.order_paid')).toBe(2);
      expect(purchases()).toBe(1);
      expect(refundKeys()).toEqual([]);
    });

    it('reports no refund after an opened dispute was lost', async () => {
      const { course } = await publishedCourse();
      const lan = await member('lan@example.com');
      const code = await paidByCard(lan);
      const order = await getCourseOrderByCode(state.d1, code);
      await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` });
      expect(await dodo('evt_lost', 'dispute.lost', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'ignored' });
      expect(await dodo('evt_refund', 'refund.succeeded', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'ignored' });
      expect(await dodo('evt_refund', 'refund.succeeded', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'duplicate_event' });
      expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('charged_back');
      expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
      expect(refundKeys()).toEqual([`refund:dodo:course_order:${order?.id}:charged_back`]);
    });
  });

  describe('a reversal that fails part-way', () => {
    /**
     * The test database, except that the write matching `fails` throws, whether it runs alone or in a batch (the
     * batch then rolls back, as on D1). The webhook handler releases its event, so the retry is a fresh delivery.
     */
    function failingD1(fails: (sql: string, values: unknown[]) => boolean): D1DatabaseLike {
      const base = state.d1;
      const sources = new WeakMap<D1PreparedStatementLike, { sql: string; values: unknown[]; inner: D1PreparedStatementLike }>();
      const wrap = (sql: string, inner: D1PreparedStatementLike, values: unknown[]): D1PreparedStatementLike => {
        const statement: D1PreparedStatementLike = {
          bind: (...v: unknown[]) => wrap(sql, inner.bind(...v), v),
          first: <T,>() => inner.first<T>(),
          all: <T,>() => inner.all<T>(),
          run: async () => {
            if (fails(sql, values)) throw new Error('injected failure');
            return inner.run();
          },
        };
        sources.set(statement, { sql, values, inner });
        return statement;
      };
      return {
        prepare: (sql: string) => wrap(sql, base.prepare(sql), []),
        batch: (statements: D1PreparedStatementLike[]) => base.batch(statements.map(s => {
          const source = sources.get(s);
          if (!source) throw new Error('foreign statement');
          return fails(source.sql, source.values) ? base.prepare('INSERT INTO injected_failure DEFAULT VALUES') : source.inner;
        })),
      };
    }

    const count = (sql: string, ...params: string[]) => state.d1.raw.query<{ n: number }, string[]>(sql).get(...params)?.n ?? 0;
    const activities = (action: string) => count('SELECT COUNT(*) AS n FROM user_activity WHERE action = ?', action);
    const removals = () => count("SELECT COUNT(*) AS n FROM github_invites WHERE action = 'remove'");
    const certRevoked = () => count('SELECT COUNT(*) AS n FROM course_certificates WHERE revoked_at IS NOT NULL');
    const gate = (eventId: string) => count("SELECT COUNT(*) AS n FROM payment_events WHERE provider = 'dodo' AND event_id = ?", eventId);

    const activity = (action: string) => (sql: string, values: unknown[]) => sql.startsWith('INSERT INTO user_activity') && values.includes(action);
    const sqlPoint = (re: RegExp) => (sql: string) => re.test(sql);
    const revokePoints = [
      ['the certificate revoke', sqlPoint(/^UPDATE course_certificates/)],
      ['the GitHub removal', sqlPoint(/^\s*INSERT INTO github_invites/)],
      ['the revoke log', activity('courses.revoked')],
      ['the access revoke', sqlPoint(/^UPDATE course_purchases/)],
    ] as const;

    async function paidWithCertificate(email: string): Promise<{ code: string; userId: string; courseId: string }> {
      const lan = await member(email);
      const code = await paidByCard(lan);
      const order = await getCourseOrderByCode(state.d1, code);
      if (!order) throw new Error('order missing');
      await state.d1.prepare('INSERT INTO course_certificates (id, code, user_id, course_id, holder_name, course_title, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(`cert_${code}`, `C-${code}`, lan.userId, order.course_id, 'Lan', 'Course', new Date(state.now).toISOString()).run();
      return { code, userId: lan.userId, courseId: order.course_id };
    }

    const scenarios = [
      {
        name: 'a refund of a paid order', type: 'refund.succeeded', kind: 'refunded', amount: 4900, opened: false,
        points: [...revokePoints, ['the order log', activity('courses.order_refunded')], ['the refund event', sqlPoint(/INSERT INTO analytics_outbox/)], ['the status update', sqlPoint(/^UPDATE course_orders/)]],
      },
      {
        name: 'a lost dispute of a paid order', type: 'dispute.lost', kind: 'charged_back', amount: 4900, opened: false,
        points: [...revokePoints, ['the order log', activity('courses.order_charged_back')], ['the chargeback event', sqlPoint(/INSERT INTO analytics_outbox/)], ['the status update', sqlPoint(/^UPDATE course_orders/)]],
      },
      {
        name: 'a refund during an open dispute', type: 'refund.succeeded', kind: 'refunded', amount: 4900, opened: true,
        points: [['the order log', activity('courses.order_refunded')], ['the refund event', sqlPoint(/INSERT INTO analytics_outbox/)], ['the status update', sqlPoint(/^UPDATE course_orders/)]],
      },
      {
        name: 'a lost dispute after an opened one', type: 'dispute.lost', kind: 'charged_back', amount: 4900, opened: true,
        points: [['the chargeback event', sqlPoint(/INSERT INTO analytics_outbox/)]],
      },
    ] as const;

    for (const s of scenarios) {
      for (const [point, fails] of s.points) {
        it(`writes nothing when ${s.name} fails at ${point}, and the retry writes it all once`, async () => {
          await publishedCourse({ github_repos: ['zuey/course-repo'] });
          const { code, userId, courseId } = await paidWithCertificate('lan@example.com');
          const order = await getCourseOrderByCode(state.d1, code);
          if (s.opened) expect(await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'reversed' });
          const before = {
            status: (await getCourseOrderByCode(state.d1, code))?.status, owns: await ownsCourse(state.d1, userId, courseId),
            revoked: activities('courses.revoked'), removals: removals(), certRevoked: certRevoked(),
          };
          const payload = { type: s.type, data: { payment_id: `pay_${code}`, amount: s.amount, currency: 'USD' } };

          await expect(applyDodoCourseWebhook(failingD1(fails), env(), 'evt_x', payload)).rejects.toThrow(/injected/);
          expect((await getCourseOrderByCode(state.d1, code))?.status).toBe(before.status);
          expect(await ownsCourse(state.d1, userId, courseId)).toBe(before.owns);
          expect(activities('courses.revoked')).toBe(before.revoked);
          expect(activities(`courses.order_${s.kind}`)).toBe(s.opened && s.kind === 'charged_back' ? 1 : 0);
          expect(removals()).toBe(before.removals);
          expect(certRevoked()).toBe(before.certRevoked);
          expect(refundKeys()).toEqual([]);
          expect(gate('evt_x')).toBe(0);

          expect(await dodo('evt_x', s.type, payload.data)).toMatchObject({ outcome: s.opened && s.kind === 'charged_back' ? 'ignored' : 'reversed' });
          expect(await dodo('evt_x', s.type, payload.data)).toMatchObject({ outcome: 'duplicate_event' });
          expect((await getCourseOrderByCode(state.d1, code))?.status).toBe(s.kind);
          expect(await ownsCourse(state.d1, userId, courseId)).toBe(false);
          expect(activities('courses.revoked')).toBe(1);
          expect(activities(`courses.order_${s.kind}`)).toBe(1);
          expect(removals()).toBe(1);
          expect(certRevoked()).toBe(1);
          expect(refundKeys()).toEqual([`refund:dodo:course_order:${order?.id}:${s.kind}`]);
        });
      }
    }

    const restorePoints = [
      ['the record', sqlPoint(/^INSERT INTO payment_events/)],
      ['the GitHub invite', sqlPoint(/^\s*INSERT INTO github_invites/)],
      ['the grant log', activity('courses.granted')],
      ['the access grant', sqlPoint(/^\s*INSERT INTO course_purchases/)],
      ['the order log', activity('courses.order_paid')],
      ['the status update', sqlPoint(/^UPDATE course_orders SET status = 'paid'/)],
    ] as const;
    for (const [point, fails] of restorePoints) {
      it(`writes nothing when a won dispute fails at ${point}, and the retry restores it once`, async () => {
        await publishedCourse({ github_repos: ['zuey/course-repo'] });
        const { code, userId, courseId } = await paidWithCertificate('lan@example.com');
        expect(await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'reversed' });
        const invites = () => count("SELECT COUNT(*) AS n FROM github_invites WHERE action = 'invite'");
        const before = { granted: activities('courses.granted'), paid: activities('courses.order_paid') };
        const payload = { type: 'dispute.won', data: { payment_id: `pay_${code}` } };

        await expect(applyDodoCourseWebhook(failingD1(fails), env(), 'evt_w', payload)).rejects.toThrow(/injected/);
        expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('charged_back');
        expect(await ownsCourse(state.d1, userId, courseId)).toBe(false);
        expect(invites()).toBe(0);
        expect(activities('courses.granted')).toBe(before.granted);
        expect(activities('courses.order_paid')).toBe(before.paid);
        expect(gate('evt_w')).toBe(0);

        expect(await dodo('evt_w', 'dispute.won', payload.data)).toMatchObject({ outcome: 'restored' });
        expect(await dodo('evt_w', 'dispute.won', payload.data)).toMatchObject({ outcome: 'duplicate_event' });
        expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('paid');
        expect(await ownsCourse(state.d1, userId, courseId)).toBe(true);
        expect(invites()).toBe(1);
        expect(activities('courses.granted')).toBe(before.granted + 1);
        expect(activities('courses.order_paid')).toBe(before.paid + 1);
        expect(refundKeys()).toEqual([]);
      });
    }

    it('writes nothing when an admin refund fails at the refund event, and the admin can retry it', async () => {
      await publishedCourse();
      const { code, userId, courseId } = await paidWithCertificate('lan@example.com');
      const order = await getCourseOrderByCode(state.d1, code);
      await expect(resolveCourseOrder(failingD1(sqlPoint(/INSERT INTO analytics_outbox/)), env(), code, 'refund', 'goodwill')).rejects.toThrow(/injected/);
      expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('paid');
      expect(await ownsCourse(state.d1, userId, courseId)).toBe(true);
      expect(activities('courses.order_refunded')).toBe(0);

      expect((await resolveCourseOrder(state.d1, env(), code, 'refund', 'goodwill')).status).toBe('refunded');
      expect(await ownsCourse(state.d1, userId, courseId)).toBe(false);
      expect(activities('courses.order_refunded')).toBe(1);
      expect(refundKeys()).toEqual([`refund:${order?.provider}:course_order:${order?.id}:refunded`]);
    });

    describe('an admin revoke', () => {
      /** The admin revoke through REST (`DELETE /admin/courses/:course/owners`) or MCP (`course_access_set`). */
      const surfaces = {
        REST: async (d1: D1DatabaseLike, admin: Member, userId: string): Promise<unknown> => {
          const res = await read(await revokeOwnerApi(ctx({
            method: 'DELETE', body: { user_id: userId, reason: 'abuse' }, headers: admin.browser, params: { course: 'ai-product' }, env: { ...env(), DB: d1 },
          })));
          if (res.status !== 200) throw new Error(`${res.status} ${res.code}`);
          return res.data;
        },
        MCP: (d1: D1DatabaseLike, admin: Member, userId: string): Promise<unknown> => {
          const mcp: McpContext = {
            request: new Request('https://zuey.test/api/mcp', { headers: admin.browser }), env: env(), d1,
            async requireAdmin() {}, async isAdmin() { return true; },
          };
          return coursesMcpModule.call('course_access_set', { course: 'ai-product', action: 'revoke', user_id: userId, reason: 'abuse' }, mcp);
        },
      } as const;

      for (const [surface, revoke] of Object.entries(surfaces)) {
        for (const [point, fails] of revokePoints) {
          it(`through ${surface} writes nothing when it fails at ${point}, and the retry revokes once`, async () => {
            await publishedCourse({ github_repos: ['zuey/course-repo'] });
            const { userId, courseId } = await paidWithCertificate('lan@example.com');
            const boss = await member('boss@example.com');

            const failed = await revoke(failingD1(fails), boss, userId).then(() => 'ok', (err: unknown) => (err instanceof Error ? err.message : 'failed'));
            expect(failed).toMatch(surface === 'REST' ? /^500 internal_error$/ : /injected/);
            expect(await ownsCourse(state.d1, userId, courseId)).toBe(true);
            expect(activities('courses.revoked')).toBe(0);
            expect(removals()).toBe(0);
            expect(certRevoked()).toBe(0);

            expect(await revoke(state.d1, boss, userId)).toEqual({ revoked: true });
            expect(await revoke(state.d1, boss, userId)).toEqual({ revoked: false });
            expect(await ownsCourse(state.d1, userId, courseId)).toBe(false);
            expect(activities('courses.revoked')).toBe(1);
            expect(removals()).toBe(1);
            expect(certRevoked()).toBe(1);
          });
        }
      }

      it('is followed by a refund that only refunds the order, and a dispute that only charges it back', async () => {
        await publishedCourse({ github_repos: ['zuey/course-repo'] });
        const boss = await member('boss@example.com');
        const refunded = await paidWithCertificate('lan@example.com');
        const disputed = await paidWithCertificate('mai@example.com');
        for (const p of [refunded, disputed]) expect(await surfaces.REST(state.d1, boss, p.userId)).toEqual({ revoked: true });

        expect(await dodo('evt_refund', 'refund.succeeded', { payment_id: `pay_${refunded.code}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'reversed' });
        expect(await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${disputed.code}` })).toMatchObject({ outcome: 'reversed' });
        expect((await getCourseOrderByCode(state.d1, refunded.code))?.status).toBe('refunded');
        expect((await getCourseOrderByCode(state.d1, disputed.code))?.status).toBe('charged_back');
        for (const p of [refunded, disputed]) expect(await ownsCourse(state.d1, p.userId, p.courseId)).toBe(false);
        expect(activities('courses.revoked')).toBe(2);
        expect(activities('courses.order_refunded')).toBe(1);
        expect(activities('courses.order_charged_back')).toBe(1);
        expect(removals()).toBe(2);
        expect(certRevoked()).toBe(2);
        const refundedOrder = await getCourseOrderByCode(state.d1, refunded.code);
        expect(refundKeys()).toEqual([`refund:dodo:course_order:${refundedOrder?.id}:refunded`]);
      });
    });

    const invites = () => count("SELECT COUNT(*) AS n FROM github_invites WHERE action = 'invite'");
    const purchaseKeys = () => state.d1.raw
      .query<{ dedupe_key: string }, []>("SELECT dedupe_key FROM analytics_outbox WHERE event = 'purchase' ORDER BY created_at").all().map(r => r.dedupe_key);
    const grantPoints = [
      ['the GitHub invite', sqlPoint(/^\s*INSERT INTO github_invites/)],
      ['the grant log', activity('courses.granted')],
      ['the access grant', sqlPoint(/^\s*INSERT INTO course_purchases/)],
    ] as const;

    describe('an admin grant', () => {
      /** The admin grant through REST (`POST /admin/courses/:course/owners`) or MCP (`course_access_set`). */
      const surfaces = {
        REST: async (d1: D1DatabaseLike, admin: Member, email: string): Promise<unknown> => {
          const res = await read(await grantOwnerApi(ctx({
            method: 'POST', body: { email }, headers: admin.browser, params: { course: 'ai-product' }, env: { ...env(), DB: d1 },
          })));
          if (res.status !== 200) throw new Error(`${res.status} ${res.code}`);
          return res.data;
        },
        MCP: (d1: D1DatabaseLike, admin: Member, email: string): Promise<unknown> => {
          const mcp: McpContext = {
            request: new Request('https://zuey.test/api/mcp', { headers: admin.browser }), env: env(), d1,
            async requireAdmin() {}, async isAdmin() { return true; },
          };
          return coursesMcpModule.call('course_access_set', { course: 'ai-product', action: 'grant', email }, mcp);
        },
      } as const;

      for (const [surface, grant] of Object.entries(surfaces)) {
        for (const [point, fails] of grantPoints) {
          it(`through ${surface} writes nothing when it fails at ${point}, and the retry grants once`, async () => {
            const { course } = await publishedCourse({ github_repos: ['zuey/course-repo'] });
            const lan = await member('lan@example.com');
            const boss = await member('boss@example.com');

            const failed = await grant(failingD1(fails), boss, 'lan@example.com').then(() => 'ok', (err: unknown) => (err instanceof Error ? err.message : 'failed'));
            expect(failed).toMatch(surface === 'REST' ? /^500 internal_error$/ : /injected/);
            expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
            expect(activities('courses.granted')).toBe(0);
            expect(invites()).toBe(0);

            expect(await grant(state.d1, boss, 'lan@example.com')).toEqual({ user_id: lan.userId, granted: true });
            expect(await grant(state.d1, boss, 'lan@example.com')).toEqual({ user_id: lan.userId, granted: false });
            expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(true);
            expect(activities('courses.granted')).toBe(1);
            expect(invites()).toBe(1);
          });
        }
      }
    });

    describe('a payment whose grant fails part-way', () => {
      const payPoints = [...grantPoints, ['the status update', sqlPoint(/^UPDATE course_orders SET status = 'paid'/)]] as const;
      const events = (eventId: string) => count('SELECT COUNT(*) AS n FROM payment_events WHERE event_id = ?', eventId);

      /** Checks that a failed payment left the order unpaid with nothing granted, then that the retry pays it once. */
      async function expectRetriedOnce(code: string, userId: string, courseId: string, eventId: string, retry: () => Promise<unknown>): Promise<void> {
        const order = await getCourseOrderByCode(state.d1, code);
        expect(order?.status).toBe('pending');
        expect(await ownsCourse(state.d1, userId, courseId)).toBe(false);
        expect(activities('courses.granted')).toBe(0);
        expect(activities('courses.order_paid')).toBe(0);
        expect(invites()).toBe(0);
        expect(purchaseKeys()).toEqual([]);
        expect(events(eventId)).toBe(0);
        expect(state.emails.length).toBe(0);

        expect(await retry()).toMatchObject({ outcome: 'paid' });
        expect(await retry()).toMatchObject({ outcome: 'duplicate_event' });
        expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('paid');
        expect(await ownsCourse(state.d1, userId, courseId)).toBe(true);
        expect(activities('courses.granted')).toBe(1);
        expect(activities('courses.order_paid')).toBe(1);
        expect(invites()).toBe(1);
        expect(purchaseKeys()).toEqual([`purchase:${order?.provider}:course_order:${order?.id}`]);
        expect(state.emails.length).toBe(1);
      }

      for (const [point, fails] of payPoints) {
        it(`leaves a Dodo order unpaid when it fails at ${point}, and the redelivery pays it once`, async () => {
          const { course } = await publishedCourse({ github_repos: ['zuey/course-repo'] });
          const lan = await member('lan@example.com');
          const res = await read(await checkout(lan, { provider: 'dodo', accept_terms: true }));
          const code = String(field(res.data, 'code'));
          const payload = {
            type: 'payment.succeeded',
            data: { payment_id: `pay_${code}`, total_amount: 4900, currency: 'USD', metadata: { course_order: code, user_id: lan.userId } },
          };

          await expect(applyDodoCourseWebhook(failingD1(fails), env(), 'evt_pay', payload)).rejects.toThrow(/injected/);
          await expectRetriedOnce(code, lan.userId, course.id, 'evt_pay', () => dodo('evt_pay', payload.type, payload.data));
        });

        it(`leaves a SePay order unpaid when it fails at ${point}, and the redelivery pays it once`, async () => {
          const { course } = await publishedCourse({ github_repos: ['zuey/course-repo'] });
          const lan = await member('lan@example.com');
          const { code, amount } = await sepayOrder(lan);
          const notice = { eventId: 'sepay_1', amount, orderCode: code, paymentRef: 'FT1', rawType: 'in' };

          await expect(applyCourseSepayPayment(failingD1(fails), env(), notice)).rejects.toThrow(/injected/);
          await expectRetriedOnce(code, lan.userId, course.id, 'sepay_1', () => applyCourseSepayPayment(state.d1, env(), notice));
        });

        it(`leaves a flagged order unpaid when the admin grant fails at ${point}, and the retry pays it once`, async () => {
          const { course } = await publishedCourse({ github_repos: ['zuey/course-repo'] });
          const lan = await member('lan@example.com');
          const { code, amount } = await sepayOrder(lan);
          expect(await payTransfer(code, amount - 1000)).toMatchObject({ outcome: 'needs_attention' });

          await expect(resolveCourseOrder(failingD1(fails), env(), code, 'grant', 'rounding')).rejects.toThrow(/injected/);
          expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('needs_attention');
          expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
          expect(activities('courses.granted')).toBe(0);
          expect(activities('courses.order_paid')).toBe(0);
          expect(invites()).toBe(0);
          expect(purchaseKeys()).toEqual([]);

          expect((await resolveCourseOrder(state.d1, env(), code, 'grant', 'rounding')).status).toBe('paid');
          await expect(resolveCourseOrder(state.d1, env(), code, 'grant', 'rounding')).rejects.toThrow(/already paid/);
          expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(true);
          expect(activities('courses.granted')).toBe(1);
          expect(activities('courses.order_paid')).toBe(1);
          expect(invites()).toBe(1);
          expect(purchaseKeys()).toHaveLength(1);
        });
      }
    });

    describe('a payment for a course deleted since checkout', () => {
      const deleteCourse = (courseId: string) => state.d1.prepare('UPDATE courses SET deleted_at = ? WHERE id = ?').bind(new Date(state.now).toISOString(), courseId).run();

      it('records a Dodo payment on the flagged order without granting, so the redelivery stops and a refund finds it', async () => {
        const { course } = await publishedCourse({ github_repos: ['zuey/course-repo'] });
        const lan = await member('lan@example.com');
        const code = String(field((await read(await checkout(lan, { provider: 'dodo', accept_terms: true }))).data, 'code'));
        await deleteCourse(course.id);
        const data = { payment_id: `pay_${code}`, total_amount: 4900, currency: 'USD', metadata: { course_order: code, user_id: lan.userId } };

        expect(await dodo('evt_pay', 'payment.succeeded', data)).toMatchObject({ outcome: 'needs_attention' });
        expect(await dodo('evt_pay', 'payment.succeeded', data)).toMatchObject({ outcome: 'duplicate_event' });
        expect(await getCourseOrderByCode(state.d1, code)).toMatchObject({
          status: 'needs_attention', attention_reason: 'course_missing', provider_payment_id: `pay_${code}`, amount_paid: 4900, currency_paid: 'USD',
        });
        expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
        expect(activities('courses.granted')).toBe(0);
        expect(invites()).toBe(0);
        expect(purchaseKeys()).toEqual([]);

        expect(await dodo('evt_refund', 'refund.succeeded', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'reversed' });
        expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('refunded');
      });

      it('records a SePay transfer on the flagged order without granting, so the redelivery stops', async () => {
        const { course } = await publishedCourse({ github_repos: ['zuey/course-repo'] });
        const lan = await member('lan@example.com');
        const { code, amount } = await sepayOrder(lan);
        await deleteCourse(course.id);
        const notice = { eventId: 'sepay_1', amount, orderCode: code, paymentRef: 'FT1', rawType: 'in' };

        expect(await applyCourseSepayPayment(state.d1, env(), notice)).toMatchObject({ outcome: 'needs_attention' });
        expect(await applyCourseSepayPayment(state.d1, env(), notice)).toMatchObject({ outcome: 'duplicate_event' });
        expect(await getCourseOrderByCode(state.d1, code)).toMatchObject({
          status: 'needs_attention', attention_reason: 'course_missing', amount_paid: amount, currency_paid: 'VND',
        });
        expect(await ownsCourse(state.d1, lan.userId, course.id)).toBe(false);
        expect(activities('courses.granted')).toBe(0);
        expect(invites()).toBe(0);
        expect(purchaseKeys()).toEqual([]);
      });
    });

    /** The test database, except that the worker dies at the first statement matching `at` (see `crashingD1`). */
    const crashingD1 = (at?: (sql: string) => boolean) => crashingTestD1(state.d1, at);

    const isGate = (sql: string) => sql.startsWith('INSERT INTO payment_events');
    const crashes = [
      { name: 'a refund of a paid order', type: 'refund.succeeded', kind: 'refunded', opened: false, outcome: 'reversed', at: sqlPoint(/^UPDATE course_orders SET status/) },
      { name: 'a lost dispute of a paid order', type: 'dispute.lost', kind: 'charged_back', opened: false, outcome: 'reversed', at: sqlPoint(/^UPDATE course_orders SET status/) },
      { name: 'an opened dispute of a paid order', type: 'dispute.opened', kind: 'charged_back', opened: false, outcome: 'reversed', at: sqlPoint(/^UPDATE course_orders SET status/) },
      { name: 'a refund during an open dispute', type: 'refund.succeeded', kind: 'refunded', opened: true, outcome: 'reversed', at: sqlPoint(/^UPDATE course_orders SET status/) },
      { name: 'a lost dispute after an opened one', type: 'dispute.lost', kind: 'charged_back', opened: true, outcome: 'ignored', at: sqlPoint(/INSERT INTO analytics_outbox/) },
    ] as const;

    for (const s of crashes) {
      it(`keeps no record of ${s.name} when the worker dies before the reversal commits, so the redelivery applies it once`, async () => {
        await publishedCourse({ github_repos: ['zuey/course-repo'] });
        const { code, userId, courseId } = await paidWithCertificate('lan@example.com');
        const order = await getCourseOrderByCode(state.d1, code);
        if (s.opened) expect(await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'reversed' });
        const statusBefore = (await getCourseOrderByCode(state.d1, code))?.status;
        const payload = { type: s.type, data: { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' } };

        await expect(applyDodoCourseWebhook(crashingD1(s.at).d1, env(), 'evt_x', payload)).rejects.toThrow(/crashed/);
        expect(gate('evt_x')).toBe(0);
        expect((await getCourseOrderByCode(state.d1, code))?.status).toBe(statusBefore);

        expect(await dodo('evt_x', s.type, payload.data)).toMatchObject({ outcome: s.outcome });
        expect(await dodo('evt_x', s.type, payload.data)).toMatchObject({ outcome: 'duplicate_event' });
        expect(gate('evt_x')).toBe(1);
        expect((await getCourseOrderByCode(state.d1, code))?.status).toBe(s.kind);
        expect(await ownsCourse(state.d1, userId, courseId)).toBe(false);
        expect(activities('courses.revoked')).toBe(1);
        expect(activities(`courses.order_${s.kind}`)).toBe(1);
        expect(removals()).toBe(1);
        const money = s.type === 'dispute.opened' ? [] : [`refund:dodo:course_order:${order?.id}:${s.kind}`];
        expect(refundKeys()).toEqual(money);
      });

      it(`writes the record of ${s.name} only as the first statement of its reversal batch`, async () => {
        await publishedCourse({ github_repos: ['zuey/course-repo'] });
        const { code } = await paidWithCertificate('lan@example.com');
        if (s.opened) expect(await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'reversed' });
        const spy = crashingD1();
        const payload = { type: s.type, data: { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' } };
        expect(await applyDodoCourseWebhook(spy.d1, env(), 'evt_x', payload)).toMatchObject({ outcome: s.outcome });
        expect(spy.runs.filter(isGate)).toEqual([]);
        // Every batch is an attempt that carries the record under its own guard; only the one that applies writes it.
        expect(spy.batches.length).toBeGreaterThan(0);
        for (const batch of spy.batches) {
          expect(isGate(batch[0])).toBe(true);
          expect(batch.some(s.at)).toBe(true);
        }
        expect(gate('evt_x')).toBe(1);

        // A redelivery is found before anything runs and writes nothing.
        const again = crashingD1();
        expect(await applyDodoCourseWebhook(again.d1, env(), 'evt_x', payload)).toMatchObject({ outcome: 'duplicate_event' });
        expect(again.batches).toEqual([]);
        expect(again.runs).toEqual([]);
      });
    }

    for (const type of ['dispute.won', 'dispute.cancelled']) {
      it(`keeps no record of a ${type} when the worker dies before the restore commits, so the redelivery restores it once`, async () => {
        await publishedCourse({ github_repos: ['zuey/course-repo'] });
        const { code, userId, courseId } = await paidWithCertificate('lan@example.com');
        expect(await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'reversed' });
        const invites = () => count("SELECT COUNT(*) AS n FROM github_invites WHERE action = 'invite'");
        const before = { granted: activities('courses.granted'), paid: activities('courses.order_paid') };
        const payload = { type, data: { payment_id: `pay_${code}` } };

        await expect(applyDodoCourseWebhook(crashingD1(sqlPoint(/^UPDATE course_orders SET status = 'paid'/)).d1, env(), 'evt_x', payload)).rejects.toThrow(/crashed/);
        expect(gate('evt_x')).toBe(0);
        expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('charged_back');
        expect(await ownsCourse(state.d1, userId, courseId)).toBe(false);

        expect(await dodo('evt_x', type, payload.data)).toMatchObject({ outcome: 'restored' });
        expect(await dodo('evt_x', type, payload.data)).toMatchObject({ outcome: 'duplicate_event' });
        expect(gate('evt_x')).toBe(1);
        expect(await getCourseOrderByCode(state.d1, code)).toMatchObject({ status: 'paid', attention_reason: type });
        expect(await ownsCourse(state.d1, userId, courseId)).toBe(true);
        expect(invites()).toBe(1);
        expect(activities('courses.granted')).toBe(before.granted + 1);
        expect(activities('courses.order_paid')).toBe(before.paid + 1);
        expect(refundKeys()).toEqual([]);
      });

      it(`writes the record of a ${type} only as the first statement of its restore batch`, async () => {
        await publishedCourse();
        const { code } = await paidWithCertificate('lan@example.com');
        expect(await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'reversed' });
        const spy = crashingD1();
        const payload = { type, data: { payment_id: `pay_${code}` } };
        expect(await applyDodoCourseWebhook(spy.d1, env(), 'evt_x', payload)).toMatchObject({ outcome: 'restored' });
        expect(spy.runs.filter(isGate)).toEqual([]);
        expect(spy.batches.length).toBe(1);
        expect(isGate(spy.batches[0][0])).toBe(true);
        expect(spy.batches[0].some(sqlPoint(/^UPDATE course_orders SET status = 'paid'/))).toBe(true);
        expect(gate('evt_x')).toBe(1);

        const again = crashingD1();
        expect(await applyDodoCourseWebhook(again.d1, env(), 'evt_x', payload)).toMatchObject({ outcome: 'duplicate_event' });
        expect(again.batches).toEqual([]);
        expect(again.runs).toEqual([]);
      });

      it(`records a ${type} for an order refunded meanwhile once, without restoring it, even after a crash`, async () => {
        await publishedCourse();
        const { code, userId, courseId } = await paidWithCertificate('lan@example.com');
        expect(await dodo('evt_open', 'dispute.opened', { payment_id: `pay_${code}` })).toMatchObject({ outcome: 'reversed' });
        expect(await dodo('evt_refund', 'refund.succeeded', { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' })).toMatchObject({ outcome: 'reversed' });
        const payload = { type, data: { payment_id: `pay_${code}` } };

        // The worker dies when the record is written alone, after the restore batch found nothing to restore.
        let batches = 0;
        const crashing = crashingD1(sql => isGate(sql) && batches > 0);
        const counted: D1DatabaseLike = {
          prepare: sql => crashing.d1.prepare(sql),
          batch: async statements => { const res = await crashing.d1.batch(statements); batches++; return res; },
        };
        await expect(applyDodoCourseWebhook(counted, env(), 'evt_x', payload)).rejects.toThrow(/crashed/);
        expect(crashing.batches.length).toBe(1);
        expect(gate('evt_x')).toBe(0);

        expect(await dodo('evt_x', type, payload.data)).toMatchObject({ outcome: 'ignored' });
        expect(await dodo('evt_x', type, payload.data)).toMatchObject({ outcome: 'duplicate_event' });
        expect(gate('evt_x')).toBe(1);
        expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('refunded');
        expect(await ownsCourse(state.d1, userId, courseId)).toBe(false);
        expect(activities('courses.order_paid')).toBe(1);
      });
    }

    it('rolls the whole reversal back when its record is already taken, and answers duplicate_event', async () => {
      await publishedCourse();
      const { code, userId, courseId } = await paidWithCertificate('lan@example.com');
      const order = await getCourseOrderByCode(state.d1, code);
      await state.d1.prepare("INSERT INTO payment_events (provider, event_id, course_order_id, raw_type, received_at) VALUES ('dodo', 'evt_x', ?, 'refund.succeeded', ?)")
        .bind(order?.id ?? '', new Date(state.now).toISOString()).run();
      // The first record check misses it, as for a delivery that checked just before another one committed.
      let checks = 0;
      const blind: D1DatabaseLike = {
        prepare: (sql: string) => state.d1.prepare(sql.startsWith('SELECT 1 AS found FROM payment_events') && checks++ === 0 ? 'SELECT 1 AS found WHERE 0 AND ? AND ?' : sql),
        batch: statements => state.d1.batch(statements),
      };
      const payload = { type: 'refund.succeeded', data: { payment_id: `pay_${code}`, amount: 4900, currency: 'USD' } };
      expect(await applyDodoCourseWebhook(blind, env(), 'evt_x', payload)).toMatchObject({ outcome: 'duplicate_event' });
      expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('paid');
      expect(await ownsCourse(state.d1, userId, courseId)).toBe(true);
      expect(activities('courses.order_refunded')).toBe(0);
      expect(refundKeys()).toEqual([]);
      expect(gate('evt_x')).toBe(1);
    });

    describe('a payment the worker dies on', () => {
      const events = (eventId: string) => count('SELECT COUNT(*) AS n FROM payment_events WHERE event_id = ?', eventId);
      const attentionKeys = () => state.d1.raw
        .query<{ dedupe_key: string }, []>("SELECT dedupe_key FROM analytics_outbox WHERE event = 'payment_needs_attention'").all().map(r => r.dedupe_key);

      /** A pending order on `provider` and its payment event (short by `shortBy`), delivered through any database. */
      async function pendingPayment(provider: 'dodo' | 'sepay', shortBy = 0) {
        const { course } = await publishedCourse({ github_repos: ['zuey/course-repo'] });
        const lan = await member('lan@example.com');
        if (provider === 'sepay') {
          const { code, amount } = await sepayOrder(lan);
          const notice = { eventId: 'sepay_1', amount: amount - shortBy, orderCode: code, paymentRef: 'FT1', rawType: 'in' };
          return { course, lan, code, eventId: notice.eventId, amount: notice.amount, deliver: (d1: D1DatabaseLike) => applyCourseSepayPayment(d1, env(), notice) };
        }
        const code = String(field((await read(await checkout(lan, { provider: 'dodo', accept_terms: true }))).data, 'code'));
        const data = { payment_id: `pay_${code}`, total_amount: 4900 - shortBy, currency: 'USD', metadata: { course_order: code, user_id: lan.userId } };
        return {
          course, lan, code, eventId: 'evt_pay', amount: data.total_amount,
          deliver: (d1: D1DatabaseLike) => applyDodoCourseWebhook(d1, env(), 'evt_pay', { type: 'payment.succeeded', data }),
        };
      }

      const crashPoints = [
        ['the course read before the payment batch', sqlPoint(/^SELECT \* FROM courses WHERE id/)],
        ['the GitHub invite', sqlPoint(/^\s*INSERT INTO github_invites/)],
        ['the access grant', sqlPoint(/^\s*INSERT INTO course_purchases/)],
        ['the purchase event', sqlPoint(/INSERT INTO analytics_outbox/)],
        ['the status update', sqlPoint(/^UPDATE course_orders SET status = 'paid'/)],
      ] as const;

      for (const provider of ['dodo', 'sepay'] as const) {
        for (const [point, at] of crashPoints) {
          it(`pays a ${provider} order once on the redelivery after the worker dies at ${point}`, async () => {
            const p = await pendingPayment(provider);
            await expect(p.deliver(crashingD1(at).d1)).rejects.toThrow(/crashed/);
            expect(events(p.eventId)).toBe(0);
            expect((await getCourseOrderByCode(state.d1, p.code))?.status).toBe('pending');
            expect(await ownsCourse(state.d1, p.lan.userId, p.course.id)).toBe(false);
            expect(purchaseKeys()).toEqual([]);

            expect(await p.deliver(state.d1)).toMatchObject({ outcome: 'paid' });
            expect(await p.deliver(state.d1)).toMatchObject({ outcome: 'duplicate_event' });
            const order = await getCourseOrderByCode(state.d1, p.code);
            expect(order).toMatchObject({ status: 'paid', attention_reason: null });
            expect(await ownsCourse(state.d1, p.lan.userId, p.course.id)).toBe(true);
            expect(events(p.eventId)).toBe(1);
            expect(activities('courses.granted')).toBe(1);
            expect(activities('courses.order_paid')).toBe(1);
            expect(invites()).toBe(1);
            expect(purchaseKeys()).toEqual([`purchase:${provider}:course_order:${order?.id}`]);
            expect(state.emails.length).toBe(1);
          });
        }

        it(`sends the receipt of a ${provider} order on the redelivery after the worker dies past the payment batch`, async () => {
          const p = await pendingPayment(provider);
          await expect(p.deliver(crashingD1(sqlPoint(/^\s*INSERT INTO email_log/)).d1)).rejects.toThrow(/crashed/);
          expect((await getCourseOrderByCode(state.d1, p.code))?.status).toBe('paid');
          expect(state.emails.length).toBe(0);

          expect(await p.deliver(state.d1)).toMatchObject({ outcome: 'duplicate_event' });
          expect(state.emails.length).toBe(1);
          expect(await p.deliver(state.d1)).toMatchObject({ outcome: 'duplicate_event' });
          expect(state.emails.length).toBe(1);
          expect(events(p.eventId)).toBe(1);
          expect(activities('courses.granted')).toBe(1);
          expect(activities('courses.order_paid')).toBe(1);
          expect(invites()).toBe(1);
          expect(purchaseKeys()).toHaveLength(1);
        });

        it(`writes the record of a ${provider} payment only as the first statement of its payment batch`, async () => {
          const p = await pendingPayment(provider);
          const spy = crashingD1();
          expect(await p.deliver(spy.d1)).toMatchObject({ outcome: 'paid' });
          expect(spy.runs.filter(isGate)).toEqual([]);
          expect(spy.batches.length).toBe(1);
          expect(isGate(spy.batches[0][0])).toBe(true);
          expect(spy.batches[0].at(-1)).toMatch(/^UPDATE course_orders SET status = 'paid'/);
          expect(events(p.eventId)).toBe(1);

          // A redelivery is found before anything runs and, with the receipt sent, writes nothing.
          const again = crashingD1();
          expect(await p.deliver(again.d1)).toMatchObject({ outcome: 'duplicate_event' });
          expect(again.batches).toEqual([]);
          expect(again.runs).toEqual([]);
        });

        it(`rolls a ${provider} payment back when its record is already taken, and answers duplicate_event`, async () => {
          const p = await pendingPayment(provider);
          await state.d1.prepare("INSERT INTO payment_events (provider, event_id, raw_type, received_at) VALUES (?, ?, 'race', ?)")
            .bind(provider, p.eventId, new Date(state.now).toISOString()).run();
          // The first record check misses it, as for a delivery that checked just before another one committed.
          let checks = 0;
          const blind: D1DatabaseLike = {
            prepare: (sql: string) => state.d1.prepare(sql.startsWith('SELECT 1 AS found FROM payment_events') && checks++ === 0 ? 'SELECT 1 AS found WHERE 0 AND ? AND ?' : sql),
            batch: statements => state.d1.batch(statements),
          };
          expect(await p.deliver(blind)).toMatchObject({ outcome: 'duplicate_event' });
          expect((await getCourseOrderByCode(state.d1, p.code))?.status).toBe('pending');
          expect(await ownsCourse(state.d1, p.lan.userId, p.course.id)).toBe(false);
          expect(activities('courses.granted')).toBe(0);
          expect(purchaseKeys()).toEqual([]);
          expect(events(p.eventId)).toBe(1);
        });

        for (const reason of ['underpaid', 'course_missing'] as const) {
          it(`flags a ${provider} payment as ${reason} once on the redelivery after the worker dies at the flag`, async () => {
            const p = await pendingPayment(provider, reason === 'underpaid' ? 1000 : 0);
            if (reason === 'course_missing') {
              await state.d1.prepare('UPDATE courses SET deleted_at = ? WHERE id = ?').bind(new Date(state.now).toISOString(), p.course.id).run();
            }
            await expect(p.deliver(crashingD1(sqlPoint(/^UPDATE course_orders SET status = 'needs_attention'/)).d1)).rejects.toThrow(/crashed/);
            expect(events(p.eventId)).toBe(0);
            expect((await getCourseOrderByCode(state.d1, p.code))?.status).toBe('pending');

            expect(await p.deliver(state.d1)).toMatchObject({ outcome: 'needs_attention' });
            expect(await p.deliver(state.d1)).toMatchObject({ outcome: 'duplicate_event' });
            expect(await getCourseOrderByCode(state.d1, p.code)).toMatchObject({ status: 'needs_attention', attention_reason: reason, amount_paid: p.amount });
            expect(events(p.eventId)).toBe(1);
            expect(activities('courses.order_attention')).toBe(1);
            expect(attentionKeys()).toEqual([`payment_needs_attention:${provider}:${p.eventId}`]);
            expect(await ownsCourse(state.d1, p.lan.userId, p.course.id)).toBe(false);
            expect(purchaseKeys()).toEqual([]);
            expect(state.emails.length).toBe(0);
          });
        }

        for (const winner of ['payment', 'flag'] as const) {
          it(`logs and counts the needs-attention flag of an underpaid ${provider} payment ${winner === 'payment' ? 'never when a racing payment pays the order first' : 'once when it commits before a racing payment'}`, async () => {
            const p = await pendingPayment(provider, 1000);
            const flagged = await p.deliver(racingFlag(winner === 'payment' ? 'before' : 'after', p.code));
            expect(flagged).toMatchObject({ outcome: 'needs_attention' });
            expect((await getCourseOrderByCode(state.d1, p.code))?.status).toBe('paid');
            // The record is written either way, so the redelivery changes nothing.
            expect(events(p.eventId)).toBe(1);
            expect(await p.deliver(state.d1)).toMatchObject({ outcome: 'duplicate_event' });
            const flags = winner === 'payment' ? 0 : 1;
            expect(activities('courses.order_attention')).toBe(flags);
            expect(attentionKeys()).toEqual(flags ? [`payment_needs_attention:${provider}:${p.eventId}`] : []);
          });
        }
      }

      /**
       * The test database, except that another delivery pays the order `code` right before (or right after) the batch
       * that flags it commits, as a payment racing the flag would.
       */
      function racingFlag(when: 'before' | 'after', code: string): D1DatabaseLike {
        const isFlag = sqlPoint(/^UPDATE course_orders SET status = 'needs_attention'/);
        let raced = false;
        const pay = () => {
          if (raced) return;
          raced = true;
          state.d1.raw.query("UPDATE course_orders SET status = 'paid', paid_at = ?, updated_at = ? WHERE code = ?")
            .run(new Date(state.now).toISOString(), new Date(state.now).toISOString(), code);
        };
        // The spy checks every statement of a batch before the batch runs, which is where the racing payment lands first.
        const spy = crashingD1(sql => {
          if (when === 'before' && isFlag(sql)) pay();
          return false;
        });
        return {
          prepare: sql => spy.d1.prepare(sql),
          batch: async statements => {
            const res = await spy.d1.batch(statements);
            if (when === 'after' && spy.batches.at(-1)?.some(isFlag)) pay();
            return res;
          },
        };
      }
    });

    describe('an admin order grant whose follow-ups fail after the payment batch', () => {
      /** The admin order grant through REST (`POST /admin/course-orders/:code/resolve`) or MCP (`course_order_resolve`). */
      const surfaces = {
        REST: async (d1: D1DatabaseLike, admin: Member, code: string): Promise<unknown> => {
          const res = await read(await resolveApi(ctx({
            method: 'POST', body: { action: 'grant', reason: 'rounding' }, headers: admin.browser, params: { code }, env: { ...env(), DB: d1 },
          })));
          if (res.status !== 200) throw new Error(`${res.status} ${res.code}`);
          return res.data;
        },
        MCP: (d1: D1DatabaseLike, admin: Member, code: string): Promise<unknown> => {
          const mcp: McpContext = {
            request: new Request('https://zuey.test/api/mcp', { headers: admin.browser }), env: env(), d1,
            async requireAdmin() {}, async isAdmin() { return true; },
          };
          return coursesMcpModule.call('course_order_resolve', { code, action: 'grant', reason: 'rounding' }, mcp);
        },
      } as const;

      /** Where the worker dies once the payment batch committed: before any follow-up, or at the first email. */
      const followUpPoints = [
        ['right after the payment batch', () => true],
        ['the first follow-up email', sqlPoint(/^\s*INSERT INTO email_log/)],
      ] as const;

      /** The test database, dying at the first statement matching `at` once the batch that pays the order committed. */
      function crashingAfterPayment(at: (sql: string) => boolean): D1DatabaseLike {
        let committed = false;
        const crashing = crashingD1(sql => committed && at(sql));
        return {
          prepare: sql => crashing.d1.prepare(sql),
          batch: async statements => {
            const res = await crashing.d1.batch(statements);
            if (crashing.batches.at(-1)?.some(sqlPoint(/^UPDATE course_orders SET status = 'paid'/))) committed = true;
            return res;
          },
        };
      }

      /** A SePay order with an invoice request, by referral or promo, underpaid so it waits for the admin. */
      async function flaggedOrder(by: 'referral' | 'promo') {
        const { course } = await publishedCourse();
        const lan = await member('lan@example.com');
        const extra: Record<string, unknown> = { invoice: { tax_id: '0312345678', email: 'ketoan@acme.vn' } };
        if (by === 'referral') {
          const ref = await findOrCreateVerifiedUser(state.d1, { email: 'ref@example.com' });
          const { code: referralCode } = await ensureReferralProfile(state.d1, ref.user.id);
          await state.d1.prepare('UPDATE referral_profiles SET discount_percent = 10, admin_enabled = 1 WHERE user_id = ?').bind(ref.user.id).run();
          extra.referral_code = referralCode;
        } else {
          await createPromo(state.d1, { code: 'HOC30', percent: 30, products: ['course'] }, 'test');
          extra.discount_code = 'HOC30';
        }
        const res = await read(await checkout(lan, { provider: 'sepay', accept_terms: true, ...extra }));
        expect(res.status).toBe(201);
        const code = String(field(res.data, 'code'));
        expect(await payTransfer(code, Number(field(res.data, 'amount_vnd')) - 1000)).toMatchObject({ outcome: 'needs_attention' });
        const order = await getCourseOrderByCode(state.d1, code);
        if (!order) throw new Error('order missing');
        return { course, lan, code, id: order.id };
      }

      const commissions = (id: string) => count("SELECT COUNT(*) AS n FROM referral_commissions WHERE source_kind = 'course_order' AND source_id = ?", id);
      const redeemed = (id: string) => count("SELECT COUNT(*) AS n FROM promo_redemptions WHERE source_kind = 'course_order' AND source_id = ? AND status = 'redeemed'", id);
      const invoices = (id: string) => count("SELECT COUNT(*) AS n FROM invoice_requests WHERE source_kind = 'course_order' AND source_id = ? AND status = 'requested'", id);
      const receipts = (id: string) => count("SELECT COUNT(*) AS n FROM email_log WHERE idempotency_key = ? AND status = 'sent'", `course-receipt:${id}`);

      for (const [surface, grant] of Object.entries(surfaces)) {
        for (const by of ['referral', 'promo'] as const) {
          for (const [point, at] of followUpPoints) {
            it(`through ${surface} resumes the follow-ups of a ${by} order once when the worker died at ${point}, then answers 409`, async () => {
              const p = await flaggedOrder(by);
              const boss = await member('boss@example.com');

              const failed = await grant(crashingAfterPayment(at), boss, p.code).then(() => 'ok', () => 'failed');
              expect(failed).toBe('failed');
              expect(await getCourseOrderByCode(state.d1, p.code)).toMatchObject({ status: 'paid', attention_reason: 'admin_grant:rounding' });
              expect(await ownsCourse(state.d1, p.lan.userId, p.course.id)).toBe(true);
              expect(receipts(p.id)).toBe(0);

              expect(await grant(state.d1, boss, p.code)).toMatchObject({ code: p.code, status: 'paid' });
              const done = { commissions: by === 'referral' ? 1 : 0, redeemed: by === 'promo' ? 1 : 0, invoices: 1, receipts: 1 };
              const counts = () => ({ commissions: commissions(p.id), redeemed: redeemed(p.id), invoices: invoices(p.id), receipts: receipts(p.id) });
              expect(counts()).toEqual(done);

              const again = await grant(state.d1, boss, p.code).then(() => 'ok', (err: unknown) => (err instanceof Error ? err.message : 'failed'));
              expect(again).toMatch(surface === 'REST' ? /^409 already_paid$/ : /already paid/);
              expect(counts()).toEqual(done);
              expect(await getCourseOrderByCode(state.d1, p.code)).toMatchObject({ status: 'paid', attention_reason: 'admin_grant:rounding' });
              expect(activities('courses.granted')).toBe(1);
              expect(activities('courses.order_paid')).toBe(1);
              expect(purchaseKeys()).toHaveLength(1);
            });
          }
        }
      }
    });
  });
  it('keeps the string amount of a signed Dodo dispute on the payment event and the chargeback report', async () => {
    await publishedCourse();
    const lan = await member('lan@example.com');
    const code = await paidByCard(lan);
    // Dodo's dispute webhook object: no customer, and the amount as a string of minor units.
    const body = JSON.stringify({
      business_id: 'bus_test', type: 'dispute.lost', timestamp: new Date(state.now).toISOString(),
      data: {
        payload_type: 'Dispute', dispute_id: 'dsp_course', payment_id: `pay_${code}`, business_id: 'bus_test', amount: '2500', currency: 'USD',
        created_at: new Date(state.now).toISOString(), dispute_stage: 'chargeback', dispute_status: 'dispute_lost',
      },
    });
    const ts = String(Math.floor(state.now / 1000));
    const signature = await signDodoPayload('whsec_dGVzdA==', 'evt_dsp_course', ts, body);
    const res = await read(await dodoWebhook(ctx({
      method: 'POST', rawBody: body, headers: { 'webhook-id': 'evt_dsp_course', 'webhook-timestamp': ts, 'webhook-signature': signature },
    })));
    expect(field(res.data, 'outcome')).toBe('reversed');

    expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('charged_back');
    const logged = state.d1.raw
      .query<{ amount: number | null; currency: string | null }, [string]>("SELECT amount, currency FROM payment_events WHERE provider = 'dodo' AND event_id = ?")
      .get('evt_dsp_course');
    expect(logged).toEqual({ amount: 2500, currency: 'USD' });
    const refunds = state.d1.raw.query<{ properties: string }, []>("SELECT properties FROM analytics_outbox WHERE event = 'refund'").all();
    expect(refunds).toHaveLength(1);
    expect(JSON.parse(refunds[0].properties)).toMatchObject({ order_type: 'course', reason: 'chargeback', amount: 25, currency: 'USD', partial: true });
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
    // The flagged order keeps its payment id, so a Dodo refund still closes it (an admin grant can no longer follow).
    expect(await dodo('evt_low_refund', 'refund.succeeded', { payment_id: 'pay_low' })).toMatchObject({ outcome: 'reversed' });
    expect((await getCourseOrderByCode(state.d1, code))?.status).toBe('refunded');
  });

  it('announces a course paid by card through the webhook route, but not its redelivery', async () => {
    await publishedCourse();
    const lan = await member('lan@example.com');
    const card = await read(await checkout(lan, { provider: 'dodo', accept_terms: true }));
    const code = String(field(card.data, 'code'));
    const notifyEnv: RuntimeEnv = { ...env(), TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_GROUP_ID_SEPAY_NOTI: '-1009' };
    const texts: string[] = [];
    const originalFetch = experienceRuntime.fetch;
    experienceRuntime.fetch = async (input, init) => {
      if (!String(input).startsWith('https://api.telegram.org/')) return originalFetch(input, init);
      const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      texts.push(String(field(body, 'text')));
      return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const body = JSON.stringify({ type: 'payment.succeeded', data: { payment_id: 'pay_route', total_amount: 4900, currency: 'USD', metadata: { course_order: code, user_id: lan.userId } } });
      const deliver = async () => {
        const ts = String(Math.floor(state.now / 1000));
        const signature = await signDodoPayload('whsec_dGVzdA==', 'evt_route', ts, body);
        return field(await read(await dodoWebhook(ctx({
          env: notifyEnv, method: 'POST', rawBody: body, headers: { 'webhook-id': 'evt_route', 'webhook-timestamp': ts, 'webhook-signature': signature },
        }))), 'data', 'outcome');
      };
      expect(await deliver()).toBe('paid');
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain(code);
      expect(texts[0]).toContain('Khoá học');
      expect(texts[0]).toContain('49.00 USD');
      expect(texts[0]).toContain('pay_route');
      expect(await deliver()).toBe('duplicate_event');
      expect(texts).toHaveLength(1);
    } finally {
      experienceRuntime.fetch = originalFetch;
    }
  });

  it('flags a card payment whose checkout belongs to another account instead of dropping it', async () => {
    await publishedCourse();
    const lan = await member('lan@example.com');
    const card = await read(await checkout(lan, { provider: 'dodo', accept_terms: true }));
    const code = String(field(card.data, 'code'));
    const res = await dodo('evt_other', 'payment.succeeded', { payment_id: 'pay_other', total_amount: 4900, currency: 'USD', metadata: { course_order: code, user_id: 'usr_someone_else' } });
    expect(res).toMatchObject({ outcome: 'needs_attention' });
    expect((await getCourseOrderByCode(state.d1, code))?.attention_reason).toBe('user_mismatch');
  });
});
