import { beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createApiKey, createSession } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { bookingRuntime, getBookingRow } from '../src/lib/booking/store';
import { getArticleView, resolveViewer } from '../src/lib/blocks/articles';
import { articlesMcpModule } from '../src/lib/blocks/mcp';
import { AppError } from '../src/lib/http';
import type { McpContext } from '../src/lib/mcp/types';
import { createUserKey } from '../src/lib/members/api-keys';
import type { UserKeyScope } from '../src/lib/members/api-keys';
import { addMonths } from '../src/lib/members/subscriptions';
import { membersMcpModule } from '../src/lib/members/mcp';
import { monthlyVnd, prepayVnd } from '../src/lib/members/plans';
import { resolvePrincipal } from '../src/lib/members/policy';
import { membersRuntime } from '../src/lib/members/runtime';
import { createMemberSession } from '../src/lib/members/session';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { POST as createArticleApi } from '../src/pages/api/v1/articles/index';
import { GET as articleApi } from '../src/pages/api/v1/articles/[slug]';
import { POST as publishApi } from '../src/pages/api/v1/articles/[slug]/publish';
import { GET as articleMdApi } from '../src/pages/articles/[slug].md';
import { PUT as availabilityApi } from '../src/pages/api/v1/booking/availability';
import { POST as holdApi } from '../src/pages/api/v1/booking/hold';
import { POST as bookingCheckoutApi } from '../src/pages/api/v1/booking/[id]/checkout';
import { GET as plansApi } from '../src/pages/api/v1/plans';
import { GET as ordersListApi, POST as ordersApi } from '../src/pages/api/v1/billing/orders/index';
import { GET as orderApi } from '../src/pages/api/v1/billing/orders/[code]';
import { GET as subscriptionApi } from '../src/pages/api/v1/billing/subscription';
import { POST as reconcileApi } from '../src/pages/api/v1/billing/reconcile';
import { POST as remindersApi } from '../src/pages/api/v1/billing/reminders';
import { POST as sepayWebhook } from '../src/pages/api/webhooks/sepay';
import { experienceRuntime } from '../src/lib/experience/runtime';

const T0 = Date.parse('2026-10-05T00:00:00.000Z');
const ORIGIN = 'https://zuey.test';
const DAY = 24 * 60 * 60 * 1000;
const RATE = 26350;

type TestDb = ReturnType<typeof createTestD1>;
let d1: TestDb;
let now: number;
let emails: { to: string; subject: string }[];
let sepayTransactions: Record<string, unknown>[];
let adminKey: string;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field(v: unknown, key: string): unknown {
  return isRecord(v) ? v[key] : undefined;
}

async function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  if (input === 'https://api.resend.com/emails') {
    const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    if (isRecord(body)) emails.push({ to: Array.isArray(body.to) ? String(body.to[0]) : String(body.to), subject: String(body.subject) });
    return json({ id: `email_${emails.length}` });
  }
  if (input.startsWith('https://my.sepay.vn/userapi/transactions/list')) {
    const auth = init?.headers && !Array.isArray(init.headers) && !(init.headers instanceof Headers) ? init.headers.Authorization : undefined;
    if (auth !== 'Bearer sepay-api-token') return json({ status: 401, error: 'unauthorized' }, 401);
    return json({ status: 200, error: null, messages: { success: true }, transactions: sepayTransactions });
  }
  return json({ error: 'unexpected' }, 500);
}

const env = (overrides: Partial<RuntimeEnv> = {}): RuntimeEnv => ({
  DB: d1,
  PUBLIC_SITE_URL: ORIGIN,
  RESEND_API_KEY: 're_test',
  ADMIN_EMAILS: 'boss@example.com',
  USD_VND_RATE: String(RATE),
  SEPAY_WEBHOOK_API_KEY: 'sepay-key',
  SEPAY_BANK_ACCOUNT: '0123456789',
  SEPAY_BANK_CODE: 'MBBank',
  SEPAY_API_TOKEN: 'sepay-api-token',
  CONSULTATION_PRICE_VND: '52000000',
  ...overrides,
});

