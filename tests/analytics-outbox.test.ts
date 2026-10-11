import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createApiKey } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import type { DestinationResult, ServerAnalyticsEvent, ServerDestination } from '../src/lib/analytics/destinations/types';
import {
  MAX_DRAIN_LIMIT, MAX_DRAIN_QUERIES, OUTBOX_MAX_ATTEMPTS, OUTBOX_MAX_DELAY_MS, OUTBOX_SENT_RETENTION_MS, backoffMs, drainAnalyticsOutbox,
  enqueueServerEvent, sweepExpiredSubscriptions,
} from '../src/lib/analytics/outbox';
import { bookingRuntime } from '../src/lib/booking/store';
import { addMonths, recomputeSubscription } from '../src/lib/members/subscriptions';
import { membersRuntime } from '../src/lib/members/runtime';
import { createMemberSession } from '../src/lib/members/session';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import type { DodoEvent } from '../src/lib/payments/dodo';
import { parseDodoReversalEvent } from '../src/lib/payments/dodo';
import { applyDodoEvent, applyDodoReversal } from '../src/lib/payments/dodo-billing';
import { minimumChargeCents } from '../src/lib/payments/dodo-card-referral-pricing';
import { AppError } from '../src/lib/http';
import { POST as drainApi } from '../src/pages/api/v1/analytics/outbox/drain';
import { POST as ordersApi } from '../src/pages/api/v1/billing/orders/index';
import { POST as reconcileApi } from '../src/pages/api/v1/billing/reconcile';
import { POST as sepayWebhook } from '../src/pages/api/webhooks/sepay';
import { analyticsDrainCheck } from '../workers/scheduler/src/analytics-drain-check';
import type { FetchLike } from '../workers/scheduler/src/jobs';
import { runAll, scheduledJobs } from '../workers/scheduler/src/jobs';

