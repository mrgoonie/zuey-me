import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Root } from 'react-dom/client';
import type { ReadItem } from '../src/lib/reads/store';

// Funnel and product engagement events from the real components and page scripts through the real browser
// client into a fake `window.posthog`. They share one file because the client is a module singleton that boots
// once per process: a second DOM file would inherit this one's boot, opt-out and once-per-page keys.
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
const { KnowledgesPanel } = await import('../src/components/knowledge/KnowledgesPanel');
const { ReadsBrowser } = await import('../src/components/reads/ReadsBrowser');
const { ZueyAiPanel } = await import('../src/components/ai/ZueyAiPanel');
const { ZueyOS } = await import('../src/components/os/ZueyOS');
const { openAppFromAgent } = await import('../src/components/os/webmcp-tools');
const { CommunityAccess } = await import('../src/components/home/CommunityAccess');
const { SurveyBlock } = await import('../src/components/blocks/SurveyBlock');
const { initKnowledgeSearchAnalytics } = await import('../src/scripts/knowledge-search-analytics');
const { initArticleAnalytics } = await import('../src/scripts/article-analytics');
const ENGAGEMENT_EVENTS = [
  'knowledge_search', 'knowledge_filter_applied', 'article_opened', 'article_engaged', 'paywall_viewed', 'article_unlocked',
  'reads_opened', 'read_source_clicked', 'ai_chat_started', 'ai_message_submitted', 'ai_response_completed', 'ai_response_failed',
  'ai_quota_reached', 'app_opened', 'community_invite_requested', 'community_joined', 'survey_submitted', 'feature_error',
];


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

// Content the flows handle that must never reach an event.
const SEARCH_TEXT = 'Nguyễn Văn An hỏi về claude code agents';
const CHAT_TEXT = 'Số của tôi là 0912 345 678, email an.nguyen@example.com. Tóm tắt bài này giúp tôi?';
const ANSWER_TEXT = 'Đây là câu trả lời bí mật dành riêng cho bạn.';
const INVITE_LINK = 'https://t.me/+SECRETINVITE123';
const READ_URL = 'https://blog.example.org/post?ref=an.nguyen%40example.com&token=rdtok999';
const VOTE_LABEL = 'Tôi thích phương án bí mật';
const ENGAGEMENT_SECRETS = [SEARCH_TEXT, 'claude code agents', 'Nguyễn', CHAT_TEXT, '0912', 'an.nguyen', ANSWER_TEXT, INVITE_LINK, 'SECRETINVITE', READ_URL, 'rdtok999', VOTE_LABEL];

interface Capture { event: string; props: Record<string, unknown>; distinctId: string }
const captured: Capture[] = [];
const initOptions: Record<string, unknown>[] = [];
const identified: string[] = [];
let distinctId = 'anon-1';
let anon = 1;

