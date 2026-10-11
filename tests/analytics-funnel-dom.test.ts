import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Root } from 'react-dom/client';

// Funnel events from the real components through the real browser client into a fake `window.posthog`.
// The DOM must exist before react-dom/client loads, so the modules under test are imported dynamically.
// This file installs happy-dom as process globals: never run it with `bun test --concurrent`.
GlobalRegistrator.register({
  url: 'https://zuey.me/pricing?plan=ai&utm_source=newsletter&utm_campaign=launch&email=duy%40example.com&gclid=G-123',
});
Object.defineProperty(document, 'referrer', { value: 'https://www.google.com/search?q=duy%40example.com', configurable: true });

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { bootAnalytics, optOut, signOutAnalytics } = await import('../src/lib/analytics/client');
const { containsPii } = await import('../src/lib/analytics/pii');
const { PricingTable } = await import('../src/components/members/PricingTable');
const { LoginForm, TokenConfirm } = await import('../src/components/members/MemberAuth');
const { BookingWidget } = await import('../src/components/booking/BookingWidget');
const { CourseCheckout } = await import('../src/components/courses/CourseCheckout');
const { plansCatalog } = await import('../src/lib/members/account');

const FUNNEL_EVENTS = [
  'sign_up_started', 'magic_link_requested', 'auth_failed', 'logout', 'pricing_viewed', 'billing_term_selected', 'plan_selected',
  'begin_checkout', 'checkout_created', 'payment_initiated', 'booking_availability_viewed', 'booking_slot_selected',
  'booking_hold_created', 'booking_checkout_started',
];

const MEMBER_ID = 'usr_01JFUNNELTEST';
// Values the flows handle that must never reach an event.
const EMAIL = 'duy.guest@example.com';
const GUEST_NAME = 'Nguyễn Văn Khách';
const MAGIC_TOKEN = 'mlt_9f8e7d6c5b4a39281706';
const ORDER_CODE = 'ZM7QK2PA';
const COURSE_ORDER = 'ZC5RT8WX';
const BOOKING_ID = 'bk_01JBOOKINGTEST';
const BOOKING_CODE = 'ZB9QX2LM';
const MANAGE_TOKEN = 'mng_5e4d3c2b1a0f9e8d7c6b';
const DODO_URL = 'https://test.checkout.dodopayments.com/session/cks_abc?token=dodotok123';
const PAYPAL_URL = 'https://www.sandbox.paypal.com/checkoutnow?token=EC-7PAYPAL';
const BANK_ACCOUNT = '0123456789';
const SECRETS = [EMAIL, GUEST_NAME, MAGIC_TOKEN, ORDER_CODE, COURSE_ORDER, BOOKING_ID, BOOKING_CODE, MANAGE_TOKEN, DODO_URL, PAYPAL_URL, BANK_ACCOUNT, 'duy@example.com', 'G-123'];

interface Capture { event: string; props: Record<string, unknown>; distinctId: string }
const captured: Capture[] = [];
const identified: string[] = [];
let distinctId = 'anon-1';
let anon = 1;

Reflect.set(window, 'posthog', {
  init: () => undefined,
  capture: (event: string, props?: Record<string, unknown>) => { captured.push({ event, props: props ?? {}, distinctId }); },
  identify: (id: string) => { identified.push(id); distinctId = id; },
  reset: () => { anon += 1; distinctId = `anon-${anon}`; },
  get_distinct_id: () => distinctId,
  opt_out_capturing: () => undefined,
  opt_in_capturing: () => undefined,
});

const meta = document.createElement('meta');
meta.id = 'zuey-analytics';
meta.setAttribute('data-key', 'phc_testkeyfunnel0123456789abcdef');
meta.setAttribute('data-host', 'https://us.i.posthog.com');
// Debug lifts the production-hostname/dev-build gate only; consent is still enforced.
meta.setAttribute('data-debug', '1');
document.head.appendChild(meta);

