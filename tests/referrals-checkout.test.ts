import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import type { RuntimeEnv } from '../src/env';
import { bookingRuntime, setAvailability } from '../src/lib/booking/store';
import { prepayUsdCents, prepayVnd } from '../src/lib/members/plans';
import { membersRuntime } from '../src/lib/members/runtime';
import { createMemberSession } from '../src/lib/members/session';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { dodoCheckoutPayload, signDodoPayload } from '../src/lib/payments/dodo';
import { resetPaypalTokenCache } from '../src/lib/payments/paypal';
import { sepayReferralAmounts } from '../src/lib/referrals/checkout';
import { ensureReferralProfile } from '../src/lib/referrals/codes';
import { POST as holdApi } from '../src/pages/api/v1/booking/hold';
import { POST as bookingCheckoutApi } from '../src/pages/api/v1/booking/[id]/checkout';
import { POST as ordersApi } from '../src/pages/api/v1/billing/orders/index';
import { GET as quoteApi } from '../src/pages/api/v1/referrals/quote';
import { POST as dodoWebhook } from '../src/pages/api/webhooks/dodo';

const ORIGIN = 'https://zuey.test';
const T0 = Date.parse('2026-10-05T00:00:00.000Z');
const SLOT = '2026-10-07T02:00:00.000Z';
const RATE = 26350;
const DODO_SECRET = `whsec_${btoa('zuey-referral-dodo-secret')}`;
const DODO_BASE = 'https://test.dodopayments.com';
const PAYPAL_BASE = 'https://api-m.sandbox.paypal.com';

let d1: ReturnType<typeof createTestD1>;
interface Call { url: string; method: string; body: string }
let calls: Call[];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field(v: unknown, key: string): unknown {
  return isRecord(v) ? v[key] : undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Mocked provider APIs; unknown URLs fail loudly so no request leaves the process. */
async function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  const call: Call = { url: input, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : '' };
  calls.push(call);
  if (input === `${DODO_BASE}/discounts`) return json({ discount_id: `dsc_${calls.length}`, code: `REF${calls.length}XYZ`, amount: 1500 });
  if (input === `${DODO_BASE}/checkouts`) return json({ session_id: `cks_${calls.length}`, checkout_url: `https://test.checkout.dodopayments.com/session/cks_${calls.length}` });
  if (input === `${PAYPAL_BASE}/v1/oauth2/token`) return json({ access_token: 'pp_access', expires_in: 32400 });
  if (input === `${PAYPAL_BASE}/v2/checkout/orders`) {
    return json({ id: 'ORDER-1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1' }] });
  }
  return json({ error: `unexpected ${input}` }, 500);
}

function env(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return {
    DB: d1,
    PUBLIC_SITE_URL: ORIGIN,
    MEMBER_HASH_SALT: 'salt',
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
    PAYPAL_CLIENT_ID: 'pp_client',
    PAYPAL_CLIENT_SECRET: 'pp_secret',
    PAYPAL_WEBHOOK_ID: 'WH-123',
    PAYPAL_API_BASE: PAYPAL_BASE,
    ...overrides,
  };
}

function ctx(opts: { method?: string; path?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; params?: Record<string, string> }): APIContext {
  const headers = new Headers(opts.headers ?? {});
  const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined && !headers.has('content-type')) headers.set('Content-Type', 'application/json');
  const request = new Request(`${ORIGIN}${opts.path ?? '/api/test'}`, { method: opts.method ?? 'GET', headers, body });
  // Handlers only read request/params/locals; a full APIContext is not constructible in tests.
  const partial = { request, params: opts.params ?? {}, url: new URL(request.url), locals: { runtime: { env: env() } } };
  return partial as unknown as APIContext;
}

async function read(res: Response): Promise<{ data: unknown; code: string | null }> {
  const body: unknown = await res.json();
  return { data: field(body, 'data'), code: isRecord(body) && isRecord(body.error) ? String(body.error.code) : null };
}

interface Member { userId: string; cookie: string }

async function member(email: string): Promise<Member> {
  const { user } = await findOrCreateVerifiedUser(d1, { email });
  const { token } = await createMemberSession(d1, user.id);
  return { userId: user.id, cookie: `zuey_member=${token}` };
}

