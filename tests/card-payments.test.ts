import { beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createApiKey } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { bookingRuntime, configuredPaymentMethods, getBookingRow } from '../src/lib/booking/store';
import { membersRuntime } from '../src/lib/members/runtime';
import { createMemberSession } from '../src/lib/members/session';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { signDodoPayload, verifyDodoSignature } from '../src/lib/payments/dodo';
import { resetPaypalTokenCache } from '../src/lib/payments/paypal';
import { PUT as putAvailabilityApi } from '../src/pages/api/v1/booking/availability';
import { POST as holdApi } from '../src/pages/api/v1/booking/hold';
import { POST as checkoutApi } from '../src/pages/api/v1/booking/[id]/checkout';
import { POST as captureApi } from '../src/pages/api/v1/booking/[id]/capture';
import { GET as plansApi } from '../src/pages/api/v1/plans';
import { POST as ordersApi } from '../src/pages/api/v1/billing/orders/index';
import { GET as subscriptionApi } from '../src/pages/api/v1/billing/subscription';
import { GET as cardApi } from '../src/pages/api/v1/billing/card/[id]/index';
import { POST as cardPortalApi } from '../src/pages/api/v1/billing/card/[id]/portal';
import { POST as cardCancelApi } from '../src/pages/api/v1/billing/card/[id]/cancel';
import { POST as dodoWebhook } from '../src/pages/api/webhooks/dodo';
import { POST as paypalWebhook } from '../src/pages/api/webhooks/paypal';

const ORIGIN = 'https://zuey.test';
const HCM = 'Asia/Ho_Chi_Minh';
// Monday 2026-10-05 00:00 UTC (07:00 in Ho Chi Minh City).
const T0 = Date.parse('2026-10-05T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const SLOT = '2026-10-07T02:00:00.000Z';
const DODO_SECRET = `whsec_${btoa('zuey-dodo-test-secret')}`;
const DODO_BASE = 'https://test.dodopayments.com';
const PAYPAL_BASE = 'https://api-m.sandbox.paypal.com';

type TestDb = ReturnType<typeof createTestD1>;
let d1: TestDb;
let now: number;
let adminKey: string;

interface Call { url: string; method: string; headers: Record<string, string>; body: string }
let calls: Call[];
let verifyStatus: string;
let captureResponse: { status: number; body: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field(v: unknown, key: string): unknown {
  return isRecord(v) ? v[key] : undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function headerRecord(h: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((value, key) => { out[key] = value; });
  return out;
}

function parsed(body: string): unknown {
  return body ? JSON.parse(body) : null;
}

function captureBody(opts: { captureId?: string; status?: string; value?: string; currency?: string } = {}): Record<string, unknown> {
  return {
    id: 'ORDER-1',
    status: 'COMPLETED',
    purchase_units: [{
      reference_id: 'ZBK',
      custom_id: currentBookingId,
      payments: {
        captures: [{
          id: opts.captureId ?? 'CAPTURE-1', status: opts.status ?? 'COMPLETED',
          amount: { currency_code: opts.currency ?? 'USD', value: opts.value ?? '1999.00' }, custom_id: currentBookingId,
        }],
      },
    }],
  };
}

let currentBookingId = '';

/** Mocked provider APIs. No request leaves the process; unknown URLs fail loudly. */
async function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  const call: Call = { url: input, method: init?.method ?? 'GET', headers: headerRecord(init?.headers), body: typeof init?.body === 'string' ? init.body : '' };
  calls.push(call);
  // Dodo Payments
  if (input === `${DODO_BASE}/checkouts`) return json({ session_id: `cks_${calls.length}`, checkout_url: `https://test.checkout.dodopayments.com/session/cks_${calls.length}` });
  if (input.startsWith(`${DODO_BASE}/customers/`) && input.endsWith('/customer-portal/session')) return json({ link: 'https://customer.dodopayments.com/portal/abc' });
  if (input.startsWith(`${DODO_BASE}/subscriptions/`) && call.method === 'PATCH') {
    return json({ subscription_id: 'sub_1', status: 'active', product_id: 'pdt_combo', recurring_pre_tax_amount: 1900, currency: 'USD', next_billing_date: '2026-12-05T00:00:00Z', cancel_at_next_billing_date: true, customer: { customer_id: 'cus_1', email: 'lan@example.com' } });
  }
  // PayPal
  if (input === `${PAYPAL_BASE}/v1/oauth2/token`) return json({ access_token: 'pp_access', token_type: 'Bearer', expires_in: 32400 });
  if (input === `${PAYPAL_BASE}/v2/checkout/orders` && call.method === 'POST') {
    return json({ id: 'ORDER-1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'self', href: `${PAYPAL_BASE}/v2/checkout/orders/ORDER-1` }, { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1' }] }, 200);
  }
  if (input === `${PAYPAL_BASE}/v2/checkout/orders/ORDER-1/capture`) return json(captureResponse.body, captureResponse.status);
  if (input === `${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`) return json({ verification_status: verifyStatus });
  // Booking fulfilment side effects (email); calendar is not configured in these tests.
  if (input === 'https://api.resend.com/emails') return json({ id: 'email_1' });
  return json({ error: `unexpected ${input}` }, 500);
}

