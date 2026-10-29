import { beforeEach, describe, expect, it } from 'bun:test';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../src/db/store';
import { getCourseOrderByCode } from '../src/lib/courses/course-orders';
import { resolveCourseOrder } from '../src/lib/courses/course-order-payments';
import { applyDodoCourseWebhook } from '../src/lib/courses/course-payment-webhooks';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { ensureReferralProfile } from '../src/lib/referrals/codes';
import { appendLedger } from '../src/lib/referrals/ledger';
import { POST as checkoutApi } from '../src/pages/api/v1/courses/[course]/checkout';
import { ctx, env, field, member, publishedCourse, read, resetCourseState, state } from './helpers/courses';
import { crashingD1 } from './helpers/d1';

/**
 * A course order and its referral commission change together: whatever point the worker dies at while a refund or a
 * lost dispute is applied, the order is still reversible with its commission active, or reversed with its commission
 * reversed, and the redelivery leaves both reversed once.
 */

interface ReferredOrder { code: string; orderId: string; amount: number; referrerId: string; userId: string }

async function referredCardOrder(): Promise<ReferredOrder> {
  await publishedCourse();
  const { user: ref } = await findOrCreateVerifiedUser(state.d1, { email: 'ref@example.com' });
  const { code: referralCode } = await ensureReferralProfile(state.d1, ref.id);
  await state.d1.prepare('UPDATE referral_profiles SET discount_percent = 10, admin_enabled = 1 WHERE user_id = ?').bind(ref.id).run();
  const lan = await member('lan@example.com');
  const res = await read(await checkoutApi(ctx({
    method: 'POST', body: { provider: 'dodo', accept_terms: true, referral_code: referralCode }, headers: lan.browser, params: { course: 'ai-product' },
  })));
  expect(res.status).toBe(201);
  const code = String(field(res.data, 'code'));
  const order = await getCourseOrderByCode(state.d1, code);
  if (!order?.referrer_user_id) throw new Error('referred order missing');
  return { code, orderId: order.id, amount: order.amount_usd_cents, referrerId: ref.id, userId: lan.userId };
}

function dodo(d1: D1DatabaseLike, eventId: string, type: string, data: Record<string, unknown>) {
  return applyDodoCourseWebhook(d1, env(), eventId, { type, data });
}

async function payByCard(o: ReferredOrder, amount = o.amount): Promise<unknown> {
  return dodo(state.d1, `evt_pay_${o.code}`, 'payment.succeeded', {
    payment_id: `pay_${o.code}`, total_amount: amount, currency: 'USD', metadata: { course_order: o.code, user_id: o.userId },
  });
}

const one = <T>(sql: string, ...params: string[]) => state.d1.raw.query<T, string[]>(sql).get(...params);

function commission(orderId: string) {
  return one<{ id: string; status: string; commission_cents: number }>(
    "SELECT id, status, commission_cents FROM referral_commissions WHERE source_kind = 'course_order' AND source_id = ?", orderId);
}

/** The hold passed: the commission is approved and credited to the referrer's balance. */
async function approve(o: ReferredOrder): Promise<number> {
  const c = commission(o.orderId);
  if (!c || c.commission_cents <= 0) throw new Error('commission missing');
  await state.d1.prepare("UPDATE referral_commissions SET status = 'approved', approved_at = ? WHERE id = ?").bind(new Date(state.now).toISOString(), c.id).run();
  await appendLedger(state.d1, { referrerUserId: o.referrerId, kind: 'commission', amountCents: c.commission_cents, commissionId: c.id });
  return c.commission_cents;
}

function snapshot(o: ReferredOrder) {
  const count = (sql: string, ...params: string[]) => one<{ n: number }>(sql, ...params)?.n ?? 0;
  return {
    order: one<{ status: string }>('SELECT status FROM course_orders WHERE id = ?', o.orderId)?.status,
    commission: commission(o.orderId)?.status ?? null,
    ledgerReversals: count("SELECT COUNT(*) AS n FROM referral_ledger WHERE kind = 'reversal' AND referrer_user_id = ?", o.referrerId),
    balance: one<{ total: number }>('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM referral_ledger WHERE referrer_user_id = ?', o.referrerId)?.total ?? 0,
    reversedLogs: count("SELECT COUNT(*) AS n FROM referral_events WHERE action = 'commission.reversed'"),
    markers: count("SELECT COUNT(*) AS n FROM referral_source_reversals WHERE source_kind = 'course_order' AND source_id = ?", o.orderId),
  };
}

