import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createApiKey } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { bookingRuntime, setAvailability } from '../src/lib/booking/store';
import { AppError } from '../src/lib/http';
import { MCP_FEATURE_MODULES } from '../src/lib/mcp/registry';
import type { McpContext } from '../src/lib/mcp/types';
import { ORDER_TTL_MS, freeCardMonths } from '../src/lib/members/billing';
import { prepayVnd } from '../src/lib/members/plans';
import { membersRuntime } from '../src/lib/members/runtime';
import { createMemberSession } from '../src/lib/members/session';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { resolvePrincipal } from '../src/lib/members/policy';
import { TOOL_ACCESS } from '../src/lib/oauth/tool-access';
import { OPENAPI_FRAGMENTS } from '../src/lib/openapi/registry';
import { signDodoPayload } from '../src/lib/payments/dodo';
import { promosMcpModule } from '../src/lib/promos/promo-mcp';
import { ensureReferralProfile } from '../src/lib/referrals/codes';
import { GET as invoicesCsv } from '../src/pages/api/v1/admin/invoice-requests.csv';
import { GET as invoicesList } from '../src/pages/api/v1/admin/invoice-requests/index';
import { POST as invoiceIssue } from '../src/pages/api/v1/admin/invoice-requests/[id]/issue';
import { GET as promoList, POST as promoCreate } from '../src/pages/api/v1/admin/promo-codes/index';
import { PATCH as promoPatch } from '../src/pages/api/v1/admin/promo-codes/[id]/index';
import { GET as promoRedemptions } from '../src/pages/api/v1/admin/promo-codes/[id]/redemptions';
import { POST as ordersApi } from '../src/pages/api/v1/billing/orders/index';
import { POST as holdApi } from '../src/pages/api/v1/booking/hold';
import { GET as quoteApi } from '../src/pages/api/v1/promos/quote';
import { POST as dodoWebhook } from '../src/pages/api/webhooks/dodo';
import { POST as sepayWebhook } from '../src/pages/api/webhooks/sepay';

const ORIGIN = 'https://zuey.test';
const T0 = Date.parse('2026-10-05T00:00:00.000Z');
const SLOT = '2026-10-07T02:00:00.000Z';
const RATE = 26350;
const DODO_SECRET = `whsec_${btoa('zuey-promo-dodo-secret')}`;
const DODO_BASE = 'https://test.dodopayments.com';

let d1: ReturnType<typeof createTestD1>;
let now: number;
let adminKey: string;
interface Call { url: string; body: string }
let calls: Call[];
let emails: { to: string; subject: string }[];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field(v: unknown, ...path: string[]): unknown {
  let cur = v;
  for (const k of path) cur = isRecord(cur) ? cur[k] : undefined;
  return cur;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Mocked provider APIs; unknown URLs fail loudly so no request leaves the process. */
async function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  const body = typeof init?.body === 'string' ? init.body : '';
  calls.push({ url: input, body });
  if (input === 'https://api.resend.com/emails') {
    const parsed: unknown = JSON.parse(body);
    const to = field(parsed, 'to');
    emails.push({ to: Array.isArray(to) ? String(to[0]) : String(to), subject: String(field(parsed, 'subject')) });
    return json({ id: `email_${emails.length}` });
  }
  if (input === `${DODO_BASE}/discounts`) return json({ discount_id: `dsc_${calls.length}`, code: `PROMO${calls.length}XYZ` });
  if (input === `${DODO_BASE}/checkouts`) return json({ session_id: `cks_${calls.length}`, checkout_url: `https://test.checkout.dodopayments.com/session/cks_${calls.length}` });
  return json({ error: `unexpected ${input}` }, 500);
}

function env(): RuntimeEnv {
  return {
    DB: d1,
    PUBLIC_SITE_URL: ORIGIN,
    MEMBER_HASH_SALT: 'salt',
    RESEND_API_KEY: 're_test',
    ADMIN_EMAILS: 'boss@example.com',
    USD_VND_RATE: String(RATE),
    SEPAY_WEBHOOK_API_KEY: 'sepay-key',
    SEPAY_BANK_ACCOUNT: '0123456789',
    SEPAY_BANK_CODE: 'MBBank',
    CONSULTATION_PRICE_VND: '52000000',
    DODO_API_KEY: 'dodo_test_key',
    DODO_WEBHOOK_SECRET: DODO_SECRET,
    DODO_API_BASE: DODO_BASE,
    DODO_PRODUCT_KNOWLEDGES: 'pdt_knowledges',
    DODO_PRODUCT_AI: 'pdt_ai',
    DODO_PRODUCT_COMBO: 'pdt_combo',
    DODO_PRODUCT_COMMUNITY: 'pdt_community',
  };
}