const dodoEnv: Partial<RuntimeEnv> = {
  DODO_API_KEY: 'dodo_test_key',
  DODO_WEBHOOK_SECRET: DODO_SECRET,
  DODO_API_BASE: DODO_BASE,
  DODO_PRODUCT_KNOWLEDGES: 'pdt_knowledges',
  DODO_PRODUCT_AI: 'pdt_ai',
  DODO_PRODUCT_COMBO: 'pdt_combo',
  DODO_PRODUCT_COMMUNITY: 'pdt_community',
};

const paypalEnv: Partial<RuntimeEnv> = {
  PAYPAL_CLIENT_ID: 'pp_client',
  PAYPAL_CLIENT_SECRET: 'pp_secret',
  PAYPAL_WEBHOOK_ID: 'WH-123',
  PAYPAL_API_BASE: PAYPAL_BASE,
};

const env = (overrides: Partial<RuntimeEnv> = {}): RuntimeEnv => ({
  DB: d1,
  PUBLIC_SITE_URL: ORIGIN,
  USD_VND_RATE: '26350',
  SEPAY_WEBHOOK_API_KEY: 'sepay-key',
  SEPAY_BANK_ACCOUNT: '0123456789',
  SEPAY_BANK_CODE: 'MBBank',
  CONSULTATION_PRICE_VND: '52000000',
  ...dodoEnv,
  ...paypalEnv,
  ...overrides,
});

interface CtxOpts {
  env?: RuntimeEnv;
  method?: string;
  path?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
}

function ctx(opts: CtxOpts): APIContext {
  const headers = new Headers(opts.headers ?? {});
  const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined && !headers.has('content-type')) headers.set('Content-Type', 'application/json');
  const request = new Request(`${ORIGIN}${opts.path ?? '/api/test'}`, { method: opts.method ?? 'GET', headers, body });
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

async function entitlements(m: Member): Promise<string[]> {
  const { data } = await read(await subscriptionApi(ctx({ headers: { cookie: m.cookie } })));
  const list = field(data, 'entitlements');
  return Array.isArray(list) ? list.map(String) : [];
}

async function cardOf(m: Member, id: string): Promise<unknown> {
  return (await read(await cardApi(ctx({ params: { id }, headers: { cookie: m.cookie } })))).data;
}

/** Starts a Dodo checkout and returns the pending card id plus the metadata Dodo will echo back. */
async function startCard(m: Member, plan: string): Promise<{ id: string; metadata: Record<string, unknown> }> {
  const res = await ordersApi(ctx({ method: 'POST', body: { plan, provider: 'dodo' }, headers: m.browser }));
  const { data } = await read(res);
  expect(res.status).toBe(201);
  const checkout = calls.filter(c => c.url === `${DODO_BASE}/checkouts`).at(-1);
  const payload = parsed(checkout?.body ?? '');
  const metadata = field(payload, 'metadata');
  if (!isRecord(metadata)) throw new Error('checkout metadata missing');
  return { id: String(field(data, 'id')), metadata };
}

interface SubOpts {
  subscriptionId?: string;
  status?: string;
  productId?: string;
  amount?: number;
  currency?: string;
  next?: string;
  cancel?: boolean;
  metadata?: Record<string, unknown>;
}