interface CtxOpts {
  env?: RuntimeEnv;
  method?: string;
  path?: string;
  body?: unknown;
  headers?: Record<string, string>;
  params?: Record<string, string>;
}

function ctx(opts: CtxOpts): APIContext {
  const headers = new Headers(opts.headers ?? {});
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json');
  const request = new Request(`${ORIGIN}${opts.path ?? '/api/test'}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  // Handlers only read request/params/locals; a full APIContext is not constructible in tests.
  const partial = { request, params: opts.params ?? {}, url: new URL(request.url), locals: { runtime: { env: opts.env ?? env() } } };
  return partial as unknown as APIContext;
}

async function read(res: Response): Promise<{ data: unknown; code: string | null }> {
  const body: unknown = await res.json();
  return { data: field(body, 'data'), code: isRecord(body) && isRecord(body.error) ? String(body.error.code) : null };
}

interface Member { userId: string; cookie: string; browser: Record<string, string> }

async function member(email: string): Promise<Member> {
  const { user } = await findOrCreateVerifiedUser(d1, { email });
  const { token } = await createMemberSession(d1, user.id);
  const cookie = `zuey_member=${token}`;
  return { userId: user.id, cookie, browser: { cookie, Origin: ORIGIN } };
}

async function order(m: Member, plan: string, months = 1, e: RuntimeEnv = env()): Promise<{ code: string; amount: number; status: number; error: string | null }> {
  const res = await ordersApi(ctx({ env: e, method: 'POST', body: { plan, months }, headers: m.browser }));
  const body = await read(res);
  return { code: String(field(body.data, 'code') ?? ''), amount: Number(field(body.data, 'amount_vnd') ?? 0), status: res.status, error: body.code };
}

/** SePay bank time (`YYYY-MM-DD HH:mm:ss`, Vietnam time) for an epoch-ms instant. */
function sepayTime(ms: number): string {
  return new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

let txId = 5000;
function transfer(content: string, amount: number, id = ++txId) {
  return { id, gateway: 'MBBank', transactionDate: sepayTime(now), accountNumber: '0123456789', content, transferType: 'in', transferAmount: amount, referenceCode: `FT${id}` };
}

async function webhook(payload: Record<string, unknown>, e: RuntimeEnv = env()): Promise<{ status: number; outcome: unknown }> {
  const res = await sepayWebhook(ctx({ env: e, method: 'POST', body: payload, headers: { Authorization: 'Apikey sepay-key' } }));
  return { status: res.status, outcome: field((await read(res)).data, 'outcome') };
}

async function pay(m: Member, plan: string, months = 1): Promise<void> {
  const o = await order(m, plan, months);
  expect(o.status).toBe(201);
  expect((await webhook(transfer(`thanh toan ${o.code}`, o.amount))).outcome).toBe('paid');
}

async function subscription(m: Member): Promise<{ active_plans: unknown; entitlements: unknown; subscriptions: unknown }> {
  const { data } = await read(await subscriptionApi(ctx({ headers: { cookie: m.cookie } })));
  return { active_plans: field(data, 'active_plans'), entitlements: field(data, 'entitlements'), subscriptions: field(data, 'subscriptions') };
}

function periodEnd(subs: unknown, plan: string): string | null {
  if (!Array.isArray(subs)) return null;
  const s = subs.find(x => field(x, 'plan') === plan);
  const end = field(s, 'current_period_end');
  return typeof end === 'string' ? end : null;
}

beforeEach(async () => {
  d1 = createTestD1();
  now = T0;
  emails = [];
  sepayTransactions = [];
  membersRuntime.now = () => now;
  membersRuntime.fetch = fakeFetch;
  bookingRuntime.now = () => now;
  bookingRuntime.fetch = fakeFetch;
  adminKey = (await createApiKey('ops', 'admin', d1)).key;
});

describe('plans and pricing', () => {
  it('converts USD to VND per month, rounded up to 1,000, with 5/10/20% off 3/6/12-month prepayments', async () => {
    expect(monthlyVnd(900, 26350)).toBe(238000); // 237,150 → 238,000
    expect(monthlyVnd(1900, 26000)).toBe(494000);
    const res = await plansApi(ctx({}));
    expect(res.status).toBe(200);
    const plans = field((await read(res)).data, 'plans');
    const combo = Array.isArray(plans) ? plans.find(p => field(p, 'id') === 'combo') : null;
    expect(field(combo, 'price_usd_cents')).toBe(1900);
    const prices = field(combo, 'prices');
    const twelve = Array.isArray(prices) ? prices.find(p => field(p, 'months') === 12) : null;
    // 501,000 × 12 = 6,012,000; −20% = 4,809,600 → rounded up to 4,810,000.
    expect(field(twelve, 'amount_vnd')).toBe(4_810_000);
    expect(field(twelve, 'discount_percent')).toBe(20);
    expect(field(twelve, 'amount_usd_cents')).toBe(18240);
    const one = Array.isArray(prices) ? prices.find(p => field(p, 'months') === 1) : null;
    expect(field(one, 'amount_vnd')).toBe(501_000);
    expect(field(one, 'discount_percent')).toBe(0);
    expect(prepayVnd(900, 6, RATE)).toBe(1_286_000); // 238,000 × 6 = 1,428,000; −10% = 1,285,200
  });

  it('returns 503 billing_unconfigured when the rate or bank settings are missing', async () => {
    const m = await member('lan@example.com');
    const noRate = await order(m, 'knowledges', 1, env({ USD_VND_RATE: undefined }));
    expect(noRate.status).toBe(503);
    expect(noRate.error).toBe('billing_unconfigured');
    const noBank = await order(m, 'knowledges', 1, env({ SEPAY_BANK_ACCOUNT: undefined }));
    expect(noBank.status).toBe(503);
    const catalog = (await read(await plansApi(ctx({ env: env({ USD_VND_RATE: 'abc' }) })))).data;
    expect(field(catalog, 'billing_configured')).toBe(false);
    expect(JSON.stringify(field(catalog, 'missing'))).toContain('USD_VND_RATE');
  });

  it('validates plan and months and caps pending orders', async () => {
    const m = await member('lan@example.com');
    expect((await order(m, 'gold')).status).toBe(400);
    expect((await order(m, 'knowledges', 2)).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await order(m, 'ai')).status).toBe(201);
    const capped = await order(m, 'ai');
    expect(capped.status).toBe(429);
    expect(capped.error).toBe('too_many_pending_orders');
    expect((await ordersApi(ctx({ method: 'POST', body: { plan: 'ai' } }))).status).toBe(401);
  });
});

describe('order → SePay webhook → entitlement', () => {
  it('activates the plan, emails a receipt, and ignores webhook replays', async () => {
    const m = await member('lan@example.com');
    const o = await order(m, 'knowledges', 3);
    expect(o.code).toMatch(/^ZSB[A-Z0-9]{8}$/);
    expect(o.amount).toBe(prepayVnd(900, 3, RATE)); // 714,000 − 5% = 678,300 → 679,000
    expect(o.amount).toBe(679_000);
    const view = (await read(await orderApi(ctx({ params: { code: o.code }, headers: { cookie: m.cookie } })))).data;
    expect(field(field(view, 'transfer'), 'transfer_content')).toBe(o.code);
    expect(String(field(field(view, 'transfer'), 'qr_url'))).toContain(`des=${o.code}`);

    const payload = transfer(`CK ${o.code.toLowerCase()} zuey`, o.amount);
    expect(await webhook(payload)).toEqual({ status: 200, outcome: 'paid' });
    const sub = await subscription(m);
    expect(sub.entitlements).toEqual(['read_full']);
    expect(periodEnd(sub.subscriptions, 'knowledges')).toBe(new Date(addMonths(T0, 3)).toISOString());
    expect(emails.filter(e => e.to === 'lan@example.com')).toHaveLength(1);

    expect((await webhook(payload)).outcome).toBe('duplicate_event');
    expect(periodEnd((await subscription(m)).subscriptions, 'knowledges')).toBe(new Date(addMonths(T0, 3)).toISOString());
    expect(emails).toHaveLength(1);
    const paid = (await read(await orderApi(ctx({ params: { code: o.code }, headers: { cookie: m.cookie } })))).data;
    expect(field(paid, 'status')).toBe('paid');
    expect(field(paid, 'transfer')).toBeNull();
  });

  it('extends from the current end when renewing early, and from now after expiry', async () => {
    let m = await member('lan@example.com');
    await pay(m, 'combo', 1);
    now = T0 + 10 * DAY;
    await pay(m, 'combo', 3);
    const firstEnd = addMonths(T0, 1);
    expect(periodEnd((await subscription(m)).subscriptions, 'combo')).toBe(new Date(addMonths(firstEnd, 3)).toISOString());

    now = addMonths(firstEnd, 3) + 5 * DAY; // lapsed (and the idle browser session expired too)
    m = await member('lan@example.com');
    expect((await subscription(m)).entitlements).toEqual([]);
    const renewedAt = now;
    await pay(m, 'combo', 1);
    expect(periodEnd((await subscription(m)).subscriptions, 'combo')).toBe(new Date(addMonths(renewedAt, 1)).toISOString());
  });

  it('flags underpaid and late transfers for attention without granting access', async () => {
    const m = await member('lan@example.com');
    const under = await order(m, 'knowledges');
    expect((await webhook(transfer(under.code, under.amount - 1000))).outcome).toBe('needs_attention');
    const underView = (await read(await orderApi(ctx({ params: { code: under.code }, headers: { cookie: m.cookie } })))).data;
    expect(field(underView, 'status')).toBe('needs_attention');
    expect(field(underView, 'attention_reason')).toBe('underpaid');

    const late = await order(m, 'ai');
    now += 61 * 60 * 1000;
    expect((await webhook(transfer(late.code, late.amount))).outcome).toBe('needs_attention');
    const lateView = (await read(await orderApi(ctx({ params: { code: late.code }, headers: { cookie: m.cookie } })))).data;
    expect(field(lateView, 'attention_reason')).toBe('late_payment');
    expect((await subscription(m)).entitlements).toEqual([]);

    expect((await webhook(transfer('ZSBNOTEXIST', 100000))).outcome).toBe('unmatched');
  });

  it('pays an order the bank booked in time even when the webhook arrives after the deadline', async () => {
    const m = await member('truong@example.com');
    const placed = await order(m, 'knowledges');
    const bookedAt = now + 60 * 1000;
    now += 2 * 60 * 60 * 1000; // SePay retried for two hours; the order has expired by the clock
    const view = (await read(await orderApi(ctx({ params: { code: placed.code }, headers: { cookie: m.cookie } })))).data;
    expect(field(view, 'status')).toBe('expired');
    const late = { ...transfer(placed.code, placed.amount), transactionDate: sepayTime(bookedAt) };
    expect((await webhook(late)).outcome).toBe('paid');
    expect((await subscription(m)).entitlements).toContain('read_full');

    // A bank time after the deadline is still late.
    const third = await order(m, 'combo');
    const deadline = now + 60 * 60 * 1000;
    now += 3 * 60 * 60 * 1000;
    const tooLate = { ...transfer(third.code, third.amount), transactionDate: sepayTime(deadline + 60 * 1000) };
    expect((await webhook(tooLate)).outcome).toBe('needs_attention');
  });

  it('still confirms consultation bookings (ZBK) through the same webhook', async () => {
    const rules = [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start_time: '09:00', end_time: '12:00', timezone: 'Asia/Ho_Chi_Minh', slot_minutes: 90 }));
    expect((await availabilityApi(ctx({ method: 'PUT', body: { rules, exceptions: [] }, headers: { Authorization: `Bearer ${adminKey}` } }))).status).toBe(200);
    const bookingEnv = env({ RESEND_API_KEY: undefined });
    const held = await holdApi(ctx({
      env: bookingEnv, method: 'POST',
      body: { slot_start: '2026-10-08T03:30:00.000Z', name: 'Lan', email: 'lan@example.com', timezone: 'Asia/Ho_Chi_Minh', payment_method: 'sepay' },
    }));
    expect(held.status).toBe(201);
    const heldData = (await read(held)).data;
    const booking = field(heldData, 'booking');
    const id = String(field(booking, 'id'));
    const code = String(field(booking, 'code'));
    await bookingCheckoutApi(ctx({ env: bookingEnv, method: 'POST', body: { token: field(heldData, 'manage_token') }, params: { id } }));
    expect((await webhook(transfer(`ZBK${code}`, 52000000), bookingEnv)).outcome).toBe('confirmed');
    expect((await getBookingRow(d1, id))?.status).toBe('confirmed');
  });

  it('fulfils payment even when email is unconfigured and records the skipped receipt', async () => {
    const m = await member('lan@example.com');
    const e = env({ RESEND_API_KEY: undefined });
    const o = await order(m, 'ai', 1, e);
    expect((await webhook(transfer(o.code, o.amount), e)).outcome).toBe('paid');
    expect((await subscription(m)).entitlements).toEqual(['ai_chat']);
    expect(emails).toHaveLength(0);
    expect(d1.raw.query("SELECT status FROM email_log WHERE kind = 'payment_receipt'").get()).toEqual({ status: 'skipped' });
  });

  it('keeps orders private to their owner', async () => {
    const a = await member('a@example.com');
    const b = await member('b@example.com');
    const o = await order(a, 'knowledges');
    expect((await orderApi(ctx({ params: { code: o.code }, headers: { cookie: b.cookie } }))).status).toBe(404);
    const bList = (await read(await ordersListApi(ctx({ headers: { cookie: b.cookie } })))).data;
    expect(Array.isArray(bList) && bList.length).toBe(0);
    const admin = await orderApi(ctx({ params: { code: o.code }, headers: { Authorization: `Bearer ${adminKey}` } }));
    expect(admin.status).toBe(200);
  });
});

describe('reconciliation and reminders', () => {
  it('reconciles SePay transactions idempotently with the webhook', async () => {
    const missing = await reconcileApi(ctx({ env: env({ SEPAY_API_TOKEN: undefined }), method: 'POST', headers: { Authorization: `Bearer ${adminKey}` } }));
    expect(missing.status).toBe(503);
    expect((await read(missing)).code).toBe('reconcile_unconfigured');

    const m = await member('lan@example.com');
    expect((await reconcileApi(ctx({ method: 'POST', headers: m.browser }))).status).toBe(403);

    const o = await order(m, 'community');
    sepayTransactions = [
      { id: 777, amount_in: String(o.amount), amount_out: '0', transaction_content: `MBVCB ${o.code} CK`, reference_number: 'FT777' },
      { id: 778, amount_in: '50000', amount_out: '0', transaction_content: 'tien an trua', reference_number: 'FT778' },
    ];
    const res = await reconcileApi(ctx({ method: 'POST', headers: { Authorization: `Bearer ${adminKey}` } }));
    expect(res.status).toBe(200);
    const data = (await read(res)).data;
    expect(field(data, 'matched')).toBe(1);
    expect((await subscription(m)).entitlements).toEqual(['read_full', 'ai_chat', 'community']);

    // The webhook for the same SePay transaction arrives late: no double extension.
    expect((await webhook(transfer(o.code, o.amount, 777))).outcome).toBe('duplicate_event');
    const again = (await read(await reconcileApi(ctx({ method: 'POST', headers: { Authorization: `Bearer ${adminKey}` } })))).data;
    expect(JSON.stringify(field(again, 'results'))).toContain('duplicate_event');
  });

  it('sends one renewal reminder per period and requires email', async () => {
    const m = await member('lan@example.com');
    await pay(m, 'knowledges', 1);
    emails = [];
    const noEmail = await remindersApi(ctx({ env: env({ RESEND_API_KEY: undefined }), method: 'POST', headers: { Authorization: `Bearer ${adminKey}` } }));
    expect(noEmail.status).toBe(503);

    now = addMonths(T0, 1) - 3 * DAY;
    const first = (await read(await remindersApi(ctx({ method: 'POST', headers: { Authorization: `Bearer ${adminKey}` } })))).data;
    expect(field(first, 'sent')).toBe(1);
    const second = (await read(await remindersApi(ctx({ method: 'POST', headers: { Authorization: `Bearer ${adminKey}` } })))).data;
    expect(field(second, 'sent')).toBe(0);
    expect(field(second, 'duplicate')).toBe(1);
    expect(emails).toHaveLength(1);
  });
});

describe('paywall matrix', () => {
  const SECRET = 'PAID_ONLY_SECRET_PARAGRAPH';
  type Persona = 'anonymous' | 'knowledges' | 'ai' | 'combo' | 'admin';
  const expectFull: Record<Persona, boolean> = { anonymous: false, knowledges: true, ai: false, combo: true, admin: true };

  async function publishPaidArticle(): Promise<void> {
    const studio = `zuey_session=${await createSession('owner@zuey.me', d1)}`;
    const blocks = [
      { type: 'paragraph', text: 'Free intro paragraph one with enough text to count, plus a longer lead-in sentence.' },
      { type: 'paragraph', text: 'Free intro paragraph two with enough text to count, plus a longer lead-in sentence.' },
      ...[1, 2, 3, 4].map(i => ({ type: 'paragraph', text: `${SECRET} ${i} paid paragraph with enough text to count.` })),
    ];
    const created = await createArticleApi(ctx({ method: 'POST', headers: { cookie: studio }, body: { slug: 'deep', title: 'Deep', access: 'knowledges', document: { version: 1, blocks } } }));
    expect(created.status).toBe(201);
    const pub = await publishApi(ctx({ method: 'POST', headers: { cookie: studio }, params: { slug: 'deep' }, body: { expected_revision: 1, confirm: true } }));
    expect(pub.status).toBe(200);
  }

  async function persona(p: Persona): Promise<{ cookie: string | null; key: string | null }> {
    if (p === 'anonymous') return { cookie: null, key: null };
    const m = await member(p === 'admin' ? 'boss@example.com' : `${p}@example.com`);
    // Personal keys are never admin, so the admin persona uses the Studio admin key for MCP/REST.
    if (p === 'admin') return { cookie: m.cookie, key: adminKey };
    await pay(m, p, 1);
    const scopes: UserKeyScope[] = ['articles:read'];
    const { secret } = await createUserKey(d1, m.userId, { name: 'mcp', scopes, expires_in_days: 30 });
    return { cookie: m.cookie, key: secret };
  }

  function mcpCtx(key: string | null): McpContext {
    const request = new Request(`${ORIGIN}/api/mcp`, { method: 'POST', headers: key ? { Authorization: `Bearer ${key}` } : {} });
    const e = env();
    return {
      request, env: e, d1,
      async requireAdmin() { throw new AppError(401, 'unauthorized', 'Unauthorized'); },
      async isAdmin() { return false; },
      principal: () => resolvePrincipal(request, e),
    };
  }

  for (const p of ['anonymous', 'knowledges', 'ai', 'combo', 'admin'] as const) {
    it(`${p}: ${expectFull[p] ? 'reads the full article' : 'gets the preview'} on every surface`, async () => {
      await publishPaidArticle();
      const who = await persona(p);
      const headers: Record<string, string> = who.cookie ? { cookie: who.cookie } : {};

      // HTML page loader
      const viewer = await resolveViewer(new Request(`${ORIGIN}/articles/deep`, { headers }), d1, env());
      const view = await getArticleView(d1, 'deep', viewer);
      expect(JSON.stringify(view?.document).includes(SECRET)).toBe(expectFull[p]);
      expect(view?.truncated).toBe(!expectFull[p]);

      // Markdown
      const md = await articleMdApi(ctx({ path: '/articles/deep.md', params: { slug: 'deep' }, headers }));
      expect((await md.text()).includes(SECRET)).toBe(expectFull[p]);
      expect(md.headers.get('Cache-Control')).toBe(p === 'anonymous' ? 'public, max-age=300' : 'private, no-store');

      // REST (session cookie, and personal key)
      const rest = await articleApi(ctx({ path: '/api/v1/articles/deep', params: { slug: 'deep' }, headers }));
      expect(JSON.stringify(await rest.json()).includes(SECRET)).toBe(expectFull[p]);
      if (who.key) {
        const restKey = await articleApi(ctx({ params: { slug: 'deep' }, headers: { Authorization: `Bearer ${who.key}` } }));
        expect(JSON.stringify(await restKey.json()).includes(SECRET)).toBe(expectFull[p]);
      }

      // MCP (personal key)
      const mcp = await articlesMcpModule.call('article_get', { slug: 'deep' }, mcpCtx(who.key));
      expect(JSON.stringify(mcp).includes(SECRET)).toBe(expectFull[p]);
    });
  }

  it('limits keys by scope and rejects revoked keys on article reads', async () => {
    await publishPaidArticle();
    const m = await member('reader@example.com');
    await pay(m, 'knowledges', 1);
    const { secret } = await createUserKey(d1, m.userId, { name: 'billing only', scopes: ['billing:read'], expires_in_days: 30 });
    const scoped = await articleApi(ctx({ params: { slug: 'deep' }, headers: { Authorization: `Bearer ${secret}` } }));
    expect(JSON.stringify(await scoped.json()).includes(SECRET)).toBe(false);

    d1.raw.run(`UPDATE user_api_keys SET revoked_at = '2026-10-05T00:00:00.000Z'`);
    const revoked = await articleApi(ctx({ params: { slug: 'deep' }, headers: { Authorization: `Bearer ${secret}` } }));
    expect(revoked.status).toBe(401);
    const md = await articleMdApi(ctx({ path: '/articles/deep.md', params: { slug: 'deep' }, headers: { Authorization: `Bearer ${secret}` } }));
    expect(md.status).toBe(401);
    const mcp = await articlesMcpModule.call('article_get', { slug: 'deep' }, mcpCtx(secret)).then(() => null, (e: unknown) => e);
    expect(mcp instanceof AppError && mcp.status === 401).toBe(true);
  });

  it('exposes checkout through MCP for members with checkout:write', async () => {
    const m = await member('mcp@example.com');
    const { secret } = await createUserKey(d1, m.userId, { name: 'agent', scopes: ['checkout:write', 'billing:read'], expires_in_days: 30 });
    const c = mcpCtx(secret);
    const created = await membersMcpModule.call('billing_checkout_create', { plan: 'ai', months: 1 }, c);
    const code = String(field(created, 'code'));
    expect(String(field(created, 'status_url'))).toBe(`${ORIGIN}/billing/${code}`);
    const fetched = await membersMcpModule.call('billing_order_get', { code }, c);
    expect(field(fetched, 'status')).toBe('pending');
    const denied = await membersMcpModule.call('me_get', {}, c).then(() => null, (e: unknown) => e);
    expect(denied instanceof AppError && denied.code === 'insufficient_scope').toBe(true);
  });
});

describe('new-order Telegram and Discord notices', () => {
  const DISCORD_URL = 'https://discord.com/api/webhooks/1/test-token';
  const notifyEnv = (): RuntimeEnv => env({ TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_GROUP_ID_SEPAY_NOTI: '-1009', DISCORD_WEBHOOK_SEPAY_NOTI: DISCORD_URL });
  let telegram: { url: string; chatId: unknown; text: string }[];
  let discord: { content: string; allowedMentions: unknown }[];
  let channelsUp: boolean;
  const originalFetch = experienceRuntime.fetch;

  beforeEach(() => {
    telegram = [];
    discord = [];
    channelsUp = true;
    experienceRuntime.fetch = async (input, init) => {
      const url = String(input);
      const isTelegram = url.startsWith('https://api.telegram.org/');
      if (!isTelegram && url !== DISCORD_URL) return originalFetch(input, init);
      if (!channelsUp) throw new Error('offline');
      const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      if (isTelegram) telegram.push({ url, chatId: field(body, 'chat_id'), text: String(field(body, 'text')) });
      else discord.push({ content: String(field(body, 'content')), allowedMentions: field(body, 'allowed_mentions') });
      return isTelegram ? json({ ok: true, result: {} }) : new Response(null, { status: 204 });
    };
  });

  it('announces a paid order and a transfer needing attention, but not unmatched or duplicate transfers', async () => {
    try {
      const m = await member('buyer@example.com');
      const o = await order(m, 'knowledges', 1, notifyEnv());
      const paid = transfer(`thanh toan ${o.code}`, o.amount);
      expect((await webhook(paid, notifyEnv())).outcome).toBe('paid');
      expect(telegram).toHaveLength(1);
      expect(telegram[0].url).toBe('https://api.telegram.org/botbot-token/sendMessage');
      expect(telegram[0].chatId).toBe('-1009');
      expect(telegram[0].text).toContain('Đơn hàng mới đã thanh toán');
      expect(telegram[0].text).toContain(o.code);
      expect(telegram[0].text).toContain('Gói thành viên');
      expect(discord).toHaveLength(1);
      expect(discord[0].content).toBe(telegram[0].text);
      expect(discord[0].allowedMentions).toEqual({ parse: [] });

      expect((await webhook(paid, notifyEnv())).outcome).toBe('duplicate_event');
      expect((await webhook(transfer('ZSBNOPE00', 1000), notifyEnv())).outcome).toBe('ignored');
      expect(telegram).toHaveLength(1);
      expect(discord).toHaveLength(1);

      const short = await order(m, 'knowledges', 3, notifyEnv());
      expect((await webhook(transfer(`ck ${short.code}`, short.amount - 1000), notifyEnv())).outcome).toBe('needs_attention');
      expect(telegram).toHaveLength(2);
      expect(telegram[1].text).toContain('cần kiểm tra');
      expect(discord).toHaveLength(2);
    } finally {
      experienceRuntime.fetch = originalFetch;
    }
  });

  it('keeps the payment when the channels are down or not configured', async () => {
    try {
      channelsUp = false;
      const m = await member('buyer2@example.com');
      const o = await order(m, 'knowledges', 1, notifyEnv());
      expect((await webhook(transfer(`ck ${o.code}`, o.amount), notifyEnv())).outcome).toBe('paid');
      channelsUp = true;
      const o2 = await order(m, 'knowledges', 3);
      expect((await webhook(transfer(`ck ${o2.code}`, o2.amount))).outcome).toBe('paid');
      expect(telegram).toHaveLength(0);
      expect(discord).toHaveLength(0);
    } finally {
      experienceRuntime.fetch = originalFetch;
    }
  });
});