interface CtxOpts { method?: string; path?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; params?: Record<string, string> }

function ctx(opts: CtxOpts): APIContext {
  const headers = new Headers(opts.headers ?? {});
  const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined && !headers.has('content-type')) headers.set('Content-Type', 'application/json');
  const request = new Request(`${ORIGIN}${opts.path ?? '/api/test'}`, { method: opts.method ?? 'GET', headers, body });
  // Handlers only read request/params/locals; a full APIContext is not constructible in tests.
  const partial = { request, params: opts.params ?? {}, url: new URL(request.url), locals: { runtime: { env: env() } } };
  return partial as unknown as APIContext;
}

interface Result { status: number; data: unknown; code: string | null; reason: unknown }

async function read(res: Response): Promise<Result> {
  const body: unknown = await res.json();
  return { status: res.status, data: field(body, 'data'), code: typeof field(body, 'error', 'code') === 'string' ? String(field(body, 'error', 'code')) : null, reason: field(body, 'error', 'reason') };
}

const admin = (): Record<string, string> => ({ Authorization: `Bearer ${adminKey}` });

async function createPromo(body: Record<string, unknown>): Promise<{ id: string; code: string }> {
  const res = await read(await promoCreate(ctx({ method: 'POST', body, headers: admin() })));
  expect(res.status).toBe(201);
  return { id: String(field(res.data, 'id')), code: String(field(res.data, 'code')) };
}

interface Member { userId: string; cookie: string }

async function member(email: string): Promise<Member> {
  const { user } = await findOrCreateVerifiedUser(d1, { email });
  const { token } = await createMemberSession(d1, user.id);
  return { userId: user.id, cookie: `zuey_member=${token}` };
}

async function referrer(email: string, discount: number): Promise<{ id: string; code: string }> {
  const { user } = await findOrCreateVerifiedUser(d1, { email });
  const { code } = await ensureReferralProfile(d1, user.id);
  await d1.prepare('UPDATE referral_profiles SET discount_percent = ?, admin_enabled = 1 WHERE user_id = ?').bind(discount, user.id).run();
  return { id: user.id, code };
}

async function checkout(m: Member, body: Record<string, unknown>): Promise<Result> {
  return read(await ordersApi(ctx({ method: 'POST', body, headers: { cookie: m.cookie, Origin: ORIGIN } })));
}

async function row(table: string, where: string, value: string): Promise<Record<string, unknown>> {
  const r = await d1.prepare(`SELECT * FROM ${table} WHERE ${where} = ?`).bind(value).first<Record<string, unknown>>();
  if (!r) throw new Error(`${table} row missing`);
  return r;
}

let txId = 7000;
async function payByTransfer(code: string, amount: number): Promise<unknown> {
  const id = ++txId;
  const transactionDate = new Date(now + 7 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const res = await sepayWebhook(ctx({
    method: 'POST', headers: { Authorization: 'Apikey sepay-key' },
    body: { id, gateway: 'MBBank', transactionDate, accountNumber: '0123456789', content: `CK ${code}`, transferType: 'in', transferAmount: amount, referenceCode: `FT${id}` },
  }));
  return field((await read(res)).data, 'outcome');
}

let webhookSeq = 0;
async function sendDodo(type: string, data: Record<string, unknown>): Promise<unknown> {
  const body = JSON.stringify({ business_id: 'bus_test', type, timestamp: new Date(now).toISOString(), data });
  const id = `msg_${++webhookSeq}`;
  const ts = String(Math.floor(now / 1000));
  const signature = await signDodoPayload(DODO_SECRET, id, ts, body);
  const res = await dodoWebhook(ctx({ method: 'POST', rawBody: body, headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signature } }));
  return field((await read(res)).data, 'outcome');
}