/** An admin-enabled referrer (tier rate 20 %) giving `discount` % of it to referees. */
async function referrer(email: string, discount: number): Promise<{ id: string; code: string }> {
  const { user } = await findOrCreateVerifiedUser(d1, { email });
  const { code } = await ensureReferralProfile(d1, user.id);
  await d1.prepare('UPDATE referral_profiles SET discount_percent = ?, admin_enabled = 1 WHERE user_id = ?').bind(discount, user.id).run();
  return { id: user.id, code };
}

async function checkout(m: Member, body: Record<string, unknown>, extraCookie = ''): Promise<{ status: number; data: unknown; code: string | null }> {
  const res = await ordersApi(ctx({ method: 'POST', body, headers: { cookie: `${m.cookie}${extraCookie}`, Origin: ORIGIN } }));
  return { status: res.status, ...(await read(res)) };
}

async function row(table: 'billing_orders' | 'card_subscriptions' | 'bookings' | 'users', where: string, value: string): Promise<Record<string, unknown>> {
  const r = await d1.prepare(`SELECT * FROM ${table} WHERE ${where} = ?`).bind(value).first<Record<string, unknown>>();
  if (!r) throw new Error(`${table} row missing`);
  return r;
}

let webhookSeq = 0;

async function sendDodo(type: string, data: Record<string, unknown>): Promise<unknown> {
  const body = JSON.stringify({ business_id: 'bus_test', type, timestamp: new Date(T0).toISOString(), data });
  const id = `msg_${++webhookSeq}`;
  const ts = String(Math.floor(T0 / 1000));
  const signature = await signDodoPayload(DODO_SECRET, id, ts, body);
  const res = await dodoWebhook(ctx({ method: 'POST', rawBody: body, headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signature } }));
  return field((await read(res)).data, 'outcome');
}

beforeEach(async () => {
  d1 = createTestD1();
  calls = [];
  membersRuntime.now = () => T0;
  membersRuntime.fetch = fakeFetch;
  bookingRuntime.now = () => T0;
  bookingRuntime.fetch = fakeFetch;
  resetPaypalTokenCache();
  const rules = [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start_time: '09:00', end_time: '12:00', timezone: 'Asia/Ho_Chi_Minh', slot_minutes: 90 }));
  await setAvailability(d1, { rules, exceptions: [] });
});

afterEach(() => {
  membersRuntime.now = () => Date.now();
  bookingRuntime.now = () => Date.now();
});