const T0 = Date.parse('2026-10-05T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ORIGIN = 'https://zuey.test';
const CRON = 'cron-secret-for-tests';
const DODO_BASE = 'https://dodo.test';

type TestDb = ReturnType<typeof createTestD1>;
let d1: TestDb;
let now: number;
let sepayTransactions: Record<string, unknown>[];
/** Payments answered by the fake Dodo `GET /payments/{id}`; any other id is a 404. */
let dodoPayments: Record<string, Record<string, unknown>>;
let adminKey: string;

interface OutboxRow {
  id: string;
  dedupe_key: string;
  event: string;
  distinct_id: string;
  properties: string;
  occurred_at: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
}

function rows(event?: string): OutboxRow[] {
  const sql = `SELECT * FROM analytics_outbox ${event ? 'WHERE event = ?' : ''} ORDER BY created_at, dedupe_key`;
  return event ? d1.raw.query<OutboxRow, [string]>(sql).all(event) : d1.raw.query<OutboxRow, []>(sql).all();
}

function props(row: OutboxRow | undefined): unknown {
  return row ? JSON.parse(row.properties) : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field(v: unknown, key: string): unknown {
  return isRecord(v) ? v[key] : undefined;
}

async function fakeFetch(input: string): Promise<Response> {
  if (input === 'https://api.resend.com/emails') return json({ id: 'email_1' });
  if (input.startsWith('https://my.sepay.vn/userapi/transactions/list')) {
    return json({ status: 200, error: null, messages: { success: true }, transactions: sepayTransactions });
  }
  if (input.startsWith(`${DODO_BASE}/payments/`)) {
    const found = dodoPayments[decodeURIComponent(input.slice(`${DODO_BASE}/payments/`.length))];
    return found ? json(found) : json({ code: 'NOT_FOUND' }, 404);
  }
  return json({ error: 'unexpected' }, 500);
}

const env = (overrides: Partial<RuntimeEnv> = {}): RuntimeEnv => ({
  DB: d1,
  PUBLIC_SITE_URL: ORIGIN,
  RESEND_API_KEY: 're_test',
  USD_VND_RATE: '26350',
  SEPAY_WEBHOOK_API_KEY: 'sepay-key',
  SEPAY_BANK_ACCOUNT: '0123456789',
  SEPAY_BANK_CODE: 'MBBank',
  SEPAY_API_TOKEN: 'sepay-api-token',
  DODO_PRODUCT_KNOWLEDGES: 'prod_knowledges',
  CRON_SECRET: CRON,
  ...overrides,
});

function ctx(opts: { url?: string; method?: string; body?: unknown; headers?: Record<string, string>; env?: RuntimeEnv }): APIContext {
  const headers = new Headers(opts.headers ?? {});
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json');
  const request = new Request(opts.url ?? `${ORIGIN}/api/test`, {
    method: opts.method ?? 'POST', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  // Handlers only read request/params/locals; a full APIContext is not constructible in tests.
  const partial = { request, params: {}, url: new URL(request.url), locals: { runtime: { env: opts.env ?? env() } } };
  return partial as unknown as APIContext;
}

async function read(res: Response): Promise<{ data: unknown; code: string | null }> {
  const body: unknown = await res.json();
  return { data: field(body, 'data'), code: isRecord(body) && isRecord(body.error) ? String(body.error.code) : null };
}

interface Member { userId: string; browser: Record<string, string> }

async function member(email: string): Promise<Member> {
  const { user } = await findOrCreateVerifiedUser(d1, { email });
  const { token } = await createMemberSession(d1, user.id);
  return { userId: user.id, browser: { cookie: `zuey_member=${token}`, Origin: ORIGIN } };
}

async function order(m: Member, plan: string, months = 1): Promise<{ code: string; amount: number }> {
  const res = await ordersApi(ctx({ body: { plan, months }, headers: m.browser }));
  expect(res.status).toBe(201);
  const { data } = await read(res);
  return { code: String(field(data, 'code')), amount: Number(field(data, 'amount_vnd')) };
}

let txId = 9000;
function transfer(content: string, amount: number, id = ++txId): Record<string, unknown> {
  const bankTime = new Date(now + 7 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  return { id, gateway: 'MBBank', transactionDate: bankTime, accountNumber: '0123456789', content, transferType: 'in', transferAmount: amount, referenceCode: `FT${id}` };
}

async function webhook(payload: Record<string, unknown>): Promise<unknown> {
  const res = await sepayWebhook(ctx({ body: payload, headers: { Authorization: 'Apikey sepay-key' } }));
  expect(res.status).toBe(200);
  return field((await read(res)).data, 'outcome');
}

function okDestination(seen: ServerAnalyticsEvent[] = []): ServerDestination {
  return { name: 'fake', send: async event => { seen.push(event); return { destination: 'fake', ok: true, status: 200 }; } };
}

function failingDestination(result: DestinationResult): ServerDestination {
  return { name: result.destination, send: async () => result };
}

beforeEach(async () => {
  d1 = createTestD1();
  now = T0;
  sepayTransactions = [];
  dodoPayments = {};
  membersRuntime.now = () => now;
  membersRuntime.fetch = fakeFetch;
  bookingRuntime.now = () => now;
  bookingRuntime.fetch = fakeFetch;
  adminKey = (await createApiKey('ops', 'admin', d1)).key;
});

describe('SePay membership events', () => {
  it('queues exactly one purchase and one activation for a transfer delivered by webhook, replayed and reconciled', async () => {
    const m = await member('lan@example.com');
    const o = await order(m, 'knowledges', 3);
    const payload = transfer(`CK ${o.code}`, o.amount);
    expect(await webhook(payload)).toBe('paid');
    expect(await webhook(payload)).toBe('duplicate_event');
    sepayTransactions = [{ id: payload.id, amount_in: String(o.amount), amount_out: '0', transaction_content: `MBVCB ${o.code}`, reference_number: 'FT1' }];
    const reconciled = await reconcileApi(ctx({ headers: { Authorization: `Bearer ${adminKey}` } }));
    expect(JSON.stringify((await read(reconciled)).data)).toContain('duplicate_event');

    const purchases = rows('purchase');
    expect(purchases).toHaveLength(1);
    expect(purchases[0].distinct_id).toBe(m.userId);
    expect(purchases[0].dedupe_key).toMatch(/^purchase:sepay:billing_order:ord_/);
    // Original currency, no conversion: VND as paid.
    expect(props(purchases[0])).toEqual({
      provider: 'sepay', order_type: 'membership', amount: o.amount, currency: 'VND', renewal: false, plan: 'knowledges', months: 3,
    });
    const activated = rows('subscription_activated');
    expect(activated).toHaveLength(1);
    expect(props(activated[0])).toEqual({ plan: 'knowledges', provider: 'sepay', period_end: new Date(addMonths(T0, 3)).toISOString() });
    const all = JSON.stringify(rows());
    expect(all).not.toContain('lan@example.com');
    expect(all).not.toContain(o.code);
  });

  it('reports a second order while active as a renewal and a flagged transfer once as needing attention', async () => {
    const m = await member('lan@example.com');
    const first = await order(m, 'combo');
    expect(await webhook(transfer(first.code, first.amount))).toBe('paid');
    now += 10 * DAY;
    const second = await order(m, 'combo');
    expect(await webhook(transfer(second.code, second.amount))).toBe('paid');
    expect(rows('purchase')).toHaveLength(2);
    expect(rows('subscription_activated')).toHaveLength(1);
    expect(rows('subscription_renewed')).toHaveLength(1);

    const under = await order(m, 'ai');
    const short = transfer(under.code, under.amount - 1000);
    expect(await webhook(short)).toBe('needs_attention');
    expect(await webhook(short)).toBe('duplicate_event');
    const flagged = rows('payment_needs_attention');
    expect(flagged).toHaveLength(1);
    expect(flagged[0].dedupe_key).toBe(`payment_needs_attention:sepay:${short.id}`);
    expect(props(flagged[0])).toEqual({
      provider: 'sepay', order_type: 'membership', reason: 'underpaid', amount: under.amount - 1000, currency: 'VND', plan: 'ai',
    });
  });

  it('still pays and grants access when the outbox cannot be written', async () => {
    d1.raw.run('DROP TABLE analytics_outbox');
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const m = await member('lan@example.com');
      const o = await order(m, 'knowledges');
      expect(await webhook(transfer(o.code, o.amount))).toBe('paid');
      const sub = d1.raw.query<{ status: string }, [string]>("SELECT status FROM subscriptions WHERE user_id = ? AND plan = 'knowledges'").get(m.userId);
      expect(sub?.status).toBe('active');
      expect(warn.mock.calls.some(c => String(c[0]).includes('analytics outbox: could not queue purchase'))).toBe(true);
      expect(await enqueueServerEvent(d1, { event: 'login', distinctId: m.userId, dedupeKey: 'login:x', properties: { method: 'x' } })).toBe('failed');
    } finally {
      warn.mockRestore();
    }
  });

  it('queues subscription_expired once when a prepaid plan runs out, whichever job sees it', async () => {
    const m = await member('lan@example.com');
    const o = await order(m, 'knowledges');
    expect(await webhook(transfer(o.code, o.amount))).toBe('paid');
    const end = new Date(addMonths(T0, 1)).toISOString();
    now = Date.parse(end) + 60 * 1000;
    expect(await sweepExpiredSubscriptions(d1)).toBe(1);
    expect(await sweepExpiredSubscriptions(d1)).toBe(0);
    await recomputeSubscription(d1, m.userId, 'knowledges');
    const expired = rows('subscription_expired');
    expect(expired).toHaveLength(1);
    expect(expired[0].occurred_at).toBe(end);
    expect(props(expired[0])).toEqual({ plan: 'knowledges', period_end: end });
  });
});

describe('Dodo card events', () => {
  const PRICE = 900;
  let userId: string;

  async function seedCard(): Promise<void> {
    userId = (await member('card@example.com')).userId;
    d1.raw.run(
      `INSERT INTO card_subscriptions (id, provider, provider_subscription_id, user_id, plan, status, current_period_end, created_at, updated_at)
       VALUES ('csub_1', 'dodo', 'sub_1', ?, 'knowledges', 'active', ?, ?, ?)`,
      [userId, new Date(T0 + 30 * DAY).toISOString(), new Date(T0).toISOString(), new Date(T0).toISOString()],
    );
  }

  function payment(type: string, paymentId: string, occurredAt: string, totalAmount = PRICE): DodoEvent {
    return {
      kind: 'payment', type, occurredAt,
      data: {
        paymentId, subscriptionId: 'sub_1', status: null, totalAmount, tax: 0, currency: 'USD', customerId: 'cus_1',
        customerEmail: 'card@example.com', metadata: { userId, plan: 'knowledges', cardRef: 'csub_1' },
      },
    };
  }

  function subscription(type: string, status: string, occurredAt: string, cancelAtPeriodEnd: boolean): DodoEvent {
    return {
      kind: 'subscription', type, occurredAt,
      data: {
        subscriptionId: 'sub_1', status, productId: 'prod_knowledges', customerId: 'cus_1', customerEmail: 'card@example.com',
        amountCents: PRICE, currency: 'USD', nextBillingDate: new Date(T0 + 30 * DAY).toISOString(), cancelAtPeriodEnd,
        metadata: { userId, plan: 'knowledges', cardRef: 'csub_1' },
      },
    };
  }

  it('queues one purchase per Dodo payment id, however often it is delivered, and flags renewals', async () => {
    await seedCard();
    const at = new Date(T0).toISOString();
    expect((await applyDodoEvent(d1, env(), 'wh_1', payment('payment.succeeded', 'pay_1', at))).outcome).toBe('updated');
    expect((await applyDodoEvent(d1, env(), 'wh_1', payment('payment.succeeded', 'pay_1', at))).outcome).toBe('duplicate_event');
    // The same payment under another webhook id (provider redelivery) is still one purchase.
    await applyDodoEvent(d1, env(), 'wh_2', payment('payment.succeeded', 'pay_1', at));
    expect(rows('purchase')).toHaveLength(1);
    expect(props(rows('purchase')[0])).toEqual({
      provider: 'dodo', order_type: 'membership', amount: 9, currency: 'USD', renewal: false, plan: 'knowledges', months: 1,
    });

    now += 30 * DAY;
    await applyDodoEvent(d1, env(), 'wh_3', payment('payment.succeeded', 'pay_2', new Date(now).toISOString()));
    const purchases = rows('purchase');
    expect(purchases.map(r => r.dedupe_key)).toEqual(['purchase:dodo:pay_1', 'purchase:dodo:pay_2']);
    expect(field(props(purchases[1]), 'renewal')).toBe(true);

    expect((await applyDodoReversal(d1, { type: 'refund.succeeded', kind: 'refund', objectId: 'ref_1', paymentId: 'pay_1', amount: PRICE, currency: 'USD', isPartial: false })).outcome).not.toBe('ignored');
    await applyDodoReversal(d1, { type: 'refund.succeeded', kind: 'refund', objectId: 'ref_1', paymentId: 'pay_1', amount: PRICE, currency: 'USD', isPartial: false });
    const refunds = rows('refund');
    expect(refunds).toHaveLength(1);
    expect(props(refunds[0])).toEqual({ provider: 'dodo', order_type: 'membership', reason: 'refund', amount: 9, currency: 'USD', partial: false, plan: 'knowledges' });
    const logged = d1.raw.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM user_activity WHERE user_id = ? AND action = 'billing.card_reversal'").get(userId);
    expect(logged?.n).toBe(1);
  });

  it('matches a refund or lost dispute of a renewal charge to its card, once per refund however often it is delivered', async () => {
    await seedCard();
    await applyDodoEvent(d1, env(), 'wh_1', payment('payment.succeeded', 'pay_1', new Date(T0).toISOString()));
    now += 30 * DAY;
    await applyDodoEvent(d1, env(), 'wh_2', payment('payment.succeeded', 'pay_2', new Date(now).toISOString()));
    // The same renewal under another webhook id still maps to one card.
    await applyDodoEvent(d1, env(), 'wh_3', payment('payment.succeeded', 'pay_2', new Date(now).toISOString()));

    const refund = { type: 'refund.succeeded', kind: 'refund', objectId: 'ref_2', paymentId: 'pay_2', amount: 400, currency: 'USD', isPartial: true } as const;
    expect(await applyDodoReversal(d1, refund)).toEqual({ outcome: 'renewal', card_subscription_id: 'csub_1' });
    expect(await applyDodoReversal(d1, refund)).toEqual({ outcome: 'renewal', card_subscription_id: 'csub_1' });
    const refunds = rows('refund');
    expect(refunds.map(r => r.dedupe_key)).toEqual(['refund:dodo:refund:ref_2']);
    expect(refunds[0].distinct_id).toBe(userId);
    expect(props(refunds[0])).toEqual({ provider: 'dodo', order_type: 'membership', reason: 'refund', amount: 4, currency: 'USD', partial: true, plan: 'knowledges' });

    const lost = { type: 'dispute.lost', kind: 'dispute_lost', objectId: 'dsp_2', paymentId: 'pay_2', amount: 500, currency: 'USD', isPartial: false } as const;
    expect((await applyDodoReversal(d1, lost)).outcome).toBe('renewal');
    expect((await applyDodoReversal(d1, lost)).outcome).toBe('renewal');
    expect(rows('refund').map(r => r.dedupe_key).sort()).toEqual(['refund:dodo:dispute_lost:dsp_2', 'refund:dodo:refund:ref_2']);

    const logged = d1.raw.query<{ detail: string }, [string]>("SELECT detail FROM user_activity WHERE user_id = ? AND action = 'billing.card_reversal' ORDER BY id")
      .all(userId).map(r => JSON.parse(r.detail));
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({ card_subscription_id: 'csub_1', kind: 'refund', payment_id: 'pay_2', amount: 400, partial: true, renewal: true });
    // A payment this site never recorded stays unmatched.
    expect(await applyDodoReversal(d1, { ...refund, objectId: 'ref_x', paymentId: 'pay_unknown' })).toEqual({ outcome: 'ignored', card_subscription_id: null });
  });

  function promoCard(cycles: number): void {
    d1.raw.run("UPDATE card_subscriptions SET promo_code_id = 'promo_1', promo_code = 'HALF', promo_discount_percent = 50, promo_cycles = ? WHERE id = 'csub_1'", [cycles]);
  }

  function cardState(): { status: string; attention_reason: string | null } | null {
    return d1.raw.query<{ status: string; attention_reason: string | null }, []>("SELECT status, attention_reason FROM card_subscriptions WHERE id = 'csub_1'").get();
  }

  it('counts a payment redelivered under another webhook id once for promo coverage and the minimum charge', async () => {
    await seedCard();
    promoCard(2);
    const discounted = minimumChargeCents({ referrer_user_id: null, referral_discount_percent: null, promo_code_id: 'promo_1', promo_discount_percent: 50, promo_cycles: 2 }, 'knowledges', 1);
    expect(discounted).toBeLessThan(PRICE);
    const at = new Date(T0).toISOString();
    expect((await applyDodoEvent(d1, env(), 'wh_1', payment('payment.succeeded', 'pay_1', at, discounted))).outcome).toBe('updated');
    now += 1000;
    expect((await applyDodoEvent(d1, env(), 'wh_2', payment('payment.succeeded', 'pay_1', at, discounted))).outcome).toBe('updated');
    now += 30 * DAY;
    // The second charge is still covered by the two-cycle promo.
    expect((await applyDodoEvent(d1, env(), 'wh_3', payment('payment.succeeded', 'pay_2', new Date(now).toISOString(), discounted))).outcome).toBe('updated');
    expect(cardState()).toEqual({ status: 'active', attention_reason: null });
    now += 30 * DAY;
    // The third is not: a discounted amount is held for review.
    expect((await applyDodoEvent(d1, env(), 'wh_4', payment('payment.succeeded', 'pay_3', new Date(now).toISOString(), discounted))).outcome).toBe('needs_attention');
    expect(cardState()).toEqual({ status: 'needs_attention', attention_reason: 'amount_mismatch' });
  });

  it('still counts charges collected before charge rows were recorded, one per webhook row', async () => {
    await seedCard();
    promoCard(2);
    d1.raw.run("UPDATE card_subscriptions SET first_payment_id = 'pay_0' WHERE id = 'csub_1'");
    d1.raw.run(
      "INSERT INTO payment_events (provider, event_id, card_subscription_id, amount, currency, raw_type, received_at) VALUES ('dodo', 'wh_legacy', 'csub_1', 450, 'USD', 'payment.succeeded', ?)",
      [new Date(T0 - 30 * DAY).toISOString()],
    );
    const discounted = minimumChargeCents({ referrer_user_id: null, referral_discount_percent: null, promo_code_id: 'promo_1', promo_discount_percent: 50, promo_cycles: 2 }, 'knowledges', 1);
    // The legacy charge was cycle 1, so this is cycle 2: still discounted.
    expect((await applyDodoEvent(d1, env(), 'wh_1', payment('payment.succeeded', 'pay_1', new Date(T0).toISOString(), discounted))).outcome).toBe('updated');
    now += 30 * DAY;
    expect((await applyDodoEvent(d1, env(), 'wh_2', payment('payment.succeeded', 'pay_2', new Date(now).toISOString(), discounted))).outcome).toBe('needs_attention');
  });

  const dodoEnv = (): RuntimeEnv => env({ DODO_API_KEY: 'dodo_test_key', DODO_API_BASE: DODO_BASE });

  function reversalLogs(): number {
    return d1.raw.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM user_activity WHERE user_id = ? AND action = 'billing.card_reversal'").get(userId)?.n ?? 0;
  }

  async function rejection(p: Promise<unknown>): Promise<[number, string] | null> {
    const err = await p.then(() => null, (e: unknown) => e);
    return err instanceof AppError ? [err.status, err.code] : null;
  }

  // Dodo's dispute webhook object: no customer, and the amount as a string.
  const lostDispute = (disputeId: string, paymentId: string) => parseDodoReversalEvent({
    business_id: 'bus_1', type: 'dispute.lost', timestamp: new Date(T0).toISOString(),
    data: {
      payload_type: 'Dispute', dispute_id: disputeId, payment_id: paymentId, business_id: 'bus_1', amount: '900', currency: 'USD',
      created_at: new Date(T0).toISOString(), dispute_stage: 'chargeback', dispute_status: 'dispute_lost',
    },
  });

  it('applies a lost dispute that arrives before its renewal charge, through the Dodo payment lookup, once', async () => {
    await seedCard();
    await applyDodoEvent(d1, env(), 'wh_1', payment('payment.succeeded', 'pay_1', new Date(T0).toISOString()));
    dodoPayments.pay_2 = { payment_id: 'pay_2', subscription_id: 'sub_1', customer: { customer_id: 'cus_1' } };
    const dispute = lostDispute('dsp_2', 'pay_2');
    if (!dispute) throw new Error('dispute payload not parsed');
    expect(await applyDodoReversal(d1, dispute, dodoEnv())).toEqual({ outcome: 'renewal', card_subscription_id: 'csub_1' });
    now += 60 * 1000;
    await applyDodoEvent(d1, env(), 'wh_2', payment('payment.succeeded', 'pay_2', new Date(now).toISOString()));
    expect(await applyDodoReversal(d1, dispute, dodoEnv())).toEqual({ outcome: 'renewal', card_subscription_id: 'csub_1' });
    expect(rows('refund').map(r => r.dedupe_key)).toEqual(['refund:dodo:dispute_lost:dsp_2']);
    expect(reversalLogs()).toBe(1);
  });

  it('asks Dodo to retry a refund that arrives before the first charge, then logs it once', async () => {
    await seedCard();
    dodoPayments.pay_1 = { payment_id: 'pay_1', subscription_id: 'sub_1', customer: { customer_id: 'cus_1' } };
    const refund = { type: 'refund.succeeded', kind: 'refund', objectId: 'ref_1', paymentId: 'pay_1', amount: PRICE, currency: 'USD', isPartial: false } as const;
    expect(await rejection(applyDodoReversal(d1, refund, dodoEnv()))).toEqual([409, 'payment_not_recorded']);
    expect(reversalLogs()).toBe(0);
    await applyDodoEvent(d1, env(), 'wh_1', payment('payment.succeeded', 'pay_1', new Date(T0).toISOString()));
    expect((await applyDodoReversal(d1, refund, dodoEnv())).card_subscription_id).toBe('csub_1');
    await applyDodoReversal(d1, refund, dodoEnv());
    expect(rows('refund').map(r => r.dedupe_key)).toEqual(['refund:dodo:refund:ref_1']);
    expect(reversalLogs()).toBe(1);
  });

  it('matches a refund of a renewal charged before charge rows existed, and ignores payments of no card here', async () => {
    await seedCard();
    d1.raw.run("UPDATE card_subscriptions SET first_payment_id = 'pay_0', provider_customer_id = 'cus_1' WHERE id = 'csub_1'");
    dodoPayments.pay_old = { payment_id: 'pay_old', subscription_id: 'sub_1', customer: { customer_id: 'cus_1' } };
    const refund = { type: 'refund.succeeded', kind: 'refund', objectId: 'ref_old', paymentId: 'pay_old', amount: PRICE, currency: 'USD', isPartial: false } as const;
    expect(await applyDodoReversal(d1, refund, dodoEnv())).toEqual({ outcome: 'renewal', card_subscription_id: 'csub_1' });
    expect(await applyDodoReversal(d1, refund, dodoEnv())).toEqual({ outcome: 'renewal', card_subscription_id: 'csub_1' });
    expect(reversalLogs()).toBe(1);

    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      dodoPayments.pay_other = { payment_id: 'pay_other', subscription_id: 'sub_other', customer: { customer_id: 'cus_1' } };
      dodoPayments.pay_once = { payment_id: 'pay_once', subscription_id: null, customer: { customer_id: 'cus_1' } };
      for (const paymentId of ['pay_other', 'pay_once', 'pay_missing']) {
        expect(await applyDodoReversal(d1, { ...refund, objectId: `ref_${paymentId}`, paymentId }, dodoEnv())).toEqual({ outcome: 'ignored', card_subscription_id: null });
      }
      // Without an API key the lookup cannot run: ignored as before.
      expect(await applyDodoReversal(d1, { ...refund, objectId: 'ref_x', paymentId: 'pay_old2' }, env())).toEqual({ outcome: 'ignored', card_subscription_id: null });
    } finally {
      warn.mockRestore();
    }
    expect(reversalLogs()).toBe(1);
  });

  it('logs a reversal once when the activity log write fails and Dodo retries', async () => {
    await seedCard();
    await applyDodoEvent(d1, env(), 'wh_1', payment('payment.succeeded', 'pay_1', new Date(T0).toISOString()));
    now += 30 * DAY;
    await applyDodoEvent(d1, env(), 'wh_2', payment('payment.succeeded', 'pay_2', new Date(now).toISOString()));
    d1.raw.run("CREATE TRIGGER fail_reversal_log BEFORE INSERT ON user_activity WHEN NEW.action = 'billing.card_reversal' BEGIN SELECT RAISE(ABORT, 'log unavailable'); END");
    const refund = { type: 'refund.succeeded', kind: 'refund', objectId: 'ref_2', paymentId: 'pay_2', amount: PRICE, currency: 'USD', isPartial: false } as const;
    expect(await applyDodoReversal(d1, refund).then(() => 'applied', () => 'failed')).toBe('failed');
    expect(reversalLogs()).toBe(0);
    d1.raw.run('DROP TRIGGER fail_reversal_log');
    expect(await applyDodoReversal(d1, refund)).toEqual({ outcome: 'renewal', card_subscription_id: 'csub_1' });
    await applyDodoReversal(d1, refund);
    expect(reversalLogs()).toBe(1);
    expect(rows('refund').map(r => r.dedupe_key)).toEqual(['refund:dodo:refund:ref_2']);
  });

  it('counts a collected charge held for review as a flagged purchase, once', async () => {
    await seedCard();
    const at = new Date(T0).toISOString();
    const short = payment('payment.succeeded', 'pay_low', at, 100);
    expect((await applyDodoEvent(d1, env(), 'wh_l1', short)).outcome).toBe('needs_attention');
    await applyDodoEvent(d1, env(), 'wh_l2', short);
    const purchases = rows('purchase');
    expect(purchases).toHaveLength(1);
    expect(purchases[0].dedupe_key).toBe('purchase:dodo:pay_low');
    expect(props(purchases[0])).toEqual({
      provider: 'dodo', order_type: 'membership', amount: 1, currency: 'USD', renewal: false, plan: 'knowledges', months: 1, flagged: true,
    });
    expect(rows('payment_needs_attention')).toHaveLength(1);
  });

  it('queues failed charges and the cancellation lifecycle once each', async () => {
    await seedCard();
    await applyDodoEvent(d1, env(), 'wh_f1', payment('payment.failed', 'pay_x', new Date(T0).toISOString()));
    await applyDodoEvent(d1, env(), 'wh_f2', payment('payment.failed', 'pay_x', new Date(T0).toISOString()));
    expect(rows('payment_failed')).toHaveLength(1);

    now += DAY;
    await applyDodoEvent(d1, env(), 'wh_s1', subscription('subscription.updated', 'active', new Date(now).toISOString(), true));
    await applyDodoEvent(d1, env(), 'wh_s2', subscription('subscription.updated', 'active', new Date(now + 1000).toISOString(), true));
    expect(rows('subscription_cancel_scheduled')).toHaveLength(1);

    now += DAY;
    await applyDodoEvent(d1, env(), 'wh_s3', subscription('subscription.cancelled', 'cancelled', new Date(now).toISOString(), true));
    await applyDodoEvent(d1, env(), 'wh_s4', subscription('subscription.cancelled', 'cancelled', new Date(now + 1000).toISOString(), true));
    expect(rows('subscription_cancelled')).toHaveLength(1);
    // Access was revoked by the recompute: one expiry, and the drain sweep reports the same one.
    expect(rows('subscription_expired')).toHaveLength(1);
    expect(props(rows('subscription_expired')[0])).toEqual({ plan: 'knowledges', period_end: new Date(now).toISOString() });
    expect(await sweepExpiredSubscriptions(d1)).toBe(0);
    for (const r of rows()) expect(r.distinct_id).toBe(userId);
    expect(JSON.stringify(rows())).not.toContain('card@example.com');
  });
});

describe('outbox writes', () => {
  it('rejects personal data and invalid ids before anything is stored, and ignores a repeated key', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await enqueueServerEvent(d1, { event: 'login', distinctId: 'usr_1', dedupeKey: 'login:a', properties: { method: 'lan@example.com' } })).toBe('rejected');
      expect(await enqueueServerEvent(d1, { event: 'login', distinctId: 'lan@example.com', dedupeKey: 'login:b', properties: { method: 'google' } })).toBe('rejected');
      expect(await enqueueServerEvent(d1, { event: 'login', distinctId: 'usr_1', dedupeKey: 'has space', properties: { method: 'google' } })).toBe('rejected');
      expect(rows()).toHaveLength(0);
      expect(await enqueueServerEvent(d1, { event: 'login', distinctId: 'usr_1', dedupeKey: 'login:c', properties: { method: 'google' } })).toBe('queued');
      expect(await enqueueServerEvent(d1, { event: 'login', distinctId: 'usr_1', dedupeKey: 'login:c', properties: { method: 'google' } })).toBe('duplicate');
      expect(rows()).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('outbox delivery', () => {
  async function queue(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      expect(await enqueueServerEvent(d1, { event: 'login', distinctId: `usr_${i}`, dedupeKey: `login:s${i}`, properties: { method: 'google' } })).toBe('queued');
    }
  }

  it('delivers due rows with the stored uuid and business time, then marks them sent', async () => {
    await enqueueServerEvent(d1, {
      event: 'purchase', distinctId: 'usr_1', dedupeKey: 'purchase:dodo:pay_9', occurredAt: '2026-10-04T10:00:00.000Z',
      properties: { provider: 'dodo', order_type: 'membership', amount: 9, currency: 'USD', renewal: false },
    });
    const seen: ServerAnalyticsEvent[] = [];
    const result = await drainAnalyticsOutbox(d1, { destinations: [okDestination(seen)] });
    expect(result).toMatchObject({ status: 'ok', claimed: 1, sent: 1, retried: 0, dead: 0 });
    const [row] = rows();
    expect(row.status).toBe('sent');
    expect(seen[0]).toMatchObject({ uuid: row.id, event: 'purchase', distinctId: 'usr_1', occurredAt: '2026-10-04T10:00:00.000Z' });
    expect(seen[0].properties).toMatchObject({ amount: 9, currency: 'USD', event_version: 1 });
    expect((await drainAnalyticsOutbox(d1, { destinations: [okDestination(seen)] })).claimed).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it('retries with exponential backoff and dead-letters after the last attempt', async () => {
    const minutes = Array.from({ length: OUTBOX_MAX_ATTEMPTS - 1 }, (_, i) => backoffMs(i + 1) / 60_000);
    expect(minutes).toEqual([5, 10, 20, 40, 80, 160, 320, 360, 360]);
    expect(backoffMs(30)).toBe(OUTBOX_MAX_DELAY_MS);
    await queue(1);
    const down = failingDestination({ destination: 'posthog', ok: false, reason: 'http', status: 503 });
    for (let attempt = 1; attempt < OUTBOX_MAX_ATTEMPTS; attempt++) {
      const result = await drainAnalyticsOutbox(d1, { destinations: [down] });
      expect(result).toMatchObject({ claimed: 1, retried: 1 });
      const [row] = rows();
      expect(row).toMatchObject({ status: 'pending', attempts: attempt, last_error: 'posthog:http:503' });
      expect(row.next_attempt_at).toBe(new Date(now + backoffMs(attempt)).toISOString());
      // Not due yet: nothing is claimed.
      expect((await drainAnalyticsOutbox(d1, { destinations: [down] })).claimed).toBe(0);
      now = Date.parse(row.next_attempt_at);
    }
    expect(await drainAnalyticsOutbox(d1, { destinations: [down] })).toMatchObject({ claimed: 1, dead: 1 });
    expect(rows()[0]).toMatchObject({ status: 'dead', attempts: OUTBOX_MAX_ATTEMPTS });
    now += OUTBOX_MAX_DELAY_MS * 2;
    expect((await drainAnalyticsOutbox(d1, { destinations: [okDestination()] })).claimed).toBe(0);
  });

  it('dead-letters a rejected payload at once but retries an auth error from a wrong key', async () => {
    await queue(1);
    const unauthorised = failingDestination({ destination: 'posthog', ok: false, reason: 'http', status: 401 });
    expect(await drainAnalyticsOutbox(d1, { destinations: [unauthorised] })).toMatchObject({ retried: 1, dead: 0 });
    now += backoffMs(1);
    const rejected = failingDestination({ destination: 'posthog', ok: false, reason: 'http', status: 400 });
    expect(await drainAnalyticsOutbox(d1, { destinations: [rejected] })).toMatchObject({ dead: 1 });
    d1.raw.run(
      `INSERT INTO analytics_outbox (id, dedupe_key, event, distinct_id, properties, occurred_at, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES ('0191c8a2-7d9e-7a1b-9c3d-2e4f5a6b7c8d', 'k:bad', 'login', 'usr_1', '{"method":"lan@example.com"}', ?, 'pending', 0, ?, ?, ?)`,
      [new Date(now).toISOString(), new Date(now).toISOString(), new Date(now).toISOString(), new Date(now).toISOString()],
    );
    const seen: ServerAnalyticsEvent[] = [];
    expect(await drainAnalyticsOutbox(d1, { destinations: [okDestination(seen)] })).toMatchObject({ dead: 1, sent: 0 });
    expect(seen).toHaveLength(0);
    expect(rows().find(r => r.dedupe_key === 'k:bad')?.last_error).toBe('rejected:pii:method');
  });

  it('respects the row limit and the time budget', async () => {
    await queue(25);
    const limited = await drainAnalyticsOutbox(d1, { destinations: [okDestination()], limit: 12 });
    expect(limited).toMatchObject({ claimed: 12, sent: 12, budget_exhausted: false, pending: 13 });
    let ticks = 0;
    const spent = await drainAnalyticsOutbox(d1, { destinations: [okDestination()], budgetMs: 5, clock: () => (ticks++ === 0 ? 0 : 10) });
    expect(spent).toMatchObject({ claimed: 0, budget_exhausted: true });
    expect(await drainAnalyticsOutbox(d1, { destinations: [okDestination()] })).toMatchObject({ sent: 13, pending: 0 });
  });

  it('stays within the D1 query budget of one invocation', async () => {
    await queue(MAX_DRAIN_LIMIT + 5);
    const full = await drainAnalyticsOutbox(d1, { destinations: [okDestination()], limit: MAX_DRAIN_LIMIT });
    expect(full).toMatchObject({ sent: MAX_DRAIN_LIMIT, budget_exhausted: false, pending: 5 });
    expect(full.queries).toBeLessThanOrEqual(MAX_DRAIN_QUERIES);
    expect((await drainAnalyticsOutbox(d1, { destinations: [okDestination()] })).sent).toBe(5);

    // Worst case: every row fails differently, so each one needs its own settle statement.
    d1.raw.run('DELETE FROM analytics_outbox');
    await queue(MAX_DRAIN_LIMIT);
    const distinct: ServerDestination = {
      name: 'posthog',
      send: async event => ({ destination: 'posthog', ok: false, reason: 'http', status: 500 + Number(event.distinctId.slice(4)) }),
    };
    const worst = await drainAnalyticsOutbox(d1, { destinations: [distinct], limit: MAX_DRAIN_LIMIT });
    expect(worst).toMatchObject({ budget_exhausted: true, retried: worst.claimed });
    expect(worst.claimed).toBeGreaterThan(0);
    expect(worst.queries).toBeLessThanOrEqual(MAX_DRAIN_QUERIES);
    expect(rows().filter(r => r.status === 'sending')).toHaveLength(0);
  });

  it('reclaims a lapsed lease but never a live one', async () => {
    await queue(1);
    const lease = (until: number) => d1.raw.run("UPDATE analytics_outbox SET status = 'sending', lease_token = 'other', lease_until = ?", [new Date(until).toISOString()]);
    lease(now + 60 * 1000);
    expect((await drainAnalyticsOutbox(d1, { destinations: [okDestination()] })).claimed).toBe(0);
    lease(now - 1);
    expect((await drainAnalyticsOutbox(d1, { destinations: [okDestination()] })).sent).toBe(1);
  });

  it('claims nothing without a destination and reports what is still queued', async () => {
    await queue(2);
    expect(await drainAnalyticsOutbox(d1, { destinations: [] })).toMatchObject({ status: 'skipped', claimed: 0, pending: 2 });
    expect(rows().every(r => r.status === 'pending' && r.attempts === 0)).toBe(true);
  });

  it('deletes delivered rows after the retention window and keeps undelivered ones', async () => {
    await queue(2);
    await drainAnalyticsOutbox(d1, { destinations: [okDestination()] });
    await enqueueServerEvent(d1, { event: 'login', distinctId: 'usr_9', dedupeKey: 'login:late', properties: { method: 'google' } });
    now += OUTBOX_SENT_RETENTION_MS - DAY;
    expect((await drainAnalyticsOutbox(d1, { destinations: [] })).purged).toBe(0);
    expect((await drainAnalyticsOutbox(d1, { destinations: [failingDestination({ destination: 'posthog', ok: false, reason: 'network' })] })).purged).toBe(0);
    now += 2 * DAY;
    const later = await drainAnalyticsOutbox(d1, { destinations: [failingDestination({ destination: 'posthog', ok: false, reason: 'network' })] });
    expect(later).toMatchObject({ purged: 2, pending: 1 });
    expect(rows().map(r => r.dedupe_key)).toEqual(['login:late']);
  });
});

describe('drain endpoint', () => {
  const cron = { Authorization: `Bearer ${CRON}` };

  it('requires the cron secret or an admin', async () => {
    const res = await drainApi(ctx({ url: 'https://zuey.me/api/v1/analytics/outbox/drain', body: {} }));
    expect([401, 403]).toContain(res.status);
    const admin = await drainApi(ctx({ url: 'https://zuey.me/api/v1/analytics/outbox/drain', body: {}, headers: { Authorization: `Bearer ${adminKey}` } }));
    expect(admin.status).toBe(200);
  });

  it('never delivers from a preview deployment: rows stay queued', async () => {
    await enqueueServerEvent(d1, { event: 'login', distinctId: 'usr_1', dedupeKey: 'login:p', properties: { method: 'google' } });
    const res = await drainApi(ctx({ url: 'https://feat-x.zuey-me.pages.dev/api/v1/analytics/outbox/drain', body: {}, headers: cron }));
    expect(res.status).toBe(200);
    expect((await read(res)).data).toMatchObject({ status: 'skipped', skipped_reason: 'not_production_host', claimed: 0 });
    expect(rows()[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('on the production host outside a production build, delivery stays off', async () => {
    const res = await drainApi(ctx({ url: 'https://zuey.me/api/v1/analytics/outbox/drain', body: {}, headers: cron }));
    expect((await read(res)).data).toMatchObject({ status: 'skipped', skipped_reason: 'analytics_disabled' });
  });

  it('validates the optional limit', async () => {
    const res = await drainApi(ctx({ url: 'https://zuey.me/api/v1/analytics/outbox/drain', body: { limit: 0 }, headers: cron }));
    expect(res.status).toBe(400);
    expect((await read(res)).code).toBe('invalid_field');
  });
});

describe('scheduler worker', () => {
  const DRAIN = '/api/v1/analytics/outbox/drain';
  const schedulerEnv = { SITE_URL: 'https://zuey.me/', CRON_SECRET: 's3cret' };

  interface Call { url: string; auth: string | null; method: string }

  /** Runs one tick where the drain answers `drainData` and every other job answers ok. */
  async function tick(drainData: Record<string, unknown>): Promise<{ calls: Call[]; failed: boolean; warnings: string[] }> {
    const calls: Call[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, auth: new Headers(init.headers).get('authorization'), method: init.method ?? 'GET' });
      const data = url.endsWith(DRAIN) ? drainData : { status: 'ok' };
      return new Response(JSON.stringify({ success: true, data }), { status: 200 });
    };
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const failed = await runAll(schedulerEnv, fetchImpl).then(() => false, () => true);
      return { calls, failed, warnings: warn.mock.calls.map(c => String(c[0])) };
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  }

  const drained = { status: 'ok', skipped_reason: null, claimed: 3, sent: 3, retried: 0, dead: 0, pending: 0 };

  it('drains the analytics outbox on every tick with the cron secret', async () => {
    const jobs = scheduledJobs(schedulerEnv);
    expect(jobs.map(j => j.path)).toContain(DRAIN);
    const { calls, failed, warnings } = await tick(drained);
    expect(failed).toBe(false);
    expect(warnings).toHaveLength(0);
    expect(calls.map(c => c.url)).toEqual(jobs.map(j => `https://zuey.me${j.path}`));
    expect(calls.every(c => c.auth === 'Bearer s3cret' && c.method === 'POST')).toBe(true);
  });

  it('warns on dead-lettered rows and fails when nothing could be delivered or analytics is off with a backlog', async () => {
    const dead = await tick({ ...drained, sent: 2, dead: 1 });
    expect(dead.failed).toBe(false);
    expect(dead.warnings.some(w => w.includes(DRAIN) && w.includes('dead-lettered 1'))).toBe(true);

    expect((await tick({ ...drained, sent: 0, retried: 3, pending: 3 })).failed).toBe(true);
    expect((await tick({ ...drained, status: 'skipped', skipped_reason: 'analytics_disabled', claimed: 0, sent: 0, pending: 4 })).failed).toBe(true);
    // Nothing queued: analytics being off is not an incident.
    expect((await tick({ ...drained, status: 'skipped', skipped_reason: 'analytics_disabled', claimed: 0, sent: 0, pending: 0 })).failed).toBe(false);
  });

  it('classifies drain summaries without throwing on unexpected bodies', () => {
    expect(analyticsDrainCheck({ data: drained }, '').level).toBe('ok');
    expect(analyticsDrainCheck({ data: { ...drained, status: 'skipped', skipped_reason: 'not_production_host' } }, '').level).toBe('warn');
    expect(analyticsDrainCheck(null, 'not json').level).toBe('warn');
    expect(analyticsDrainCheck({ data: 'x' }, '').level).toBe('warn');
  });
});