beforeEach(async () => {
  d1 = createTestD1();
  now = T0;
  calls = [];
  emails = [];
  membersRuntime.now = () => now;
  membersRuntime.fetch = fakeFetch;
  bookingRuntime.now = () => now;
  bookingRuntime.fetch = fakeFetch;
  adminKey = (await createApiKey('ops', 'admin', d1)).key;
  const rules = [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start_time: '09:00', end_time: '12:00', timezone: 'Asia/Ho_Chi_Minh', slot_minutes: 90 }));
  await setAvailability(d1, { rules, exceptions: [] });
});

afterEach(() => {
  membersRuntime.now = () => Date.now();
  bookingRuntime.now = () => Date.now();
});

describe('promo code admin', () => {
  it('creates, lists, edits and disables codes; names never collide with referral codes', async () => {
    const promo = await createPromo({ code: 'launch30', percent: 30, label: 'Launch', max_uses: 100 });
    expect(promo.code).toBe('LAUNCH30');
    const dup = await read(await promoCreate(ctx({ method: 'POST', body: { code: 'LAUNCH30', percent: 10 }, headers: admin() })));
    expect(dup.status).toBe(409);
    expect(dup.code).toBe('code_taken');
    const ref = await referrer('ref@example.com', 10);
    const clash = await read(await promoCreate(ctx({ method: 'POST', body: { code: ref.code, percent: 10 }, headers: admin() })));
    expect(clash.code).toBe('code_taken');
    expect((await read(await promoCreate(ctx({ method: 'POST', body: { code: 'X1', percent: 101 }, headers: admin() })))).status).toBe(400);
    expect((await read(await promoCreate(ctx({ method: 'POST', body: { code: 'X2', percent: 10 } })))).status).toBe(401);

    const listed = await read(await promoList(ctx({ path: '/api/v1/admin/promo-codes?q=launch', headers: admin() })));
    const codes = field(listed.data, 'promo_codes');
    expect(Array.isArray(codes) ? codes.map(c => field(c, 'code')) : []).toEqual(['LAUNCH30']);
    expect(field(Array.isArray(codes) ? codes[0] : null, 'stats', 'redeemed')).toBe(0);
    expect(field(Array.isArray(codes) ? codes[0] : null, 'remaining_uses')).toBe(100);

    const patched = await read(await promoPatch(ctx({ method: 'PATCH', body: { status: 'disabled', percent: 35 }, headers: admin(), params: { id: promo.id } })));
    expect(field(patched.data, 'status')).toBe('disabled');
    expect(field(patched.data, 'percent')).toBe(35);
    const m = await member('lan@example.com');
    const rejected = await checkout(m, { plan: 'ai', discount_code: 'launch30' });
    expect(rejected.code).toBe('promo_code_invalid');
    expect(rejected.reason).toBe('disabled');
  });

  it('refuses to rename a code that was already used', async () => {
    const promo = await createPromo({ code: 'GIFT10', percent: 10 });
    const m = await member('lan@example.com');
    expect((await checkout(m, { plan: 'ai', discount_code: 'GIFT10' })).status).toBe(201);
    const renamed = await read(await promoPatch(ctx({ method: 'PATCH', body: { code: 'GIFT11' }, headers: admin(), params: { id: promo.id } })));
    expect(renamed.code).toBe('code_in_use');
  });
});