describe('SePay membership order with a referral', () => {
  it('stacks the referral discount after the 12-month prepay discount and snapshots the terms', async () => {
    const ref = await referrer('ref@example.com', 15);
    const m = await member('lan@example.com');
    // Client-sent amounts are ignored: the server recomputes everything.
    const res = await checkout(m, { plan: 'combo', months: 12, referral_code: ref.code.toUpperCase(), amount_vnd: 1000, amount_usd_cents: 1 });
    expect(res.status).toBe(201);
    // Combo: $228 → 12-month 20 % → $182.40 → referral 15 % → $155.04.
    expect(field(res.data, 'amount_usd_cents')).toBe(15504);
    const before = prepayVnd(1900, 12, RATE);
    expect(before).toBe(4_810_000);
    expect(field(res.data, 'amount_vnd')).toBe(4_089_000); // 15 % off rounded down to a 1,000 VND discount
    expect(field(res.data, 'referral_discount_percent')).toBe(15);
    expect(field(res.data, 'amount_before_referral_vnd')).toBe(before);
    expect(field(field(res.data, 'transfer'), 'amount')).toBe(4_089_000);

    const order = await row('billing_orders', 'code', String(field(res.data, 'code')));
    expect(order.referrer_user_id).toBe(ref.id);
    expect(order.referral_rate).toBe(20);
    expect(order.referral_discount_percent).toBe(15);
    expect(order.referral_commission_percent).toBe(5);
    expect(order.amount_before_referral).toBe(before);
    // A typed code binds the unbound account permanently.
    expect((await row('users', 'id', m.userId)).referred_by_user_id).toBe(ref.id);
  });

  it('leaves amounts unchanged without a referral and applies the zr_ref cookie when present', async () => {
    const m = await member('lan@example.com');
    const plain = await checkout(m, { plan: 'combo', months: 12 });
    expect(plain.status).toBe(201);
    expect(field(plain.data, 'amount_usd_cents')).toBe(prepayUsdCents(1900, 12));
    expect(field(plain.data, 'amount_vnd')).toBe(prepayVnd(1900, 12, RATE));
    expect(field(plain.data, 'referral_discount_percent')).toBeNull();
    const order = await row('billing_orders', 'code', String(field(plain.data, 'code')));
    expect(order.referrer_user_id).toBeNull();
    expect(order.amount_before_referral).toBeNull();

    const ref = await referrer('ref@example.com', 10);
    const viaCookie = await checkout(m, { plan: 'ai', months: 1 }, `; zr_ref=${ref.code}`);
    expect(viaCookie.status).toBe(201);
    expect(field(viaCookie.data, 'amount_usd_cents')).toBe(810);
    expect(field(viaCookie.data, 'referral_discount_percent')).toBe(10);
  });

  it('rejects malformed or inapplicable referral codes instead of silently charging full price', async () => {
    const m = await member('lan@example.com');
    const malformed = await checkout(m, { plan: 'combo', referral_code: 'no!' });
    expect(malformed.status).toBe(400);
    expect(malformed.code).toBe('invalid_field');
    const unknown = await checkout(m, { plan: 'combo', referral_code: 'zzzzzzzz' });
    expect(unknown.status).toBe(400);
    expect(unknown.code).toBe('referral_code_invalid');
    // Self-referral cannot apply either.
    const self = await referrer('self@example.com', 10);
    const selfMember = await member('self@example.com');
    const own = await checkout(selfMember, { plan: 'combo', referral_code: self.code });
    expect(own.code).toBe('referral_code_invalid');
    expect(calls).toEqual([]);
  });

  it('computes amounts with the shared helper (VND discount in whole 1,000 VND)', () => {
    const a = sepayReferralAmounts('knowledges', 3, RATE, 7);
    expect(a.beforeUsdCents).toBe(prepayUsdCents(900, 3));
    expect(a.vnd % 1000).toBe(0);
    expect(a.vnd).toBeLessThan(a.beforeVnd);
  });
});