/** A reversible order keeps an active commission; a reversed one has its commission reversed. */
function expectAgreement(o: ReferredOrder): void {
  const s = snapshot(o);
  const reversible = s.order === 'paid' || s.order === 'needs_attention';
  expect({ order: s.order, commissionReversed: s.commission === 'reversed' }).toEqual({ order: s.order, commissionReversed: !reversible });
}

/**
 * The test database seen by a worker that dies at the first statement matching `at`, or at the first statement after
 * a batch committed (`afterCommit`). `meanwhile` runs once right after the handler checked whether its event was
 * recorded, as another request landing between the order read and the reversal batch.
 */
function worker(opts: { at?: (sql: string) => boolean; afterCommit?: boolean; meanwhile?: () => Promise<unknown> }): D1DatabaseLike {
  let committed = false;
  let fired = false;
  const spy = crashingD1(state.d1, sql => (opts.at?.(sql) ?? false) || (opts.afterCommit === true && committed));
  return {
    prepare(sql: string) {
      const stmt = spy.d1.prepare(sql);
      const meanwhile = opts.meanwhile;
      if (!meanwhile || !sql.startsWith('SELECT 1 AS found FROM payment_events')) return stmt;
      return {
        ...stmt,
        bind(...values: unknown[]): D1PreparedStatementLike {
          const bound = stmt.bind(...values);
          return {
            ...bound,
            async first<T>() {
              const res = await bound.first<T>();
              if (!fired) {
                fired = true;
                await meanwhile();
              }
              return res;
            },
          };
        },
      };
    },
    async batch(statements: D1PreparedStatementLike[]) {
      const res = await spy.d1.batch(statements);
      committed = true;
      return res;
    },
  };
}

const beforeBatch = (sql: string) => sql.startsWith('SELECT * FROM courses');
const insideBatch = (sql: string) => /^UPDATE course_orders SET status/.test(sql);

const reversals = [
  { name: 'a refund', type: 'refund.succeeded', kind: 'refunded' },
  { name: 'a lost dispute', type: 'dispute.lost', kind: 'charged_back' },
] as const;

const points = [
  { name: 'before the reversal batch', opts: { at: beforeBatch } },
  { name: 'inside the reversal batch', opts: { at: insideBatch } },
  { name: 'after the reversal batch commits', opts: { afterCommit: true } },
] as const;

beforeEach(() => resetCourseState());