describe('SePay membership order with a promo code', () => {
  it('applies the promo percent after the prepay discount and snapshots it', async () => {
    const promo = await createPromo({ code: 'LAUNCH30', percent: 30 });
    const m = await member('lan@example.com');
    const res = await checkout(m, { plan: 'combo', months: 12, discount_code: 'launch30', amount_vnd: 1 });
    expect(res.status).toBe(201);
    const before = prepayVnd(1900, 12, RATE);
    expect(field(res.data, 'amount_before_promo_vnd')).toBe(before);
    expect(field(res.data, 'amount_vnd')).toBe(before - Math.floor((before * 30) / 100 / 1000) * 1000);
    expect(field(res.data, 'promo_code')).toBe('LAUNCH30');
    expect(field(res.data, 'promo_discount_percent')).toBe(30);
    const order = await row('billing_orders', 'code', String(field(res.data, 'code')));
    expect(order.promo_code_id).toBe(promo.id);
    expect(order.referrer_user_id).toBeNull();
    const use = await row('promo_redemptions', 'promo_code_id', promo.id);
    expect(use.status).toBe('reserved');

    // Paying redeems the use and shows up in the admin stats.
    expect(await payByTransfer(String(order.code), Number(order.amount_vnd))).toBe('paid');
    expect((await row('promo_redemptions', 'promo_code_id', promo.id)).status).toBe('redeemed');
    const redemptions = await read(await promoRedemptions(ctx({ headers: admin(), params: { id: promo.id } })));
    expect(field(redemptions.data, 'promo_code', 'stats', 'redeemed')).toBe(1);
    expect(field(redemptions.data, 'promo_code', 'stats', 'revenue_vnd')).toBe(order.amount_vnd);
  });

  it('never stacks with a referral: the larger percent wins and a tie keeps the referral', async () => {
    await createPromo({ code: 'TEN', percent: 10 });
    await createPromo({ code: 'FORTY', percent: 40, once_per_customer: false });
    const ref = await referrer('ref@example.com', 10);
    const m = await member('lan@example.com');
    // Bind the account to the referrer first, then type promo codes.
    const bound = await checkout(m, { plan: 'ai', discount_code: ref.code });
    expect(field(bound.data, 'referral_discount_percent')).toBe(10);
    await d1.prepare("UPDATE billing_orders SET status = 'expired'").run();

    const tie = await checkout(m, { plan: 'ai', discount_code: 'TEN' });
    expect(tie.status).toBe(201);
    expect(field(tie.data, 'promo_code')).toBeNull();
    expect(field(tie.data, 'referral_discount_percent')).toBe(10);
    await d1.prepare("UPDATE billing_orders SET status = 'expired'").run();

    const bigger = await checkout(m, { plan: 'ai', discount_code: 'FORTY' });
    expect(field(bigger.data, 'promo_code')).toBe('FORTY');
    expect(field(bigger.data, 'referral_discount_percent')).toBeNull();
    const order = await row('billing_orders', 'code', String(field(bigger.data, 'code')));
    expect(order.referrer_user_id).toBeNull();
    expect(order.amount_before_referral).toBeNull();
  });

  it('holds one use per open order, releases it when the order expires and enforces once per customer', async () => {
    const promo = await createPromo({ code: 'ONLYONE', percent: 20, max_uses: 1 });
    const a = await member('a@example.com');
    const b = await member('b@example.com');
    expect((await checkout(a, { plan: 'ai', discount_code: 'ONLYONE' })).status).toBe(201);
    const blocked = await checkout(b, { plan: 'ai', discount_code: 'ONLYONE' });
    expect(blocked.code).toBe('promo_code_invalid');
    expect(blocked.reason).toBe('exhausted');

    // a's order lapses: the held use is free again.
    now += ORDER_TTL_MS + 1000;
    const second = await checkout(b, { plan: 'ai', discount_code: 'ONLYONE' });
    expect(second.status).toBe(201);
    expect(await payByTransfer(String(field(second.data, 'code')), Number(field(second.data, 'amount_vnd')))).toBe('paid');

    await d1.prepare('UPDATE promo_codes SET max_uses = NULL WHERE id = ?').bind(promo.id).run();
    const again = await checkout(b, { plan: 'knowledges', discount_code: 'ONLYONE' });
    expect(again.reason).toBe('already_used');
  });

  it('checks the date window and product / plan / term limits', async () => {
    await createPromo({ code: 'LATER', percent: 10, starts_at: new Date(T0 + 86_400_000).toISOString() });
    await createPromo({ code: 'GONE', percent: 10, ends_at: new Date(T0 - 1000).toISOString() });
    await createPromo({ code: 'COMBOONLY', percent: 10, plans: ['combo'] });
    await createPromo({ code: 'LONGTERM', percent: 10, min_months: 6 });
    await createPromo({ code: 'BOOKONLY', percent: 10, products: ['booking'] });
    const m = await member('lan@example.com');
    const reason = async (code: string, extra: Record<string, unknown> = {}) => (await checkout(m, { plan: 'ai', discount_code: code, ...extra })).reason;
    expect(await reason('LATER')).toBe('not_started');
    expect(await reason('GONE')).toBe('expired');
    expect(await reason('COMBOONLY')).toBe('plan_not_eligible');
    expect(await reason('LONGTERM', { months: 3 })).toBe('term_too_short');
    expect(await reason('BOOKONLY')).toBe('product_not_eligible');
    expect((await checkout(m, { plan: 'ai', discount_code: 'NOPE!!' })).code).toBe('discount_code_invalid');
  });

  it('activates a 100% code at once with a paid 0 VND order', async () => {
    const promo = await createPromo({ code: 'FREEMONTH', percent: 100 });
    const m = await member('lan@example.com');
    const res = await checkout(m, { plan: 'ai', discount_code: 'FREEMONTH' });
    expect(res.status).toBe(201);
    expect(field(res.data, 'amount_vnd')).toBe(0);
    expect(field(res.data, 'status')).toBe('paid');
    const order = await row('billing_orders', 'code', String(field(res.data, 'code')));
    expect(order.payment_ref).toBe('promo:FREEMONTH');
    expect((await row('promo_redemptions', 'promo_code_id', promo.id)).status).toBe('redeemed');
    expect((await row('subscriptions', 'user_id', m.userId)).plan).toBe('ai');
  });

  it('does not count a promo order as the first order for the referral program', async () => {
    await createPromo({ code: 'WELCOME', percent: 50 });
    const m = await member('lan@example.com');
    const promoOrder = await checkout(m, { plan: 'ai', discount_code: 'WELCOME' });
    expect(await payByTransfer(String(field(promoOrder.data, 'code')), Number(field(promoOrder.data, 'amount_vnd')))).toBe('paid');
    const ref = await referrer('ref@example.com', 10);
    const later = await checkout(m, { plan: 'combo', discount_code: ref.code });
    expect(later.status).toBe(201);
    expect(field(later.data, 'referral_discount_percent')).toBe(10);
  });
});