describe('Dodo card checkout with a referral', () => {
  it('creates a single-use first-cycle discount and pre-applies it to the checkout', async () => {
    const ref = await referrer('ref@example.com', 15);
    const m = await member('lan@example.com');
    const res = await checkout(m, { plan: 'combo', provider: 'dodo', referral_code: ref.code });
    expect(res.status).toBe(201);
    const discountCall = calls.find(c => c.url === `${DODO_BASE}/discounts`);
    const checkoutCall = calls.find(c => c.url === `${DODO_BASE}/checkouts`);
    expect(calls.indexOf(discountCall ?? calls[0])).toBeLessThan(calls.indexOf(checkoutCall ?? calls[0]));
    const discount: unknown = JSON.parse(discountCall?.body ?? '{}');
    const id = String(field(res.data, 'id'));
    expect(discount).toEqual({
      type: 'percentage',
      amount: 1500,
      usage_limit: 1,
      subscription_cycles: 1,
      restricted_to: ['pdt_combo'],
      expires_at: new Date(T0 + 24 * 60 * 60 * 1000).toISOString(),
      name: 'Referral 15%',
      metadata: { referral_order: id, card_ref: id, referrer_user_id: ref.id },
    });
    const session: unknown = JSON.parse(checkoutCall?.body ?? '{}');
    expect(field(session, 'discount_codes')).toEqual(['REF1XYZ']);
    expect(field(session, 'feature_flags')).toEqual({ allow_discount_code: true, allow_currency_selection: false });
    // Webhook metadata is unchanged by the referral.
    expect(field(session, 'metadata')).toEqual({ user_id: m.userId, plan: 'combo', card_ref: id });

    const card = await row('card_subscriptions', 'id', id);
    expect(card.referrer_user_id).toBe(ref.id);
    expect(card.referral_discount_percent).toBe(15);
    expect(card.referral_commission_percent).toBe(5);
    expect(card.amount_before_referral).toBe(1900);
    expect(card.referral_ref).toBe('dsc_1');
    // The member-facing card view carries the first-charge discount for the status page.
    expect(field(res.data, 'referral_discount_percent')).toBe(15);
  });

  it('sends no discount request or discount_codes without a referral', async () => {
    const m = await member('lan@example.com');
    expect((await checkout(m, { plan: 'combo', provider: 'dodo' })).status).toBe(201);
    expect(calls.some(c => c.url === `${DODO_BASE}/discounts`)).toBe(false);
    const plain = dodoCheckoutPayload('pdt', { plan: 'ai', customerEmail: 'a@b.co', customerName: null, returnUrl: 'x', metadata: {} });
    expect(field(plain, 'discount_codes')).toBeUndefined();
    expect(field(plain, 'feature_flags')).toEqual({ allow_discount_code: false, allow_currency_selection: false });
  });

  it('checks payment.succeeded against the discounted amount and stores the first payment id', async () => {
    await referrer('ref@example.com', 15);
    const ref = await d1.prepare('SELECT code FROM referral_profiles').first<{ code: string }>();
    const m = await member('lan@example.com');
    const res = await checkout(m, { plan: 'combo', provider: 'dodo', referral_code: ref?.code });
    const id = String(field(res.data, 'id'));
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
    // $19.00 − 15 % = $16.15 is the expected first charge: not an underpayment.
    expect(await sendDodo('payment.succeeded', payment('pay_first', 1615))).toBe('updated');
    let card = await row('card_subscriptions', 'id', id);
    expect(card.status).toBe('active');
    expect(card.first_payment_id).toBe('pay_first');
    // A renewal does not move the first payment id.
    expect(await sendDodo('payment.succeeded', payment('pay_renewal', 1900))).toBe('updated');
    card = await row('card_subscriptions', 'id', id);
    expect(card.first_payment_id).toBe('pay_first');
    // Anything below the discounted amount is still flagged.
    expect(await sendDodo('payment.succeeded', payment('pay_low', 1500))).toBe('needs_attention');
    expect((await row('card_subscriptions', 'id', id)).attention_reason).toBe('amount_mismatch');
  });

  async function referredCard(): Promise<{ id: string; payment: (paymentId: string, total: number, tax?: number) => Record<string, unknown> }> {
    const ref = await referrer('ref@example.com', 15);
    const m = await member('lan@example.com');
    const id = String(field((await checkout(m, { plan: 'combo', provider: 'dodo', referral_code: ref.code })).data, 'id'));
    const metadata = { user_id: m.userId, plan: 'combo', card_ref: id };
    return {
      id,
      payment: (paymentId, total, tax = 0) => ({
        payload_type: 'Payment', payment_id: paymentId, subscription_id: 'sub_1', total_amount: total, tax, currency: 'USD', status: 'succeeded',
        customer: { customer_id: 'cus_1', email: 'lan@example.com' }, metadata,
      }),
    };
  }

  it('flags a first charge above the quoted discounted price, still earning commission on what was collected', async () => {
    const { id, payment } = await referredCard();
    // The referee was quoted $16.15 but Dodo charged list price: the pre-applied discount was not honoured.
    const callsBefore = calls.length;
    expect(await sendDodo('payment.succeeded', payment('pay_first', 2090, 190))).toBe('needs_attention');
    const card = await row('card_subscriptions', 'id', id);
    expect(card.status).toBe('needs_attention');
    expect(card.attention_reason).toBe('referral_discount_not_applied');
    expect(card.first_payment_id).toBe('pay_first');
    expect(card.first_payment_cents).toBe(2090);
    expect(card.first_payment_tax_cents).toBe(190);
    const commission = await d1.prepare("SELECT base_amount_cents FROM referral_commissions WHERE source_kind = 'card_subscription' AND source_id = ?")
      .bind(id).first<{ base_amount_cents: number }>();
    expect(commission?.base_amount_cents).toBe(1900);
    // Flag only: nothing is changed or refunded at Dodo.
    expect(calls.slice(callsBefore).filter(c => c.url.startsWith(DODO_BASE))).toHaveLength(0);
  });

  it('applies the discounted floor to the first charge only: a discounted renewal is flagged', async () => {
    const { id, payment } = await referredCard();
    expect(await sendDodo('payment.succeeded', payment('pay_first', 1615))).toBe('updated');
    expect(await sendDodo('payment.succeeded', payment('pay_second', 1615))).toBe('needs_attention');
    expect((await row('card_subscriptions', 'id', id)).attention_reason).toBe('amount_mismatch');
  });

  it('binds a typed code only after the card checkout was created', async () => {
    const ref = await referrer('ref@example.com', 15);
    const m = await member('lan@example.com');
    membersRuntime.fetch = async (input: string, init?: RequestInit) => input === `${DODO_BASE}/checkouts` ? json({ message: 'down' }, 500) : fakeFetch(input, init);
    const failed = await checkout(m, { plan: 'combo', provider: 'dodo', referral_code: ref.code });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect((await row('users', 'id', m.userId)).referred_by_user_id).toBeNull();
  });
});