let magicLinkOk = true;
const slotStart = new Date(Date.now() + 3 * 24 * 3600 * 1000 + 3600 * 1000);
slotStart.setUTCMinutes(0, 0, 0);
const slotEnd = new Date(slotStart.getTime() + 90 * 60 * 1000);

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function bodyOf(init: RequestInit | undefined): Promise<Record<string, unknown>> {
  if (typeof init?.body !== 'string') return {};
  const parsed: unknown = JSON.parse(init.body);
  return typeof parsed === 'object' && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {};
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'https://zuey.me');
  const path = url.pathname;
  if (path === '/api/members/auth/identity') return reply({ success: true, data: { member_id: MEMBER_ID } });
  if (path === '/api/members/auth/magic-link') {
    return magicLinkOk ? reply({ success: true, data: { sent: true } }) : reply({ success: false, error: { code: 'rate_limited', message: 'slow down' } }, 429);
  }
  if (path === '/api/members/auth/magic-link/verify') return reply({ success: false, error: { code: 'token_expired', message: 'expired' } }, 400);
  if (path === '/api/v1/billing/orders') {
    const body = await bodyOf(init);
    if (body.provider === 'dodo') return reply({ success: true, data: { id: 'card_1', provider: 'dodo', status: 'pending', plan: body.plan, checkout_url: DODO_URL } }, 201);
    return reply({
      success: true,
      data: {
        code: ORDER_CODE, provider: 'sepay', status: 'pending', plan: body.plan, months: body.months, amount_vnd: 711000,
        transfer: { bank_account: BANK_ACCOUNT, transfer_content: ORDER_CODE, qr_url: `https://qr.sepay.vn/img?acc=${BANK_ACCOUNT}&des=${ORDER_CODE}` },
      },
    }, 201);
  }
  if (path.startsWith('/api/v1/courses/') && path.endsWith('/checkout')) return reply({ success: true, data: { code: COURSE_ORDER, status: 'pending' } }, 201);
  if (path === '/api/v1/booking/slots') {
    return reply({ success: true, data: { slots: [{ start: slotStart.toISOString(), end: slotEnd.toISOString(), duration_min: 90 }] } });
  }
  if (path === '/api/v1/booking/hold') {
    return reply({
      success: true,
      data: {
        manage_token: MANAGE_TOKEN,
        booking: {
          id: BOOKING_ID, code: BOOKING_CODE, status: 'held', slot_start: slotStart.toISOString(), slot_end: slotEnd.toISOString(),
          hold_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), guest_name: GUEST_NAME, guest_timezone: 'Asia/Ho_Chi_Minh',
          payment_method: 'paypal', meet_url: null, can_reschedule: false, reschedule_blocked_reason: null, sepay: null, referral_discount_percent: null,
        },
      },
    }, 201);
  }
  if (path === `/api/v1/booking/${BOOKING_ID}/checkout`) return reply({ success: true, data: { url: PAYPAL_URL, amount_usd_cents: 199900 } });
  return reply({ success: false, error: { code: 'not_found', message: 'not found' } }, 404);
}

Reflect.set(globalThis, 'fetch', fakeFetch);
Reflect.set(window, 'fetch', fakeFetch);
const assigned: string[] = [];
// Debug mode logs every event; keep the test output readable.
const quiet = spyOn(console, 'debug').mockImplementation(() => undefined);
const assign = spyOn(window.location, 'assign').mockImplementation((url: string | URL) => { assigned.push(String(url)); });
// Links (OAuth buttons, PayPal) must not navigate the test window.
document.addEventListener('click', e => { if (e.target instanceof Element && e.target.closest('a')) e.preventDefault(); });

let root: Root | null = null;
let host: HTMLElement;

beforeAll(() => { Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
});
afterAll(async () => {
  assign.mockRestore();
  quiet.mockRestore();
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  await GlobalRegistrator.unregister();
});

async function mount(element: ReturnType<typeof createElement>): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  const r = createRoot(host);
  root = r;
  await act(async () => r.render(element));
  await settle();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