function subscriptionPayload(type: string, o: SubOpts): string {
  return JSON.stringify({
    business_id: 'bus_test',
    type,
    timestamp: new Date(now).toISOString(),
    data: {
      payload_type: 'Subscription',
      subscription_id: o.subscriptionId ?? 'sub_1',
      status: o.status ?? 'active',
      product_id: o.productId ?? 'pdt_combo',
      recurring_pre_tax_amount: o.amount ?? 1900,
      currency: o.currency ?? 'USD',
      next_billing_date: o.next ?? new Date(now + 30 * DAY).toISOString(),
      cancel_at_next_billing_date: o.cancel ?? false,
      customer: { customer_id: 'cus_1', email: 'lan@example.com', name: 'Lan' },
      metadata: o.metadata ?? {},
    },
  });
}

let webhookSeq = 0;

async function sendDodo(body: string, opts: { id?: string; tsMs?: number; badSignature?: boolean } = {}, e: RuntimeEnv = env()): Promise<{ status: number; outcome: unknown; code: string | null }> {
  const id = opts.id ?? `msg_${++webhookSeq}`;
  const ts = String(Math.floor((opts.tsMs ?? now) / 1000));
  const signature = opts.badSignature ? 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' : await signDodoPayload(DODO_SECRET, id, ts, body);
  const res = await dodoWebhook(ctx({ env: e, method: 'POST', rawBody: body, headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signature } }));
  const r = await read(res);
  return { status: res.status, outcome: field(r.data, 'outcome'), code: r.code };
}

async function cardRow(id: string): Promise<Record<string, unknown>> {
  const row = await d1.prepare('SELECT * FROM card_subscriptions WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!row) throw new Error('card row missing');
  return row;
}

// ---------------------------------------------------------------------------
// PayPal helpers
// ---------------------------------------------------------------------------

async function paypalHold(e: RuntimeEnv = env()): Promise<{ id: string; token: string }> {
  const res = await holdApi(ctx({
    env: e, method: 'POST',
    body: { slot_start: SLOT, name: 'Lan Nguyễn', email: 'lan@example.com', company: 'Acme', timezone: 'Europe/Berlin', payment_method: 'paypal' },
  }));
  const { data } = await read(res);
  expect(res.status).toBe(201);
  const id = String(field(field(data, 'booking'), 'id'));
  currentBookingId = id;
  return { id, token: String(field(data, 'manage_token')) };
}

async function paypalCheckout(b: { id: string; token: string }): Promise<unknown> {
  const res = await checkoutApi(ctx({ method: 'POST', body: { token: b.token }, params: { id: b.id } }));
  expect(res.status).toBe(200);
  return (await read(res)).data;
}

function paypalEvent(opts: { eventId?: string; captureId?: string; value?: string; currency?: string; customId?: string; type?: string }): string {
  return JSON.stringify({
    id: opts.eventId ?? `WH-EVT-${++webhookSeq}`,
    event_type: opts.type ?? 'PAYMENT.CAPTURE.COMPLETED',
    resource_type: 'capture',
    resource: {
      id: opts.captureId ?? 'CAPTURE-1',
      status: 'COMPLETED',
      amount: { currency_code: opts.currency ?? 'USD', value: opts.value ?? '1999.00' },
      custom_id: opts.customId ?? currentBookingId,
      supplementary_data: { related_ids: { order_id: 'ORDER-1' } },
    },
  });
}

const PAYPAL_HEADERS = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
  'paypal-transmission-id': 'tx-1',
  'paypal-transmission-sig': 'sig-abc',
  'paypal-transmission-time': '2026-10-05T00:05:00Z',
};

async function sendPaypal(body: string, e: RuntimeEnv = env()): Promise<{ status: number; outcome: unknown; code: string | null }> {
  const res = await paypalWebhook(ctx({ env: e, method: 'POST', rawBody: body, headers: PAYPAL_HEADERS }));
  const r = await read(res);
  return { status: res.status, outcome: field(r.data, 'outcome'), code: r.code };
}

async function bookingStatus(id: string): Promise<string | undefined> {
  return (await getBookingRow(d1, id))?.status;
}

beforeEach(async () => {
  d1 = createTestD1();
  now = T0;
  calls = [];
  verifyStatus = 'SUCCESS';
  currentBookingId = '';
  captureResponse = { status: 201, body: {} };
  membersRuntime.now = () => now;
  membersRuntime.fetch = fakeFetch;
  bookingRuntime.now = () => now;
  bookingRuntime.fetch = fakeFetch;
  resetPaypalTokenCache();
  adminKey = (await createApiKey('ops', 'admin', d1)).key;
  const rules = [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start_time: '09:00', end_time: '12:00', timezone: HCM, slot_minutes: 90 }));
  const res = await putAvailabilityApi(ctx({ env: { DB: d1 }, method: 'PUT', body: { rules, exceptions: [] }, headers: { Authorization: `Bearer ${adminKey}` } }));
  expect(res.status).toBe(200);
});