describe('one open discounted checkout per referee', () => {
  it('gives list price with no referral snapshot while a discounted order, card checkout or booking hold is open', async () => {
    const ref = await referrer('ref@example.com', 10);
    const m = await member('lan@example.com');
    const first = await checkout(m, { plan: 'ai', referral_code: ref.code });
    expect(first.status).toBe(201);
    const firstCode = String(field(first.data, 'code'));
    expect((await row('billing_orders', 'code', firstCode)).referrer_user_id).toBe(ref.id);

    // The member is bound now; a second order while the first is unpaid is not discounted, and not an error.
    const second = await checkout(m, { plan: 'ai' });
    expect(second.status).toBe(201);
    const secondRow = await row('billing_orders', 'code', String(field(second.data, 'code')));
    expect(secondRow.referrer_user_id).toBeNull();
    expect(secondRow.amount_before_referral).toBeNull();
    expect(secondRow.amount_usd_cents).toBe(prepayUsdCents(900, 1));
    const card = await checkout(m, { plan: 'combo', provider: 'dodo' });
    expect(card.status).toBe(201);
    expect((await row('card_subscriptions', 'id', String(field(card.data, 'id')))).referrer_user_id).toBeNull();
    expect(calls.some(c => c.url === `${DODO_BASE}/discounts`)).toBe(false);
    const quote = await quoteApi(ctx({ path: '/api/v1/referrals/quote', headers: { cookie: m.cookie } }));
    expect(field((await read(quote)).data, 'referral')).toBeNull();

    // Once the discounted order is gone, the next checkout is discounted again.
    await d1.prepare("UPDATE billing_orders SET status = 'expired' WHERE code = ?").bind(firstCode).run();
    const third = await checkout(m, { plan: 'ai' });
    expect((await row('billing_orders', 'code', String(field(third.data, 'code')))).referrer_user_id).toBe(ref.id);
  });

  it('counts a guest booking hold on the same canonical mailbox', async () => {
    const ref = await referrer('ref@example.com', 10);
    const held = await holdApi(ctx({ method: 'POST', body: { slot_start: SLOT, name: 'Lan', email: 'l.a.n+x@gmail.com', payment_method: 'sepay', referral_code: ref.code } }));
    expect(held.status).toBe(201);
    const m = await member('lan@gmail.com');
    const order = await checkout(m, { plan: 'ai', referral_code: ref.code });
    expect(order.status).toBe(201);
    expect((await row('billing_orders', 'code', String(field(order.data, 'code')))).referrer_user_id).toBeNull();
  });
});

