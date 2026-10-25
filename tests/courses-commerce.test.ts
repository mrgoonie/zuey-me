import { beforeEach, describe, expect, it } from 'bun:test';
import { ownsCourse } from '../src/lib/courses/course-access';
import { getCourseOrderByCode } from '../src/lib/courses/course-orders';
import { resolveCourseOrder } from '../src/lib/courses/course-order-payments';
import { applyDodoCourseWebhook } from '../src/lib/courses/course-payment-webhooks';
import { DEFAULT_PLAN_DISCOUNTS, quoteCoursePrice } from '../src/lib/courses/course-pricing';
import type { CourseRecord } from '../src/lib/courses/course-types';
import { GET as catalogApi } from '../src/pages/api/v1/courses/index';
import { POST as checkoutApi } from '../src/pages/api/v1/courses/[course]/checkout';
import { POST as resolveApi } from '../src/pages/api/v1/admin/course-orders/[code]/resolve';
import { POST as sepayWebhook } from '../src/pages/api/webhooks/sepay';
import { POST as dodoWebhook } from '../src/pages/api/webhooks/dodo';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { ensureReferralProfile } from '../src/lib/referrals/codes';
import { experienceRuntime } from '../src/lib/experience/runtime';
import { signDodoPayload } from '../src/lib/payments/dodo';
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

    /** A D1 that runs `meanwhile` right after `eventId` is recorded, as a webhook landing between the order read and the update. */
    function racing(eventId: string, meanwhile: () => Promise<unknown>): D1DatabaseLike {
      let fired = false;
      return {
        prepare(sql: string) {
          const stmt = state.d1.prepare(sql);
          if (!sql.startsWith('INSERT INTO payment_events')) return stmt;
          return {
            bind(...values: unknown[]) {
              const bound = stmt.bind(...values);
              if (fired || values[1] !== eventId) return bound;
              return {
                bind: (...v: unknown[]) => bound.bind(...v),
                first<T>() { return bound.first<T>(); },
                all<T>() { return bound.all<T>(); },
                async run() {
                  const res = await bound.run();
                  fired = true;
                  await meanwhile();
                  return res;
                },
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