// ---------------------------------------------------------------------------
// Dodo Payments (membership card subscriptions)
// ---------------------------------------------------------------------------

describe('Dodo webhook signatures', () => {
  it('accepts a valid Standard Webhooks signature and rejects invalid, tampered and replayed deliveries', async () => {
    const body = subscriptionPayload('subscription.active', { subscriptionId: 'sub_unknown', metadata: {} });
    const ts = String(Math.floor(now / 1000));
    const sig = await signDodoPayload(DODO_SECRET, 'msg_a', ts, body);
    const headers = { id: 'msg_a', timestamp: ts, signature: sig };
    expect(await verifyDodoSignature(DODO_SECRET, headers, body, now)).toBe(true);
    expect(await verifyDodoSignature(DODO_SECRET, headers, body.replace('sub_unknown', 'sub_other'), now)).toBe(false);
    expect(await verifyDodoSignature(`whsec_${btoa('another-secret')}`, headers, body, now)).toBe(false);
    // Outside the 5-minute window.
    expect(await verifyDodoSignature(DODO_SECRET, headers, body, now + 6 * 60 * 1000)).toBe(false);

    const bad = await sendDodo(body, { badSignature: true });
    expect(bad.status).toBe(401);
    expect(bad.code).toBe('invalid_signature');
    const stale = await sendDodo(body, { tsMs: now - 10 * 60 * 1000 });
    expect(stale.status).toBe(401);

    const first = await sendDodo(body, { id: 'msg_replay' });
    expect(first.status).toBe(200);
    const replay = await sendDodo(body, { id: 'msg_replay' });
    expect(replay.status).toBe(200);
    expect(replay.outcome).toBe('duplicate_event');
  });
});