describe('course commission reversal', () => {
  for (const r of reversals) {
    for (const p of points) {
      it(`keeps ${r.name} and its credited commission together when the worker dies ${p.name}`, async () => {
        const o = await referredCardOrder();
        expect(await payByCard(o)).toMatchObject({ outcome: 'paid' });
        const credit = await approve(o);
        const data = { payment_id: `pay_${o.code}`, amount: o.amount, currency: 'USD' };

        await dodo(worker(p.opts), 'evt_x', r.type, data).catch(() => null);
        expectAgreement(o);

        const first = await dodo(state.d1, 'evt_x', r.type, data);
        expect(['reversed', 'duplicate_event']).toContain(String(field(first, 'outcome')));
        expect(await dodo(state.d1, 'evt_x', r.type, data)).toMatchObject({ outcome: 'duplicate_event' });
        expectAgreement(o);
        expect(snapshot(o)).toMatchObject({ order: r.kind, commission: 'reversed', ledgerReversals: 1, balance: 0, reversedLogs: 1, markers: 0 });
        const log = one<{ detail: string }>("SELECT detail FROM referral_events WHERE action = 'commission.reversed'");
        expect(JSON.parse(log?.detail ?? '{}')).toEqual({ commission_id: commission(o.orderId)?.id, reason: r.kind, previous_status: 'approved', ledger_reversed: true });
        const line = one<{ amount_cents: number }>("SELECT amount_cents FROM referral_ledger WHERE kind = 'reversal'");
        expect(line?.amount_cents).toBe(-credit);
      });
    }

    it(`reverses the commission of ${r.name} in the batch when the order read as not reversible was paid meanwhile, even if the worker dies after the commit`, async () => {
      const o = await referredCardOrder();
      // Underpaid by card: flagged with its payment id, then dismissed, so the webhook reads it cancelled.
      expect(await payByCard(o, o.amount - 100)).toMatchObject({ outcome: 'needs_attention' });
      await resolveCourseOrder(state.d1, env(), o.code, 'dismiss', 'x');
      expect(commission(o.orderId)).toBeNull();
      const data = { payment_id: `pay_${o.code}`, amount: o.amount - 100, currency: 'USD' };
      // The admin grants the order between the webhook's read and its batch: the order is paid and earns its commission.
      const grant = () => resolveCourseOrder(state.d1, env(), o.code, 'grant', 'paid by card');

      await dodo(worker({ afterCommit: true, meanwhile: grant }), 'evt_x', r.type, data).catch(() => null);
      expect(snapshot(o).order).toBe(r.kind);
      expectAgreement(o);

      expect(await dodo(state.d1, 'evt_x', r.type, data)).toMatchObject({ outcome: 'duplicate_event' });
      expectAgreement(o);
      expect(snapshot(o)).toMatchObject({ order: r.kind, commission: 'reversed', reversedLogs: 1, markers: 0 });
    });
  }

  it('leaves no reversal marker on a referred order without commission when an admin refund dies before its batch, so a grant still earns one', async () => {
    const o = await referredCardOrder();
    expect(await payByCard(o, o.amount - 100)).toMatchObject({ outcome: 'needs_attention' });
    expect(commission(o.orderId)).toBeNull();

    await expect(resolveCourseOrder(worker({ at: beforeBatch }), env(), o.code, 'refund', 'x')).rejects.toThrow(/crashed/);
    expect(snapshot(o)).toMatchObject({ order: 'needs_attention', markers: 0 });

    // The admin grants it after all: the order is paid and the referrer earns its commission.
    await resolveCourseOrder(state.d1, env(), o.code, 'grant', 'paid by card');
    expect(snapshot(o).order).toBe('paid');
    expect(commission(o.orderId)?.status).toMatch(/^(pending|review)$/);
    expectAgreement(o);

    await resolveCourseOrder(state.d1, env(), o.code, 'refund', 'x');
    expect(snapshot(o)).toMatchObject({ order: 'refunded', commission: 'reversed', reversedLogs: 1, markers: 0 });
  });

  it('marks a referred order without commission in its reversal batch, so a later capture never creates one', async () => {
    const o = await referredCardOrder();
    expect(await payByCard(o, o.amount - 100)).toMatchObject({ outcome: 'needs_attention' });

    await expect(resolveCourseOrder(worker({ at: insideBatch }), env(), o.code, 'refund', 'x')).rejects.toThrow(/crashed/);
    expect(snapshot(o)).toMatchObject({ order: 'needs_attention', markers: 0 });

    await resolveCourseOrder(state.d1, env(), o.code, 'refund', 'x');
    expect(snapshot(o)).toMatchObject({ order: 'refunded', commission: null, markers: 1 });
    expect(one<{ detail: string }>("SELECT detail FROM referral_events WHERE action = 'source.reversed_before_commission'")?.detail)
      .toBe(JSON.stringify({ source_kind: 'course_order', source_id: o.orderId, reason: 'refunded' }));
    // A second reversal of the same order is refused and logs nothing more.
    await expect(resolveCourseOrder(state.d1, env(), o.code, 'refund', 'x')).rejects.toThrow();
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM referral_events WHERE action = 'source.reversed_before_commission'")?.n).toBe(1);
  });
});