describe('Dodo card checkout with a promo code', () => {
  it('creates a discount covering the configured months and accepts the discounted charges', async () => {
    const promo = await createPromo({ code: 'CARD50', percent: 50, card_cycles: 2 });
    const m = await member('lan@example.com');
    const res = await checkout(m, { plan: 'combo', provider: 'dodo', discount_code: 'card50' });
    expect(res.status).toBe(201);
    const discount: unknown = JSON.parse(calls.find(c => c.url === `${DODO_BASE}/discounts`)?.body ?? '{}');
    expect(field(discount, 'amount')).toBe(5000);
    expect(field(discount, 'subscription_cycles')).toBe(2);
    expect(field(discount, 'name')).toBe('Promo CARD50 50%');
    const id = String(field(res.data, 'id'));
    const card = await row('card_subscriptions', 'id', id);
    expect(card.promo_code_id).toBe(promo.id);
    expect(card.referrer_user_id).toBeNull();

    const metadata = { user_id: m.userId, plan: 'combo', card_ref: id };
    const sub = {
      payload_type: 'Subscription', subscription_id: 'sub_1', status: 'active', product_id: 'pdt_combo', recurring_pre_tax_amount: 1900,
      currency: 'USD', next_billing_date: '2026-11-05T00:00:00Z', customer: { customer_id: 'cus_1', email: 'lan@example.com' }, metadata,
    };
    expect(await sendDodo('subscription.active', sub)).toBe('activated');
    const payment = (paymentId: string, total: number): Record<string, unknown> => ({
      payload_type: 'Payment', payment_id: paymentId, subscription_id: 'sub_1', total_amount: total, tax: 0, currency: 'USD', status: 'succeeded',
      customer: { customer_id: 'cus_1', email: 'lan@example.com' }, metadata,
    });
    expect(await sendDodo('payment.succeeded', payment('pay_1', 950))).toBe('updated');
    expect((await row('promo_redemptions', 'promo_code_id', promo.id)).status).toBe('redeemed');
    // The second month is still discounted; the third must be list price.
    expect(await sendDodo('payment.succeeded', payment('pay_2', 950))).toBe('updated');
    expect(await sendDodo('payment.succeeded', payment('pay_3', 950))).toBe('needs_attention');
    expect((await row('card_subscriptions', 'id', id)).attention_reason).toBe('amount_mismatch');
  });

  it('turns a 100% card code into a free prepaid order for the covered months', async () => {
    await createPromo({ code: 'KOLFREE', percent: 100, card_cycles: 3 });
    const m = await member('lan@example.com');
    const res = await checkout(m, { plan: 'ai', provider: 'dodo', discount_code: 'KOLFREE' });
    expect(res.status).toBe(201);
    expect(field(res.data, 'provider')).toBe('sepay');
    expect(field(res.data, 'status')).toBe('paid');
    expect(field(res.data, 'months')).toBe(freeCardMonths(3));
    expect(calls.some(c => c.url.startsWith(DODO_BASE))).toBe(false);
  });

  it('rejects an invoice request on the card rail', async () => {
    const m = await member('lan@example.com');
    const res = await checkout(m, { plan: 'ai', provider: 'dodo', invoice: { tax_id: '0312345678', email: 'ketoan@acme.vn' } });
    expect(res.code).toBe('invoice_requires_sepay');
  });
});