describe('Dodo card subscription lifecycle', () => {
  it('creates a checkout with member metadata, activates on a verified webhook and ends on cancellation', async () => {
    let m = await member('lan@example.com');
    const { id, metadata } = await startCard(m, 'combo');
    expect(metadata).toEqual({ user_id: m.userId, plan: 'combo', card_ref: id });
    const checkout = calls.find(c => c.url === `${DODO_BASE}/checkouts`);
    expect(checkout?.headers.authorization).toBe('Bearer dodo_test_key');
    const payload = parsed(checkout?.body ?? '');
    expect(field(field(payload, 'customer'), 'email')).toBe('lan@example.com');
    expect(field(payload, 'product_cart')).toEqual([{ product_id: 'pdt_combo', quantity: 1 }]);
    expect(field(payload, 'return_url')).toBe(`${ORIGIN}/billing/card/${id}`);

    // The redirect alone grants nothing: still pending until Dodo confirms.
    expect(field(await cardOf(m, id), 'status')).toBe('pending');
    expect(await entitlements(m)).toEqual([]);

    const firstEnd = '2026-11-05T00:00:00.000Z';
    const active = await sendDodo(subscriptionPayload('subscription.active', { metadata, next: firstEnd }));
    expect(active.outcome).toBe('activated');
    const view = await cardOf(m, id);
    expect(field(view, 'status')).toBe('active');
    expect(field(view, 'current_period_end')).toBe(firstEnd);
    expect(field(view, 'can_cancel')).toBe(true);
    expect((await entitlements(m)).sort()).toEqual(['ai_chat', 'read_full']);

    // A second card checkout for the same plan is refused while one is live.
    const again = await ordersApi(ctx({ method: 'POST', body: { plan: 'combo', provider: 'dodo' }, headers: m.browser }));
    expect(again.status).toBe(409);
    expect((await read(again)).code).toBe('already_subscribed');

    // Renewal moves the period end to the provider's next billing date.
    now = Date.parse('2026-11-05T00:10:00.000Z');
    const renewedEnd = '2026-12-05T00:00:00.000Z';
    m = await member('lan@example.com'); // fresh session after the month jump
    expect((await sendDodo(subscriptionPayload('subscription.renewed', { metadata, next: renewedEnd }))).outcome).toBe('updated');
    expect(field(await cardOf(m, id), 'current_period_end')).toBe(renewedEnd);
    expect((await entitlements(m)).sort()).toEqual(['ai_chat', 'read_full']);

    // Portal link and scheduled cancellation (session only).
    const portal = await cardPortalApi(ctx({ method: 'POST', params: { id }, headers: m.browser }));
    expect(portal.status).toBe(200);
    expect(field((await read(portal)).data, 'url')).toBe('https://customer.dodopayments.com/portal/abc');
    const cancel = await cardCancelApi(ctx({ method: 'POST', params: { id }, headers: m.browser }));
    expect(cancel.status).toBe(200);
    expect(field((await read(cancel)).data, 'cancel_at_period_end')).toBe(true);
    const patch = calls.find(c => c.method === 'PATCH');
    expect(patch?.url).toBe(`${DODO_BASE}/subscriptions/sub_1`);
    expect(parsed(patch?.body ?? '')).toEqual({ cancel_at_next_billing_date: true });
    expect((await entitlements(m)).sort()).toEqual(['ai_chat', 'read_full']);

    // The provider ends the subscription: access stops.
    now = Date.parse('2026-12-05T00:00:10.000Z');
    m = await member('lan@example.com');
    const ended = await sendDodo(subscriptionPayload('subscription.cancelled', { metadata, status: 'cancelled', next: renewedEnd, cancel: true }));
    expect(ended.outcome).toBe('deactivated');
    expect(await entitlements(m)).toEqual([]);
    expect(field(await cardOf(m, id), 'status')).toBe('cancelled');
  });

  it('turns access off when a renewal fails (on_hold) and back on when it recovers', async () => {
    const m = await member('lan@example.com');
    const { metadata } = await startCard(m, 'ai');
    const sub = { metadata, productId: 'pdt_ai', amount: 900 };
    expect((await sendDodo(subscriptionPayload('subscription.active', sub))).outcome).toBe('activated');
    expect(await entitlements(m)).toEqual(['ai_chat']);
    expect((await sendDodo(subscriptionPayload('subscription.on_hold', { ...sub, status: 'on_hold' }))).outcome).toBe('deactivated');
    expect(await entitlements(m)).toEqual([]);
    expect((await sendDodo(subscriptionPayload('subscription.active', sub))).outcome).toBe('activated');
    expect(await entitlements(m)).toEqual(['ai_chat']);
  });

  it('marks a failed first charge as failed without granting access', async () => {
    const m = await member('lan@example.com');
    const { id, metadata } = await startCard(m, 'knowledges');
    const body = JSON.stringify({
      business_id: 'bus_test', type: 'payment.failed', timestamp: new Date(now).toISOString(),
      data: { payload_type: 'Payment', payment_id: 'pay_1', subscription_id: 'sub_k', total_amount: 900, currency: 'USD', status: 'failed', customer: { customer_id: 'cus_1', email: 'lan@example.com' }, metadata },
    });
    expect((await sendDodo(body)).outcome).toBe('deactivated');
    expect(field(await cardOf(m, id), 'status')).toBe('failed');
    expect(await entitlements(m)).toEqual([]);
  });

  it('flags a wrong amount or currency as needs_attention and grants nothing', async () => {
    const m = await member('lan@example.com');
    const wrongAmount = await startCard(m, 'combo');
    expect((await sendDodo(subscriptionPayload('subscription.active', { metadata: wrongAmount.metadata, amount: 900 }))).outcome).toBe('needs_attention');
    const row = await cardRow(wrongAmount.id);
    expect(row.status).toBe('needs_attention');
    expect(row.attention_reason).toBe('amount_mismatch');
    expect(await entitlements(m)).toEqual([]);
    // A later correct event does not silently clear the flag.
    expect((await sendDodo(subscriptionPayload('subscription.renewed', { metadata: wrongAmount.metadata }))).outcome).toBe('needs_attention');
    expect(await entitlements(m)).toEqual([]);

    const other = await member('minh@example.com');
    const wrongCurrency = await startCard(other, 'community');
    const res = await sendDodo(subscriptionPayload('subscription.active', { subscriptionId: 'sub_eur', metadata: wrongCurrency.metadata, productId: 'pdt_community', amount: 2900, currency: 'EUR' }));
    expect(res.outcome).toBe('needs_attention');
    expect((await cardRow(wrongCurrency.id)).attention_reason).toBe('amount_mismatch');
    expect(await entitlements(other)).toEqual([]);

    // Product that does not belong to the plan.
    const third = await member('hoa@example.com');
    const wrongProduct = await startCard(third, 'community');
    await sendDodo(subscriptionPayload('subscription.active', { subscriptionId: 'sub_prod', metadata: wrongProduct.metadata, productId: 'pdt_ai', amount: 2900 }));
    expect((await cardRow(wrongProduct.id)).attention_reason).toBe('product_mismatch');
  });

  it('flags an underpaid payment.succeeded as needs_attention', async () => {
    const m = await member('lan@example.com');
    const { id, metadata } = await startCard(m, 'combo');
    await sendDodo(subscriptionPayload('subscription.active', { metadata }));
    const body = JSON.stringify({
      business_id: 'bus_test', type: 'payment.succeeded', timestamp: new Date(now).toISOString(),
      data: { payload_type: 'Payment', payment_id: 'pay_low', subscription_id: 'sub_1', total_amount: 500, currency: 'USD', status: 'succeeded', customer: { customer_id: 'cus_1', email: 'lan@example.com' }, metadata },
    });
    expect((await sendDodo(body)).outcome).toBe('needs_attention');
    expect((await cardRow(id)).attention_reason).toBe('amount_mismatch');
    expect(await entitlements(m)).toEqual([]);
  });

  it('records a subscription without member metadata as needs_attention and links it to nobody', async () => {
    const m = await member('lan@example.com');
    const res = await sendDodo(subscriptionPayload('subscription.active', { subscriptionId: 'sub_orphan', metadata: {} }));
    expect(res.status).toBe(200);
    expect(res.outcome).toBe('needs_attention');
    const row = await d1.prepare("SELECT * FROM card_subscriptions WHERE provider_subscription_id = 'sub_orphan'").first<Record<string, unknown>>();
    expect(row?.status).toBe('needs_attention');
    expect(row?.attention_reason).toBe('metadata_missing');
    expect(row?.user_id).toBeNull();
    expect(row?.plan).toBe('combo');
    expect(await entitlements(m)).toEqual([]);

    // Metadata pointing at someone else's pending card is refused, not applied to them.
    const owner = await member('owner@example.com');
    const card = await startCard(owner, 'ai');
    const forged = { ...card.metadata, user_id: m.userId };
    expect((await sendDodo(subscriptionPayload('subscription.active', { subscriptionId: 'sub_forged', metadata: forged, productId: 'pdt_ai', amount: 900 }))).outcome).toBe('needs_attention');
    expect(await entitlements(owner)).toEqual([]);
    expect(await entitlements(m)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PayPal (consultation booking)
// ---------------------------------------------------------------------------

describe('PayPal booking payments', () => {
  it('creates an Orders v2 order for USD 1999.00 with custom_id = booking id and manage return URLs', async () => {
    const b = await paypalHold();
    const data = await paypalCheckout(b);
    expect(field(data, 'provider')).toBe('paypal');
    expect(field(data, 'url')).toBe('https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1');
    expect(field(data, 'order_id')).toBe('ORDER-1');

    const tokenCall = calls.find(c => c.url === `${PAYPAL_BASE}/v1/oauth2/token`);
    expect(tokenCall?.headers.authorization).toBe(`Basic ${btoa('pp_client:pp_secret')}`);
    expect(tokenCall?.body).toBe('grant_type=client_credentials');
    const create = calls.find(c => c.url === `${PAYPAL_BASE}/v2/checkout/orders`);
    expect(create?.headers.authorization).toBe('Bearer pp_access');
    expect(create?.headers['paypal-request-id']).toBe(`zuey-order-${b.id}`);
    const payload = parsed(create?.body ?? '');
    expect(field(payload, 'intent')).toBe('CAPTURE');
    const unit = (field(payload, 'purchase_units') as unknown[] | undefined)?.[0];
    expect(field(unit, 'custom_id')).toBe(b.id);
    expect(field(unit, 'amount')).toEqual({ currency_code: 'USD', value: '1999.00' });
    const experience = field(field(field(payload, 'payment_source'), 'paypal'), 'experience_context');
    expect(String(field(experience, 'return_url'))).toBe(`${ORIGIN}/booking/${b.id}?manage=${encodeURIComponent(b.token)}&paypal=return`);
    expect(String(field(experience, 'cancel_url'))).toBe(`${ORIGIN}/booking/${b.id}?manage=${encodeURIComponent(b.token)}&paypal=cancel`);

    const row = await getBookingRow(d1, b.id);
    expect(row?.payment_ref).toBe('ORDER-1');
    expect(row?.amount_expected).toBe(199900);
    expect(row?.currency).toBe('USD');

    // The OAuth token is cached: a second checkout reuses it.
    await paypalCheckout(b);
    expect(calls.filter(c => c.url === `${PAYPAL_BASE}/v1/oauth2/token`).length).toBe(1);
  });

  it('captures on return, confirms the booking, and treats the matching webhook as a duplicate', async () => {
    const b = await paypalHold();
    await paypalCheckout(b);
    captureResponse = { status: 201, body: captureBody() };
    const res = await captureApi(ctx({ method: 'POST', body: { token: b.token }, params: { id: b.id } }));
    expect(res.status).toBe(200);
    const { data } = await read(res);
    expect(field(data, 'capture_status')).toBe('confirmed');
    expect(field(field(data, 'booking'), 'status')).toBe('confirmed');
    const capture = calls.find(c => c.url.endsWith('/ORDER-1/capture'));
    expect(capture?.headers['paypal-request-id']).toBe('zuey-capture-ORDER-1');

    const hook = await sendPaypal(paypalEvent({}));
    expect(hook.status).toBe(200);
    expect(hook.outcome).toBe('duplicate_event');
    expect(await bookingStatus(b.id)).toBe('confirmed');
  });

  it('reports a not-yet-approved order honestly without confirming', async () => {
    const b = await paypalHold();
    await paypalCheckout(b);
    captureResponse = { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] } };
    const { data } = await read(await captureApi(ctx({ method: 'POST', body: { token: b.token }, params: { id: b.id } })));
    expect(field(data, 'capture_status')).toBe('not_approved');
    expect(await bookingStatus(b.id)).toBe('held');
  });

  it('verifies webhooks through the PayPal API and confirms on success only', async () => {
    const b = await paypalHold();
    await paypalCheckout(b);
    const body = paypalEvent({ eventId: 'WH-EVT-OK' });

    verifyStatus = 'FAILURE';
    const rejected = await sendPaypal(body);
    expect(rejected.status).toBe(401);
    expect(rejected.code).toBe('invalid_signature');
    expect(await bookingStatus(b.id)).toBe('held');

    verifyStatus = 'SUCCESS';
    const ok = await sendPaypal(body);
    expect(ok.status).toBe(200);
    expect(ok.outcome).toBe('confirmed');
    expect(await bookingStatus(b.id)).toBe('confirmed');

    const verify = calls.filter(c => c.url.endsWith('/v1/notifications/verify-webhook-signature')).at(-1);
    const sent = parsed(verify?.body ?? '');
    expect(field(sent, 'webhook_id')).toBe('WH-123');
    expect(field(sent, 'transmission_id')).toBe('tx-1');
    expect(field(sent, 'cert_url')).toBe(PAYPAL_HEADERS['paypal-cert-url']);
    expect(field(sent, 'webhook_event')).toEqual(parsed(body));

    // Replays of the same capture are idempotent.
    const replay = await sendPaypal(paypalEvent({ eventId: 'WH-EVT-RETRY' }));
    expect(replay.outcome).toBe('duplicate_event');

    // Missing PayPal headers never reach the verify API.
    const before = calls.length;
    const unsigned = await paypalWebhook(ctx({ method: 'POST', rawBody: body }));
    expect(unsigned.status).toBe(401);
    expect(calls.length).toBe(before);
  });

  it('flags a wrong capture amount as needs_attention', async () => {
    const b = await paypalHold();
    await paypalCheckout(b);
    const res = await sendPaypal(paypalEvent({ value: '199.90' }));
    expect(res.outcome).toBe('needs_attention');
    const row = await getBookingRow(d1, b.id);
    expect(row?.status).toBe('needs_attention');
    expect(row?.attention_reason).toBe('amount_mismatch');
  });

  it('never captures an expired hold, and flags a late webhook capture as needs_attention', async () => {
    const b = await paypalHold();
    await paypalCheckout(b);
    now += 16 * 60 * 1000;
    const res = await captureApi(ctx({ method: 'POST', body: { token: b.token }, params: { id: b.id } }));
    expect(res.status).toBe(409);
    expect((await read(res)).code).toBe('hold_not_active');
    expect(calls.some(c => c.url.endsWith('/capture'))).toBe(false);

    const late = await sendPaypal(paypalEvent({ captureId: 'CAPTURE-LATE' }));
    expect(late.outcome).toBe('needs_attention');
    const row = await getBookingRow(d1, b.id);
    expect(row?.status).toBe('needs_attention');
    expect(row?.attention_reason).toBe('late_payment');
  });

  it('ignores non-capture events after verification', async () => {
    await paypalHold();
    const res = await sendPaypal(paypalEvent({ type: 'CHECKOUT.ORDER.APPROVED' }));
    expect(res.status).toBe(200);
    expect(res.outcome).toBe('ignored');
  });
});

// ---------------------------------------------------------------------------
// Unconfigured rails: honest 503 and hidden options
// ---------------------------------------------------------------------------

describe('unconfigured card rails', () => {
  const bare = (): RuntimeEnv => env({
    DODO_API_KEY: undefined, DODO_WEBHOOK_SECRET: undefined, DODO_PRODUCT_KNOWLEDGES: undefined, DODO_PRODUCT_AI: undefined,
    DODO_PRODUCT_COMBO: undefined, DODO_PRODUCT_COMMUNITY: undefined,
    PAYPAL_CLIENT_ID: undefined, PAYPAL_CLIENT_SECRET: undefined, PAYPAL_WEBHOOK_ID: undefined,
  });

  it('hides the card options and returns 503 payment_unconfigured', async () => {
    const e = bare();
    const catalog = (await read(await plansApi(ctx({ env: e })))).data;
    expect(field(catalog, 'card_plans')).toEqual([]);
    expect(configuredPaymentMethods(e)).toEqual(['sepay']);

    const m = await member('lan@example.com');
    const dodo = await ordersApi(ctx({ env: e, method: 'POST', body: { plan: 'ai', provider: 'dodo' }, headers: m.browser }));
    expect(dodo.status).toBe(503);
    const dodoBody: unknown = await dodo.json();
    expect(field(field(dodoBody, 'error'), 'code')).toBe('payment_unconfigured');
    expect(JSON.stringify(dodoBody)).toContain('DODO_API_KEY');

    const hold = await holdApi(ctx({
      env: e, method: 'POST',
      body: { slot_start: SLOT, name: 'Lan', email: 'lan@example.com', timezone: 'Europe/Berlin', payment_method: 'paypal' },
    }));
    expect(hold.status).toBe(503);
    expect((await read(hold)).code).toBe('payment_unconfigured');

    expect((await sendDodo(subscriptionPayload('subscription.active', {}), {}, e)).status).toBe(503);
    expect((await sendPaypal(paypalEvent({}), e)).status).toBe(503);
    expect(calls.length).toBe(0);
  });

  it('offers only the plans whose Dodo product is configured', async () => {
    const partial = env({ DODO_PRODUCT_AI: undefined, DODO_PRODUCT_COMMUNITY: undefined });
    expect(field((await read(await plansApi(ctx({ env: partial })))).data, 'card_plans')).toEqual(['knowledges', 'combo']);
    const m = await member('lan@example.com');
    const res = await ordersApi(ctx({ env: partial, method: 'POST', body: { plan: 'ai', provider: 'dodo' }, headers: m.browser }));
    expect(res.status).toBe(503);
    expect(configuredPaymentMethods(env())).toEqual(['sepay', 'paypal']);
  });

  it('keeps SePay as the default rail and validates the provider and months', async () => {
    const m = await member('lan@example.com');
    const sepay = await ordersApi(ctx({ method: 'POST', body: { plan: 'ai', months: 3 }, headers: m.browser }));
    expect(sepay.status).toBe(201);
    const data = (await read(sepay)).data;
    expect(field(data, 'provider')).toBe('sepay');
    expect(String(field(data, 'status_url'))).toBe(`${ORIGIN}/billing/${String(field(data, 'code'))}`);
    expect((await ordersApi(ctx({ method: 'POST', body: { plan: 'ai', provider: 'stripe' }, headers: m.browser }))).status).toBe(400);
    expect((await ordersApi(ctx({ method: 'POST', body: { plan: 'ai', provider: 'dodo', months: 3 }, headers: m.browser }))).status).toBe(400);
  });
});