function button(match: (text: string, el: HTMLButtonElement) => boolean): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(b => match(b.textContent ?? '', b));
  if (!found) throw new Error('button missing');
  return found;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    if (el instanceof HTMLElement) el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function typeInto(el: Element | null, value: string): Promise<void> {
  if (!(el instanceof HTMLInputElement)) throw new Error('input missing');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(form: Element | null): Promise<void> {
  if (!form) throw new Error('form missing');
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await settle();
}

const since = (n: number) => captured.slice(n);
const names = (list: Capture[]) => list.map(c => c.event);

function catalog() {
  const base = plansCatalog({ USD_VND_RATE: '26350' });
  return { ...base, billing_configured: true, card_plans: base.plans.map(p => p.id) };
}

describe('pricing and checkout funnel', () => {
  test('pricing_viewed fires once, even when the table mounts before the boot step and remounts', async () => {
    await mount(createElement(PricingTable, { catalog: catalog(), initialPlan: 'ai', initialMonths: 3 }));
    expect(captured).toEqual([]);
    bootAnalytics();
    await settle();
    await act(async () => root?.unmount());
    await mount(createElement(PricingTable, { catalog: catalog(), initialPlan: 'ai', initialMonths: 3 }));
    const viewed = captured.filter(c => c.event === 'pricing_viewed');
    expect(viewed).toHaveLength(1);
    expect(viewed[0].props).toEqual({
      months: 3, card_available: true, preselected_plan: 'ai',
      session_utm_source: 'newsletter', session_utm_campaign: 'launch', session_referrer: 'https://www.google.com',
      event_version: 1, schema_version: 1,
    });
    // The anonymous pricing view is merged into the member when the identity check answers.
    expect(identified).toEqual([MEMBER_ID]);
  });

  test('term switch, plan, begin_checkout, checkout_created and payment_initiated (VietQR)', async () => {
    await mount(createElement(PricingTable, { catalog: catalog(), initialPlan: null, initialMonths: 1 }));
    const start = captured.length;
    const sixMonths = host.querySelector('input[name="months"][value="6"]');
    if (!sixMonths) throw new Error('term radio missing');
    await click(sixMonths);
    await click(button(t => t.includes('Zuey AI') && t.includes('VietQR')));
    const events = since(start);
    expect(names(events)).toEqual(['billing_term_selected', 'plan_selected', 'begin_checkout', 'checkout_created', 'payment_initiated']);
    expect(events[0].props).toMatchObject({ months: 6, previous_months: 1 });
    expect(events[1].props).toMatchObject({ plan: 'ai', provider: 'sepay', months: 6 });
    expect(events[2].props).toMatchObject({ order_type: 'membership', provider: 'sepay', plan: 'ai', months: 6, discount_entered: false, currency: 'VND' });
    expect(events[3].props).toMatchObject({ order_type: 'membership', provider: 'sepay', plan: 'ai', months: 6, free: false, value: 711000, currency: 'VND' });
    expect(events[4].props).toMatchObject({ order_type: 'membership', provider: 'sepay', plan: 'ai', months: 6 });
    // Joins the server purchase/subscription_activated: same member id the outbox uses (users.id).
    expect(new Set(events.map(e => e.distinctId))).toEqual(new Set([MEMBER_ID]));
    expect(assigned.at(-1)).toBe(`/billing/${ORDER_CODE}`);
  });

  test('card checkout sends payment_initiated before leaving for the hosted page', async () => {
    await mount(createElement(PricingTable, { catalog: catalog(), initialPlan: null, initialMonths: 3 }));
    const start = captured.length;
    const card = host.querySelector('#plan-knowledges')?.closest('li')?.querySelectorAll('button');
    const cardButton = Array.from(card ?? []).find(b => b.textContent?.includes('Thẻ quốc tế'));
    if (!cardButton) throw new Error('card button missing');
    await click(cardButton);
    const events = since(start);
    expect(names(events)).toEqual(['plan_selected', 'begin_checkout', 'checkout_created', 'payment_initiated']);
    expect(events[0].props).toMatchObject({ provider: 'dodo', months: 1 });
    expect(events[1].props).toMatchObject({ provider: 'dodo', months: 1, currency: 'USD' });
    expect(events[2].props).toMatchObject({ provider: 'dodo', free: false });
    expect(events[2].props).not.toHaveProperty('value');
    expect(events[3].props).toMatchObject({ provider: 'dodo' });
    expect(assigned.at(-1)).toBe(DODO_URL);
  });

  test('course checkout uses the same checkout events with the course slug', async () => {
    await mount(createElement(CourseCheckout, { courseSlug: 'ai-agents-101', signedIn: true, sepayAvailable: true, cardAvailable: false }));
    const start = captured.length;
    const terms = host.querySelector('input[type="checkbox"][required]');
    if (!terms) throw new Error('terms missing');
    await click(terms);
    await submit(host.querySelector('form'));
    const events = since(start);
    expect(names(events)).toEqual(['begin_checkout', 'checkout_created', 'payment_initiated']);
    expect(events[0].props).toMatchObject({ order_type: 'course', provider: 'sepay', course: 'ai-agents-101', discount_entered: false });
    expect(events[1].props).toMatchObject({ order_type: 'course', free: false });
  });
});

describe('auth funnel', () => {
  test('a callback error, the email form, a failed request and the OAuth buttons', async () => {
    const start = captured.length;
    await mount(createElement(LoginForm, { next: '/pricing', error: 'oauth_denied' }));
    await typeInto(host.querySelector('input[type="email"]'), EMAIL);
    await submit(host.querySelector('form'));
    await click(button(t => t.includes('Dùng email khác')));
    magicLinkOk = false;
    await submit(host.querySelector('form'));
    magicLinkOk = true;
    const google = Array.from(host.querySelectorAll('a')).find(a => a.textContent?.includes('Google'));
    if (!google) throw new Error('google link missing');
    await click(google);
    const events = since(start);
    expect(names(events)).toEqual(['auth_failed', 'sign_up_started', 'magic_link_requested', 'sign_up_started', 'auth_failed', 'sign_up_started']);
    expect(events[0].props).toMatchObject({ stage: 'callback', reason: 'oauth_denied' });
    expect(events[1].props).toMatchObject({ method: 'magic_link' });
    expect(events[4].props).toMatchObject({ stage: 'magic_link_request', reason: 'rate_limited' });
    expect(events[5].props).toMatchObject({ method: 'google' });
  });

  test('a rejected sign-in link reports auth_failed without the token', async () => {
    window.history.replaceState(null, '', `/login/verify?token=${MAGIC_TOKEN}`);
    await mount(createElement(TokenConfirm, { mode: 'magic_link' }));
    const start = captured.length;
    await click(button(t => t === 'Đăng nhập'));
    expect(since(start).map(c => [c.event, c.props.stage, c.props.reason])).toEqual([['auth_failed', 'magic_link_verify', 'token_expired']]);
  });

  test('logout is sent under the member before the identity resets', () => {
    const start = captured.length;
    signOutAnalytics('account');
    expect(since(start).map(c => [c.event, c.distinctId, c.props.surface])).toEqual([['logout', MEMBER_ID, 'account']]);
    expect(distinctId).not.toBe(MEMBER_ID);
  });
});

describe('booking funnel', () => {
  test('availability, slot, hold and checkout', async () => {
    const start = captured.length;
    await mount(createElement(BookingWidget, { methods: ['paypal'] }));
    const day = Array.from(host.querySelectorAll('button')).find(b => /khung giờ trống/.test(b.getAttribute('aria-label') ?? ''));
    if (!day) throw new Error('available day missing');
    await click(day);
    await click(button(t => t.includes('–')));
    await click(button(t => t === 'Tiếp tục'));
    const inputs = host.querySelectorAll('form input');
    await typeInto(inputs[0], GUEST_NAME);
    await typeInto(inputs[1], EMAIL);
    await submit(host.querySelector('form'));
    await click(button(t => t.includes('Giữ chỗ')));
    const events = since(start);
    expect(names(events)).toEqual(['booking_availability_viewed', 'booking_slot_selected', 'booking_hold_created', 'booking_checkout_started']);
    expect(events[0].props).toMatchObject({ slot_count: 1 });
    expect(events[1].props).toMatchObject({ duration_min: 90, days_ahead: 3 });
    expect(events[2].props).toMatchObject({ payment_method: 'paypal', discounted: false, free: false });
    expect(events[3].props).toMatchObject({ payment_method: 'paypal', value: 1999, currency: 'USD' });
  });
});

describe('privacy', () => {
  test('every funnel event fired, and no captured property carries personal data, tokens, codes or URLs', () => {
    const seen = new Set(captured.map(c => c.event));
    for (const name of FUNNEL_EVENTS) expect(seen.has(name)).toBe(true);
    for (const c of captured) {
      for (const [key, value] of Object.entries(c.props)) {
        if (typeof value !== 'string') continue;
        const where = `${c.event}.${key}=${value}`;
        expect({ where, pii: containsPii(value) }).toEqual({ where, pii: false });
        for (const secret of SECRETS) expect({ where, leaked: value.includes(secret) }).toEqual({ where, leaked: false });
        // Phone numbers, bank accounts: no long digit runs in strings.
        expect({ where, digits: /\d[\d\s.-]{8,}\d/.test(value) }).toEqual({ where, digits: false });
        if (key === 'session_referrer') {
          const ref = new URL(value);
          expect(`${ref.origin}`).toBe(value);
        } else {
          // No URL, path or query anywhere else.
          expect({ where, url: /:\/\/|[?&=/]/.test(value) }).toEqual({ where, url: false });
        }
      }
    }
  });

  test('after opting out, the same flows send nothing', async () => {
    optOut();
    const start = captured.length;
    await mount(createElement(PricingTable, { catalog: catalog(), initialPlan: null, initialMonths: 1 }));
    await click(button(t => t.includes('Knowledges') && t.includes('VietQR')));
    signOutAnalytics('account');
    expect(since(start)).toEqual([]);
  });
});