describe('business invoice requests', () => {
  it('records the tax ID, emails the admins once paid, and lets them record the invoice number', async () => {
    const m = await member('lan@example.com');
    const bad = await checkout(m, { plan: 'ai', invoice: { tax_id: '12345', email: 'ketoan@acme.vn' } });
    expect(bad.code).toBe('invalid_field');
    const res = await checkout(m, { plan: 'ai', invoice: { tax_id: '0312345678-001', email: 'ketoan@acme.vn' } });
    expect(res.status).toBe(201);
    const code = String(field(res.data, 'code'));
    const order = await row('billing_orders', 'code', code);
    let inv = await row('invoice_requests', 'source_id', String(order.id));
    expect(inv.status).toBe('awaiting_payment');
    expect(emails.filter(e => e.to === 'boss@example.com')).toHaveLength(0);

    expect(await payByTransfer(code, Number(order.amount_vnd))).toBe('paid');
    inv = await row('invoice_requests', 'source_id', String(order.id));
    expect(inv.status).toBe('requested');
    expect(inv.amount_paid_vnd).toBe(order.amount_vnd);
    expect(emails.filter(e => e.to === 'boss@example.com')).toHaveLength(1);

    const listed = await read(await invoicesList(ctx({ path: '/api/v1/admin/invoice-requests?status=requested', headers: admin() })));
    const items = field(listed.data, 'invoice_requests');
    expect(Array.isArray(items) ? items.map(i => field(i, 'source_code')) : []).toEqual([code]);
    const csv = await invoicesCsv(ctx({ path: '/api/v1/admin/invoice-requests.csv', headers: admin() }));
    expect(await csv.text()).toContain('0312345678-001');

    const missing = await read(await invoiceIssue(ctx({ method: 'POST', body: {}, headers: admin(), params: { id: String(inv.id) } })));
    expect(missing.code).toBe('invalid_field');
    const issued = await read(await invoiceIssue(ctx({ method: 'POST', body: { invoice_no: 'C26TAA-0001' }, headers: admin(), params: { id: String(inv.id) } })));
    expect(field(issued.data, 'status')).toBe('issued');
    expect(field(issued.data, 'invoice_no')).toBe('C26TAA-0001');
  });

  it('skips the invoice for a free order and refuses to issue one before payment', async () => {
    await createPromo({ code: 'ALLFREE', percent: 100 });
    const m = await member('lan@example.com');
    const free = await checkout(m, { plan: 'ai', discount_code: 'ALLFREE', invoice: { tax_id: '0312345678', email: 'ketoan@acme.vn' } });
    expect(free.status).toBe(201);
    expect(await d1.prepare('SELECT COUNT(*) AS n FROM invoice_requests').first<{ n: number }>()).toEqual({ n: 0 });

    const unpaid = await checkout(m, { plan: 'combo', invoice: { tax_id: '0312345678', email: 'ketoan@acme.vn' } });
    const inv = await row('invoice_requests', 'source_code', String(field(unpaid.data, 'code')));
    const early = await read(await invoiceIssue(ctx({ method: 'POST', body: { invoice_no: 'X' }, headers: admin(), params: { id: String(inv.id) } })));
    expect(early.status).toBe(409);
  });
});