describe('Consultation booking with a referral', () => {
  async function hold(method: 'paypal' | 'sepay', extra: Record<string, unknown> = {}, cookie?: string): Promise<{ status: number; data: unknown; code: string | null }> {
    const res = await holdApi(ctx({
      method: 'POST', headers: cookie ? { cookie } : {},
      body: { slot_start: SLOT, name: 'Lan', email: 'lan@example.com', payment_method: method, ...extra },
    }));
    return { status: res.status, ...(await read(res)) };
  }

  it('charges $1,899.05 on PayPal when the referrer gives half of R (5 % of the 10 % booking share)', async () => {
    const ref = await referrer('ref@example.com', 10);
    const h = await hold('paypal', { referral_code: ref.code });
    expect(h.status).toBe(201);
    const booking = field(h.data, 'booking');
    expect(field(booking, 'referral_discount_percent')).toBe(5);
    const id = String(field(booking, 'id'));
    const stored = await row('bookings', 'id', id);
    expect(stored.referrer_user_id).toBe(ref.id);
    expect(stored.referral_rate).toBe(20);
    expect(stored.referral_discount_percent).toBe(5);
    expect(stored.referral_commission_percent).toBe(5);
    expect(stored.amount_before_referral).toBe(199_900);

    const res = await bookingCheckoutApi(ctx({ method: 'POST', body: { token: field(h.data, 'manage_token') }, params: { id } }));
    expect(res.status).toBe(200);
    // The widget shows the server's discounted PayPal amount on the pay button.
    expect(field((await read(res)).data, 'amount_usd_cents')).toBe(189_905);
    const order: unknown = JSON.parse(calls.find(c => c.url === `${PAYPAL_BASE}/v2/checkout/orders`)?.body ?? '{}');
    const units = field(order, 'purchase_units');
    const unit = Array.isArray(units) ? units[0] : null;
    expect(field(unit, 'amount')).toEqual({ currency_code: 'USD', value: '1899.05' });
    expect((await row('bookings', 'id', id)).amount_expected).toBe(189_905);
  });

  it('discounts the SePay VietQR amount from the zr_ref cookie and keeps list price without one', async () => {
    const ref = await referrer('ref@example.com', 10);
    const h = await hold('sepay', {}, `zr_ref=${ref.code}`);
    expect(h.status).toBe(201);
    expect(field(field(field(h.data, 'booking'), 'sepay'), 'amount')).toBe(49_400_000);
    const id = String(field(field(h.data, 'booking'), 'id'));
    const res = await bookingCheckoutApi(ctx({ method: 'POST', body: { token: field(h.data, 'manage_token') }, params: { id } }));
    expect(field((await read(res)).data, 'amount')).toBe(49_400_000);

    await d1.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").bind(id).run();
    const plain = await hold('sepay');
    expect(field(field(field(plain.data, 'booking'), 'sepay'), 'amount')).toBe(52_000_000);
    expect(field(field(plain.data, 'booking'), 'referral_discount_percent')).toBeNull();
  });

  it('rejects a typed code that cannot apply', async () => {
    const h = await hold('paypal', { referral_code: 'zzzzzzzz' });
    expect(h.status).toBe(400);
    expect(h.code).toBe('referral_code_invalid');
  });
});

describe('GET /api/v1/referrals/quote', () => {
  it('quotes discounted prices for an anonymous visitor without caching or setting cookies', async () => {
    const ref = await referrer('ref@example.com', 15);
    const res = await quoteApi(ctx({ path: `/api/v1/referrals/quote?code=${ref.code}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Set-Cookie')).toBeNull();
    const { data } = await read(res);
    expect(field(data, 'referral')).toEqual({ code: ref.code, discount_percent: 15, booking_discount_percent: 8, source: 'entered', provisional: true });
    const plans = field(data, 'plans');
    const combo12 = Array.isArray(plans) ? plans.find(p => field(p, 'plan') === 'combo' && field(p, 'months') === 12) : null;
    expect(field(combo12, 'discounted_usd_cents')).toBe(15504);
    expect(field(combo12, 'discounted_vnd')).toBe(4_089_000);
    expect(field(field(data, 'booking'), 'discounted_usd_cents')).toBe(applyBooking(8));
  });

  it('returns no referral for a signed-in member who already paid', async () => {
    const ref = await referrer('ref@example.com', 15);
    const m = await member('lan@example.com');
    await d1.prepare("INSERT INTO billing_orders (id, code, user_id, plan, months, amount_usd_cents, usd_vnd_rate, amount_vnd, status, expires_at, paid_at, created_at, updated_at) VALUES ('ord_old', 'ZSBOLD00001', ?, 'ai', 1, 900, 26350, 238000, 'paid', ?, ?, ?, ?)")
      .bind(m.userId, new Date(T0).toISOString(), new Date(T0).toISOString(), new Date(T0).toISOString(), new Date(T0).toISOString()).run();
    const res = await quoteApi(ctx({ path: `/api/v1/referrals/quote?code=${ref.code}`, headers: { cookie: m.cookie } }));
    expect(field((await read(res)).data, 'referral')).toBeNull();
  });
});

function applyBooking(percent: number): number {
  return 199_900 - Math.floor((199_900 * percent) / 100);
}