Reflect.set(window, 'posthog', {
  init: (_key: string, options: Record<string, unknown>) => { initOptions.push(options); },
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

function sse(frames: [string, unknown][]): Response {
  const text = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

let articlesFail = false;
let chatMode: 'ok' | 'error' | 'quota' = 'ok';
let communityJoined = false;
let inviteFails = false;
const now = new Date().toISOString();
const later = new Date(Date.now() + 3600_000).toISOString();

const card = {
  slug: 'agents-guide', locale: 'vi', title: 'Agents', excerpt: 'x', topic_tags: [], labels: [], category: null, access: 'free',
  published_at: now, reading_minutes: 4, cover_url: null, snippet: null,
};

function membership(chat: 'en' | 'vi', status: 'invited' | 'joined') {
  return { id: `cm_${chat}`, chat, status, invite_link: status === 'invited' ? INVITE_LINK : null, invite_expires_at: later, joined_at: status === 'joined' ? now : null, created_at: now };
}
let invitedOnce = false;

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'https://zuey.me');
  const path = url.pathname;
  const method = init?.method ?? 'GET';
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
  if (path === '/api/v1/articles') return articlesFail ? reply({ success: false, error: { code: 'internal_error', message: 'x' } }, 500) : reply({ success: true, data: [card, { ...card, slug: 'second' }] });
  if (path === '/api/v1/taxonomy') {
    return reply({ success: true, data: { categories: [{ id: 'c1', slug: 'agents', name: 'Agents' }], labels: [{ id: 'l1', key: 'tool:claude-code', name: 'Claude Code', published_count: 3 }], tags: [] } });
  }
  if (path === '/api/v1/chat/status') return reply({ success: true, data: { signed_in: true, entitled: true, configured: true, is_admin: false, quota: { month: '2026-10', used: 1, limit: 100, remaining: 99, spent_cents: 10, budget_cents: 300 } } });
  if (path === '/api/v1/chat/sessions' && method === 'GET') return reply({ success: true, data: { sessions: [], quota: { month: '2026-10', used: 1, limit: 100, remaining: 99, spent_cents: 10, budget_cents: 300 } } });
  if (path === '/api/v1/chat/sessions' && method === 'POST') return reply({ success: true, data: { id: 'cs_1', title: '', updated_at: now, running: false } }, 201);
  if (path === '/api/v1/chat/sessions/cs_1/messages') {
    if (chatMode === 'quota') return reply({ success: false, error: { code: 'ai_quota_exceeded', message: 'quota', month: '2026-10', limit: 100 } }, 429);
    if (chatMode === 'error') return sse([['delta', { text: 'Đang' }], ['error', { message_id: 'm2', code: 'ai_timeout', message: 'timeout', retryable: true, latency_ms: 30000 }]]);
    return sse([
      ['sources', { sources: [{ id: 's1', title: 'Agents', url: 'https://zuey.me/articles/agents-guide', access: 'free', scope: 'full' }] }],
      ['delta', { text: ANSWER_TEXT }],
      ['done', { message_id: 'm1', content: ANSWER_TEXT, cancelled: false, artifacts: [], artifact_errors: [], usage: { prompt_tokens: 1000, completion_tokens: 50 }, latency_ms: 8421, cost_cents: 0.12 }],
    ]);
  }
  if (path.startsWith('/api/v1/chat/sessions/cs_1')) return reply({ success: true, data: { messages: [], artifacts: [] } });
  if (path === '/api/v1/community') {
    return reply({
      success: true,
      data: {
        signed_in: true, configured: true, entitled: true, chats: [{ chat: 'en', available: true }, { chat: 'vi', available: true }],
        memberships: invitedOnce ? [membership('en', communityJoined ? 'joined' : 'invited')] : [],
      },
    });
  }
  if (path === '/api/v1/community/invite') {
    if (inviteFails) return reply({ success: false, error: { code: 'rate_limited', message: 'slow' } }, 429);
    invitedOnce = true;
    return reply({ success: true, data: membership('en', 'invited') }, 201);
  }
  if (path === '/api/v1/surveys/poll/vote') {
    return reply({ success: true, data: { block_id: 'poll', question: 'Q', allow_multiple: true, total_voters: 3, voted: true, options: [{ id: 'a', label: VOTE_LABEL, count: 2, percent: 67 }, { id: 'b', label: 'B', count: 1, percent: 33 }] } });
  }
  if (path === '/api/v1/surveys/locked/vote') return reply({ success: false, error: { code: 'survey_locked', message: 'locked' } }, 403);
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
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

function button(match: (text: string, el: HTMLButtonElement) => boolean): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(b => match(b.textContent ?? '', b));
  if (!found) throw new Error('button missing');
  return found;
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('element missing');
  await act(async () => {
    if (el instanceof HTMLElement) el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function typeInto(el: Element | null, value: string): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
  if (!el || !proto) throw new Error('field missing');
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(el: Element | null, value: string): Promise<void> {
  if (!(el instanceof HTMLSelectElement)) throw new Error('select missing');
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

async function submit(form: Element | null | undefined): Promise<void> {
  if (!form) throw new Error('form missing');
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await settle();
}

const since = (n: number) => captured.slice(n);
const names = (list: Capture[]) => list.map(c => c.event);
/** Event properties without the envelope the client adds (versions, session attribution). */
const plain = (c: Capture) => Object.fromEntries(Object.entries(c.props).filter(([k]) => !/^(event_version|schema_version|session_)/.test(k)));

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

describe('engagement: boot', () => {
  beforeAll(() => { window.history.replaceState(null, '', '/'); });

  test('PostHog is initialised with Web Vitals and exception autocapture', () => {
    expect(initOptions).toHaveLength(1);
    expect(initOptions[0].capture_performance).toEqual({ web_vitals: true, network_timing: false });
    expect(initOptions[0].capture_exceptions).toMatchObject({ capture_unhandled_errors: true, capture_unhandled_rejections: true });
    // The existing privacy settings still apply.
    expect(typeof initOptions[0].before_send).toBe('function');
  });
});

describe('Knowledges', () => {
  test('home panel: search sends the query length only, filters send public slugs, a failed load reports feature_error', async () => {
    await mount(createElement(KnowledgesPanel, { locale: 'vi' }));
    const start = captured.length;
    await click(host.querySelector('button[aria-expanded]'));
    await typeInto(host.querySelector('input[type="search"]'), SEARCH_TEXT);
    await submit(host.querySelector('form'));
    await click(button(t => t === 'Agents'));
    await choose(host.querySelector('select'), 'tool:claude-code');
    await click(host.querySelector('[aria-label] button[aria-pressed="false"]:last-child'));
    articlesFail = true;
    await click(Array.from(host.querySelectorAll('button')).filter(b => !b.closest('[role="group"]') && b.type === 'button').at(-1));
    articlesFail = false;
    const events = since(start);
    const search = events.find(e => e.event === 'knowledge_search');
    expect(search && plain(search)).toEqual({ surface: 'home', query_length: SEARCH_TEXT.length, results: 2 });
    const filters = events.filter(e => e.event === 'knowledge_filter_applied').map(e => [e.props.filter, e.props.value]);
    expect(filters).toContainEqual(['category', 'agents']);
    expect(filters).toContainEqual(['label', 'tool:claude-code']);
    expect(filters).toContainEqual(['reset', 'all']);
    expect(events.filter(e => e.event === 'feature_error').map(plain)).toEqual([{ feature: 'knowledge_panel', reason: 'http_500' }]);
  });

  test('/articles page: one search per results page, chips and changed selects', async () => {
    host = document.createElement('div');
    host.innerHTML = `
      <div hidden data-knowledge-search data-query-length="${SEARCH_TEXT.length}" data-results="7" data-semantic="1" data-page="1" data-failed="0"></div>
      <form data-knowledge-form>
        <a href="/articles?category=agents" data-knowledge-filter="category" data-knowledge-value="agents">Agents</a>
        <a href="/articles?tag=Nguyen%20Van%20An" data-knowledge-filter="tag" data-knowledge-value="Nguyễn Văn An">#x</a>
        <select name="label" data-knowledge-filter="label" data-initial=""><option value=""></option><option value="tool:claude-code">c</option></select>
        <select name="sort" data-knowledge-filter="sort" data-initial="relevance"><option value="relevance"></option><option value="new"></option></select>
        <a href="/articles" data-knowledge-filter="reset">Reset</a>
      </form>`;
    document.body.appendChild(host);
    const start = captured.length;
    initKnowledgeSearchAnalytics(document);
    initKnowledgeSearchAnalytics(document);
    await click(host.querySelector('[data-knowledge-value="agents"]'));
    await click(host.querySelector('[data-knowledge-filter="tag"]'));
    const label = host.querySelector('select[name="label"]');
    if (label instanceof HTMLSelectElement) label.value = 'tool:claude-code';
    host.querySelector('form')?.addEventListener('submit', e => e.preventDefault());
    await submit(host.querySelector('form'));
    await click(host.querySelector('[data-knowledge-filter="reset"]'));
    const events = since(start);
    // Listeners were attached twice above, so each interaction is counted twice; the page search once.
    expect(events.filter(e => e.event === 'knowledge_search').map(plain)).toEqual([{ surface: 'articles', query_length: SEARCH_TEXT.length, results: 7, semantic: true }]);
    const filters = events.filter(e => e.event === 'knowledge_filter_applied').map(e => `${e.props.filter}=${e.props.value}`);
    expect(new Set(filters)).toEqual(new Set(['category=agents', 'tag=other', 'label=tool:claude-code', 'reset=all']));
    expect(filters).not.toContain('sort=relevance');
  });

  test('Reads: opened once, a settled search, a source filter and an outbound click without the URL', async () => {
    const read = (over: Partial<ReadItem>): ReadItem => ({
      id: 'r', url: READ_URL, title: '', author: null, description: null, domain: null, site: null, image: null, source_kind: null, language: null,
      published: null, tags: '', word_count: null, content_hash: null, summary: null, visible: true, anymd_updated_at: null, synced_at: null, created_at: now, ...over,
    });
    const items = [
      read({ id: 'r1', title: 'Agents in practice', summary: 'about agents', site: 'Example Blog', domain: 'blog.example.org', source_kind: 'article' }),
      read({ id: 'r2', url: 'https://youtube.com/watch?v=abc', title: 'Video', domain: 'youtube.com', source_kind: 'youtube' }),
    ];
    window.history.replaceState(null, '', '/reads');
    const props = { items, sources: [{ source_kind: 'article', count: 1 }, { source_kind: 'youtube', count: 1 }], lastSyncedAt: null };
    const start = captured.length;
    await mount(createElement(ReadsBrowser, props));
    await typeInto(host.querySelector('input[type="search"]'), 'agents');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
    await click(button(t => t.startsWith('article')));
    await click(host.querySelector('a[target="_blank"]'));
    window.history.replaceState(null, '', '/');
    const events = since(start);
    expect(names(events)).toEqual(['reads_opened', 'knowledge_search', 'knowledge_filter_applied', 'read_source_clicked']);
    expect(events.map(plain)).toEqual([
      { surface: 'reads_page', items: 2 },
      { surface: 'reads', query_length: 6, results: 1 },
      { surface: 'reads', filter: 'source', value: 'article' },
      { source_kind: 'article', domain: 'blog.example.org', position: 1 },
    ]);
  });
});

describe('articles', () => {
  test('opened, unlocked, paywall seen and engaged after visible time and depth', async () => {
    const observers: { cb: IntersectionObserverCallback }[] = [];
    class FakeObserver {
      constructor(cb: IntersectionObserverCallback) { observers.push({ cb }); }
      observe(): void { /* fired manually */ }
      disconnect(): void { /* nothing to release */ }
    }
    const original = Reflect.get(window, 'IntersectionObserver');
    Reflect.set(window, 'IntersectionObserver', FakeObserver);
    host = document.createElement('div');
    host.innerHTML = `
      <div data-ask-ai-scope><p>body</p></div>
      <section class="zb-lockbox"></section>
      <div hidden data-article-analytics data-slug="agents-guide" data-locale="vi" data-access="knowledges" data-locked="1" data-reading-minutes="6" data-locked-sections="3"></div>`;
    document.body.appendChild(host);
    const start = captured.length;
    initArticleAnalytics(document);
    const entry: unknown = { isIntersecting: true };
    const fire = (o: { cb: IntersectionObserverCallback }) => Reflect.apply(o.cb, undefined, [[entry], {}]);
    observers.forEach(fire);
    observers.forEach(fire);
    Reflect.set(window, 'IntersectionObserver', original);
    const events = since(start);
    expect(events.map(e => [e.event, plain(e)])).toEqual([
      ['article_opened', { slug: 'agents-guide', locale: 'vi', access: 'knowledges', locked: true, reading_minutes: 6 }],
      ['paywall_viewed', { slug: 'agents-guide', locale: 'vi', locked_sections: 3 }],
    ]);
    host.remove();
  });

  test('a members-only article shown in full is unlocked, and engagement needs visible seconds', async () => {
    host = document.createElement('div');
    host.innerHTML = `<div data-ask-ai-scope><p>body</p></div>
      <div hidden data-article-analytics data-slug="members-guide" data-locale="en" data-access="knowledges" data-locked="0" data-reading-minutes="9" data-locked-sections="0"></div>`;
    document.body.appendChild(host);
    const ticks: (() => void)[] = [];
    const realSetInterval = Reflect.get(window, 'setInterval');
    Reflect.set(window, 'setInterval', (fn: () => void) => { ticks.push(fn); return 1; });
    const start = captured.length;
    try {
      initArticleAnalytics(document);
    } finally {
      Reflect.set(window, 'setInterval', realSetInterval);
    }
    // happy-dom lays nothing out, so the whole body counts as seen: only the visible time is missing.
    for (let i = 0; i < 29; i += 1) ticks.forEach(t => t());
    expect(names(since(start))).toEqual(['article_unlocked']);
    for (let i = 0; i < 5; i += 1) ticks.forEach(t => t());
    // article_opened already fired for this page load (trackOnce); unlocked and engaged are new.
    expect(since(start).map(e => [e.event, plain(e)])).toEqual([
      ['article_unlocked', { slug: 'members-guide', locale: 'en' }],
      ['article_engaged', { slug: 'members-guide', locale: 'en', access: 'knowledges', seconds: 30, depth: 100 }],
    ]);
  });
});

describe('Zuey AI', () => {
  test('chat started, message submitted (length only), completed with backend metrics, stream error, quota', async () => {
    await mount(createElement(ZueyAiPanel, { locale: 'vi' }));
    const start = captured.length;
    const ask = async (text: string) => {
      await typeInto(host.querySelector('textarea'), text);
      await submit(host.querySelector('textarea')?.closest('form'));
    };
    await ask(CHAT_TEXT);
    chatMode = 'error';
    await ask('Câu hỏi thứ hai');
    chatMode = 'quota';
    await ask('Câu hỏi thứ ba');
    chatMode = 'ok';
    const events = since(start);
    expect(names(events)).toEqual([
      'ai_chat_started', 'ai_message_submitted', 'ai_response_completed', 'ai_message_submitted', 'ai_response_failed', 'ai_message_submitted', 'ai_quota_reached',
    ]);
    expect(plain(events[1])).toEqual({ surface: 'window', chars: CHAT_TEXT.length, quoted: false, retry: false });
    expect(plain(events[2])).toEqual({ surface: 'window', sources: 1, artifacts: 0, latency_ms: 8421, prompt_tokens: 1000, completion_tokens: 50, cost_cents: 0.12 });
    expect(plain(events[4])).toEqual({ surface: 'window', stage: 'stream', reason: 'ai_timeout', retryable: true, latency_ms: 30000 });
    expect(plain(events[6])).toEqual({ surface: 'window', kind: 'requests', stage: 'send' });
  });
});

describe('ZueyOS, community and surveys', () => {
  test('app_opened from ZueyOS openApp', async () => {
    const profile = { id: 'p', name: 'Duy', handle: 'duy', email: 'duy@example.com', avatar_url: '/avatar.png', intro_en: '', intro_vi: '', theme: 'default' };
    await mount(createElement(ZueyOS, { locale: 'vi', profile, links: [], signedIn: false }));
    const start = captured.length;
    for (const app of ['pricing', 'ai']) {
      await act(async () => {
        // happy-dom dispatches hashchange itself, as a browser does.
        window.location.hash = `#${app}`;
      });
      await settle();
    }
    const opened = since(start).filter(e => e.event === 'app_opened');
    // The AI window is open at boot: reopening it is reported as already open.
    expect(opened.map(plain)).toEqual([{ app: 'pricing', already_open: false }, { app: 'ai', already_open: true }]);
    window.history.replaceState(null, '', '/');
  });

  test('app_opened from a WebMCP agent is tagged source webmcp', async () => {
    const profile = { id: 'p', name: 'Duy', handle: 'duy', email: 'duy@example.com', avatar_url: '/avatar.png', intro_en: '', intro_vi: '', theme: 'default' };
    await mount(createElement(ZueyOS, { locale: 'vi', profile, links: [], signedIn: false }));
    const start = captured.length;
    await act(async () => { openAppFromAgent('reads'); });
    await settle();
    const opened = since(start).filter(e => e.event === 'app_opened');
    expect(plain(opened[0])).toEqual({ app: 'reads', already_open: false, source: 'webmcp' });
    expect(opened.filter(e => e.props.source === 'webmcp')).toHaveLength(1);
    // ZueyOS acknowledged the event and wrote the deep link itself. (happy-dom, unlike browsers, also fires
    // hashchange for that replaceState, so a second, untagged already-open event may follow here.)
    expect(window.location.hash).toBe('#reads');
    window.history.replaceState(null, '', '/');
  });

  test('a #app deep link reopens a window that was minimized after an earlier visit to the same hash', async () => {
    const profile = { id: 'p', name: 'Duy', handle: 'duy', email: 'duy@example.com', avatar_url: '/avatar.png', intro_en: '', intro_vi: '', theme: 'default' };
    await mount(createElement(ZueyOS, { locale: 'en', profile, links: [], signedIn: false }));
    const pricingOpens = (from: number) => since(from).filter(e => e.event === 'app_opened' && e.props.app === 'pricing');
    let start = captured.length;
    await act(async () => { window.location.hash = '#pricing'; });
    await settle();
    expect(pricingOpens(start).length).toBeGreaterThan(0);
    const minimize = host.querySelector('[data-app="pricing"] button.mn');
    if (!minimize) throw new Error('pricing window has no minimize button');
    await click(minimize);
    // The hash no longer names a window that is off screen, so the same deep link fires hashchange again.
    expect(window.location.hash).not.toBe('#pricing');
    start = captured.length;
    await act(async () => { window.location.hash = '#pricing'; });
    await settle();
    expect(pricingOpens(start).map(plain)[0]).toEqual({ app: 'pricing', already_open: false });
    // Pricing is visible again and stacked above every other window.
    const shown = Array.from(host.querySelectorAll<HTMLElement>('section[data-app]')).filter(w => !w.hidden);
    const topWin = shown.reduce((a, b) => (Number(b.style.zIndex) > Number(a.style.zIndex) ? b : a));
    expect(topWin.dataset.app).toBe('pricing');
    window.history.replaceState(null, '', '/');
  });

  test('invite requested, joined after returning from Telegram, and a failed invite', async () => {
    await mount(createElement(CommunityAccess, { locale: 'en' }));
    const start = captured.length;
    const [en] = Array.from(host.querySelectorAll('li')).map(li => li.querySelector('button'));
    await click(en);
    communityJoined = true;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    inviteFails = true;
    await click(button(t => t === 'Get invite link'));
    inviteFails = false;
    expect(since(start).map(e => [e.event, plain(e)])).toEqual([
      ['community_invite_requested', { chat: 'en' }],
      ['community_joined', { chat: 'en' }],
      ['feature_error', { feature: 'community_invite', reason: 'rate_limited' }],
    ]);
  });

  test('survey_submitted counts choices, never which; a rejected vote reports feature_error', async () => {
    const block = { id: 'poll', type: 'survey' as const, question: 'Q', options: [{ id: 'a', label: VOTE_LABEL }, { id: 'b', label: 'B' }], allowMultiple: true };
    await mount(createElement(SurveyBlock, { block, articleSlug: 'agents-guide' }));
    const start = captured.length;
    for (const box of Array.from(host.querySelectorAll('input[type="checkbox"]'))) await click(box);
    await submit(host.querySelector('form'));
    await act(async () => root?.unmount());
    await mount(createElement(SurveyBlock, { block: { ...block, id: 'locked', allowMultiple: false }, articleSlug: 'agents-guide' }));
    await click(host.querySelector('input[type="radio"]'));
    await submit(host.querySelector('form'));
    expect(since(start).map(e => [e.event, plain(e)])).toEqual([
      ['survey_submitted', { slug: 'agents-guide', options: 2, multiple: true }],
      ['feature_error', { feature: 'survey_vote', reason: 'survey_locked' }],
    ]);
  });
});

describe('privacy', () => {
  test('every funnel and engagement event fired, and no captured property carries personal data, search or chat text, tokens, codes or URLs', () => {
    const seen = new Set(captured.map(c => c.event));
    for (const name of [...FUNNEL_EVENTS, ...ENGAGEMENT_EVENTS]) expect({ name, seen: seen.has(name) }).toEqual({ name, seen: true });
    for (const c of captured) {
      for (const [key, value] of Object.entries(c.props)) {
        if (typeof value !== 'string') continue;
        const where = `${c.event}.${key}=${value}`;
        expect({ where, pii: containsPii(value) }).toEqual({ where, pii: false });
        for (const secret of [...SECRETS, ...ENGAGEMENT_SECRETS]) expect({ where, leaked: value.includes(secret) }).toEqual({ where, leaked: false });
        // Phone numbers, bank accounts: no long digit runs in strings.
        expect({ where, digits: /\d[\d\s.-]{8,}\d/.test(value) }).toEqual({ where, digits: false });
        if (key === 'session_referrer') {
          const ref = new URL(value);
          expect(`${ref.origin}`).toBe(value);
        } else {
          // No URL, path or query anywhere else.
          expect({ where, url: /:\/\/|[?&=/@]/.test(value) }).toEqual({ where, url: false });
          // Coarse values only: slugs, codes and buckets, never free text.
          expect({ where, long: value.length <= 64 }).toEqual({ where, long: true });
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
    await act(async () => root?.unmount());
    await mount(createElement(KnowledgesPanel, { locale: 'vi' }));
    await click(host.querySelector('button[aria-expanded]'));
    await typeInto(host.querySelector('input[type="search"]'), SEARCH_TEXT);
    await submit(host.querySelector('form'));
    await act(async () => root?.unmount());
    await mount(createElement(ZueyAiPanel, { locale: 'vi' }));
    await typeInto(host.querySelector('textarea'), CHAT_TEXT);
    await submit(host.querySelector('textarea')?.closest('form'));
    expect(since(start)).toEqual([]);
  });
});