describe('consultation booking with a promo code', () => {
  async function hold(extra: Record<string, unknown>): Promise<Result> {
    return read(await holdApi(ctx({ method: 'POST', body: { slot_start: SLOT, name: 'Lan', email: 'lan@example.com', payment_method: 'sepay', ...extra } })));
  }

  it('discounts the bank transfer and records the invoice request', async () => {
    const promo = await createPromo({ code: 'TUVAN20', percent: 20, products: ['booking'] });
    const h = await hold({ discount_code: 'tuvan20', invoice: { tax_id: '0312345678', email: 'ketoan@acme.vn' } });
    expect(h.status).toBe(201);
    expect(field(h.data, 'booking', 'promo_code')).toBe('TUVAN20');
    expect(field(h.data, 'booking', 'sepay', 'amount')).toBe(41_600_000);
    const id = String(field(h.data, 'booking', 'id'));
    expect((await row('promo_redemptions', 'promo_code_id', promo.id)).status).toBe('reserved');
    expect((await row('invoice_requests', 'source_id', id)).status).toBe('awaiting_payment');
  });

  it('confirms a 100% booking without payment and applies once per mailbox', async () => {
    await createPromo({ code: 'GIFTCALL', percent: 100, products: ['booking'] });
    const h = await hold({ discount_code: 'GIFTCALL' });
    expect(h.status).toBe(201);
    expect(field(h.data, 'booking', 'status')).toBe('confirmed');
    expect(field(h.data, 'booking', 'amount_expected')).toBe(0);
    const again = await read(await holdApi(ctx({ method: 'POST', body: { slot_start: '2026-10-08T02:00:00.000Z', name: 'Lan', email: 'LAN@example.com', payment_method: 'sepay', discount_code: 'GIFTCALL' } })));
    expect(again.reason).toBe('already_used');
  });
});

describe('public quote, OpenAPI and MCP', () => {
  it('quotes live codes and tells unknown codes apart from unusable ones', async () => {
    await createPromo({ code: 'LAUNCH30', percent: 30, plans: ['combo'], card_cycles: 3 });
    await createPromo({ code: 'OLD', percent: 30, ends_at: new Date(T0 - 1000).toISOString() });
    const ok = await read(await quoteApi(ctx({ path: '/api/v1/promos/quote?code=launch30' })));
    expect(ok.data).toMatchObject({ code: 'LAUNCH30', percent: 30, plans: ['combo'], card_cycles: 3 });
    const old = await read(await quoteApi(ctx({ path: '/api/v1/promos/quote?code=OLD' })));
    expect(old.code).toBe('promo_code_invalid');
    expect(old.reason).toBe('expired');
    expect((await read(await quoteApi(ctx({ path: '/api/v1/promos/quote?code=nothing' })))).code).toBe('promo_code_not_found');
  });

  it('documents the paths and registers admin-only MCP tools', async () => {
    const paths = Object.assign({}, ...OPENAPI_FRAGMENTS.map(f => f.paths));
    for (const p of [
      '/api/v1/promos/quote', '/api/v1/admin/promo-codes', '/api/v1/admin/promo-codes/{id}', '/api/v1/admin/promo-codes/{id}/redemptions',
      '/api/v1/admin/invoice-requests', '/api/v1/admin/invoice-requests/{id}/issue', '/api/v1/admin/invoice-requests.csv',
    ]) expect(paths[p]).toBeDefined();

    const names = promosMcpModule.tools.map(t => t.name);
    expect(names).toEqual(['promo_code_list', 'promo_code_create', 'promo_code_update', 'promo_code_redemptions', 'invoice_request_list', 'invoice_request_mark_issued']);
    expect(MCP_FEATURE_MODULES).toContain(promosMcpModule);
    for (const n of names) expect(TOOL_ACCESS[n]).toEqual({ kind: 'admin' });

    const mcpCtx = (key: string | null): McpContext => {
      const request = new Request(`${ORIGIN}/api/mcp`, { method: 'POST', headers: key ? { Authorization: `Bearer ${key}` } : {} });
      const e = env();
      return {
        request, env: e, d1,
        async requireAdmin() { throw new AppError(401, 'unauthorized', 'Unauthorized'); },
        async isAdmin() { return false; },
        principal: () => resolvePrincipal(request, e),
      };
    };
    const created = await promosMcpModule.call('promo_code_create', { code: 'MCP15', percent: 15 }, mcpCtx(adminKey));
    expect(field(created, 'code')).toBe('MCP15');
    const listed = await promosMcpModule.call('promo_code_list', {}, mcpCtx(adminKey));
    const codes = field(listed, 'promo_codes');
    expect(Array.isArray(codes) ? codes.map(c => field(c, 'code')) : []).toEqual(['MCP15']);
    let status: number | null = null;
    try {
      await promosMcpModule.call('promo_code_list', {}, mcpCtx(null));
    } catch (err) {
      status = err instanceof AppError ? err.status : -1;
    }
    expect(status).toBe(401);
  });
});
