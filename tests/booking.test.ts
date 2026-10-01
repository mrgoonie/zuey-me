import { beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createApiKey } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { generateSlots } from '../src/lib/booking/availability';
import { zonedTimeToUtc } from '../src/lib/booking/timezone';
import { bookingRuntime, getBookingRow } from '../src/lib/booking/store';
import type { BookingRow } from '../src/lib/booking/store';
import { signPolarPayload } from '../src/lib/payments/polar';
import { GET as slotsApi } from '../src/pages/api/v1/booking/slots';
import { POST as holdApi } from '../src/pages/api/v1/booking/hold';
import { GET as bookingApi } from '../src/pages/api/v1/booking/[id]/index';
import { POST as checkoutApi } from '../src/pages/api/v1/booking/[id]/checkout';
import { POST as rescheduleApi } from '../src/pages/api/v1/booking/[id]/reschedule';
import { PUT as putAvailabilityApi } from '../src/pages/api/v1/booking/availability';
import { GET as adminListApi, POST as adminActionApi } from '../src/pages/api/v1/booking/admin';
import { POST as polarWebhook } from '../src/pages/api/webhooks/polar';
import { POST as sepayWebhook } from '../src/pages/api/webhooks/sepay';
import { bookingMcpModule } from '../src/lib/booking/mcp';
import { bookingOpenApi } from '../src/lib/booking/openapi';

const HCM = 'Asia/Ho_Chi_Minh';
const POLAR_SECRET = `whsec_${btoa('zuey-test-webhook-secret')}`;
// Monday 2026-10-05 00:00 UTC (07:00 in Ho Chi Minh City).
const T0 = Date.parse('2026-10-05T00:00:00.000Z');

interface FetchCall { url: string; init?: RequestInit }

type TestDb = ReturnType<typeof createTestD1>;
let d1: TestDb;
let adminKey: string;
let now: number;
let calls: FetchCall[];

const paymentEnv = (): RuntimeEnv => ({
  DB: d1,
  PUBLIC_SITE_URL: 'https://zuey.test',
  POLAR_ACCESS_TOKEN: 'polar_at',
  POLAR_WEBHOOK_SECRET: POLAR_SECRET,
  POLAR_CONSULTATION_PRODUCT_ID: 'prod_1',
  SEPAY_WEBHOOK_API_KEY: 'sepay-key',
  SEPAY_BANK_ACCOUNT: '0123456789',
  SEPAY_BANK_CODE: 'MBBank',
  CONSULTATION_PRICE_VND: '52000000',
});

const fullEnv = (): RuntimeEnv => ({
  ...paymentEnv(),
  GOOGLE_CLIENT_ID: 'gid',
  GOOGLE_CLIENT_SECRET: 'gsecret',
  GOOGLE_CALENDAR_REFRESH_TOKEN: 'grefresh',
  RESEND_API_KEY: 're_key',
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  calls.push({ url: input, init });
  if (input.includes('/v1/checkouts/')) return json({ id: 'chk_123', url: 'https://polar.test/checkout/chk_123' }, 201);
  if (input.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'g_access' });
  if (input.startsWith('https://www.googleapis.com/calendar/v3/')) {
    return json({ id: 'evt_1', hangoutLink: 'https://meet.google.com/abc-defg-hij' });
  }
  if (input === 'https://api.resend.com/emails') return json({ id: 'email_1' });
  return json({ error: 'unexpected' }, 500);
}

function ctx(opts: {
  env: RuntimeEnv;
  method?: string;
  url?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
}): APIContext {
  const headers = new Headers(opts.headers ?? {});
  let body: string | undefined;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.body !== undefined) body = JSON.stringify(opts.body);
  if (body !== undefined && !headers.has('content-type')) headers.set('Content-Type', 'application/json');
  const request = new Request(opts.url ?? 'http://localhost:4321/api/test', { method: opts.method ?? 'GET', headers, body });
  const partial = { request, params: opts.params ?? {}, locals: { runtime: { env: opts.env } } };
  return partial as unknown as APIContext;
}

interface Envelope { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } }

async function read(res: Response): Promise<Envelope> {
  return (await res.json()) as Envelope;
}

async function setDefaultAvailability(): Promise<void> {
  const rules = [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start_time: '09:00', end_time: '12:00', timezone: HCM, slot_minutes: 90 }));
  const res = await putAvailabilityApi(ctx({ env: { DB: d1 }, method: 'PUT', body: { rules, exceptions: [] }, headers: { Authorization: `Bearer ${adminKey}` } }));
  expect(res.status).toBe(200);
}

async function hold(env: RuntimeEnv, slotStart: string, method: 'polar' | 'sepay' = 'polar'): Promise<Response> {
  return holdApi(ctx({
    env,
    method: 'POST',
    body: { slot_start: slotStart, name: 'Lan Nguyễn', email: 'lan@example.com', company: 'Acme', timezone: 'Europe/Berlin', payment_method: method },
  }));
}

async function holdOk(env: RuntimeEnv, slotStart: string, method: 'polar' | 'sepay' = 'polar'): Promise<{ id: string; token: string; code: string }> {
  const res = await hold(env, slotStart, method);
  const body = await read(res);
  expect(res.status).toBe(201);
  const booking = body.data?.booking;
  const token = body.data?.manage_token;
  if (typeof booking !== 'object' || booking === null || !('id' in booking) || !('code' in booking) || typeof token !== 'string') {
    throw new Error('unexpected hold response');
  }
  return { id: String(booking.id), code: String(booking.code), token };
}

async function polarEvent(env: RuntimeEnv, opts: { bookingId: string; amount: number; eventId?: string; badSignature?: boolean }): Promise<Response> {
  const eventId = opts.eventId ?? `msg_${crypto.randomUUID()}`;
  const body = JSON.stringify({
    type: 'order.paid',
    data: { id: `ord_${eventId}`, total_amount: opts.amount, currency: 'usd', checkout_id: 'chk_123', metadata: { booking_id: opts.bookingId } },
  });
  const ts = String(Math.floor(now / 1000));
  const signature = opts.badSignature ? 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' : await signPolarPayload(POLAR_SECRET, eventId, ts, body);
  return polarWebhook(ctx({
    env,
    method: 'POST',
    rawBody: body,
    headers: { 'webhook-id': eventId, 'webhook-timestamp': ts, 'webhook-signature': signature },
  }));
}

async function row(id: string): Promise<BookingRow> {
  const r = await getBookingRow(d1, id);
  if (!r) throw new Error('booking missing');
  return r;
}

// Slots with default availability: 09:00 and 10:30 Ho Chi Minh time = 02:00Z and 03:30Z daily.
const SLOT_OCT7 = '2026-10-07T02:00:00.000Z'; // ~50h after T0
const SLOT_OCT8 = '2026-10-08T03:30:00.000Z'; // ~75h after T0
const SLOT_OCT6 = '2026-10-06T02:00:00.000Z'; // 26h after T0 (bookable, inside the 48h reschedule window)

beforeEach(async () => {
  d1 = createTestD1();
  adminKey = (await createApiKey('test-admin', 'admin', d1)).key;
  now = T0;
  calls = [];
  bookingRuntime.now = () => now;
  bookingRuntime.fetch = fakeFetch;
  await setDefaultAvailability();
});

describe('timezone conversion', () => {
  it('converts zoned wall time to UTC, including DST gaps and overlaps', () => {
    expect(new Date(zonedTimeToUtc(2026, 10, 5, 9, 0, HCM)).toISOString()).toBe('2026-10-05T02:00:00.000Z');
    expect(new Date(zonedTimeToUtc(2026, 7, 1, 9, 0, 'America/New_York')).toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(new Date(zonedTimeToUtc(2026, 1, 15, 9, 0, 'America/New_York')).toISOString()).toBe('2026-01-15T14:00:00.000Z');
    // Spring-forward gap: 02:30 does not exist, shifts to 03:30 EDT.
    expect(new Date(zonedTimeToUtc(2026, 3, 8, 2, 30, 'America/New_York')).toISOString()).toBe('2026-03-08T07:30:00.000Z');
    // Fall-back overlap: 01:30 resolves to the earlier (EDT) instant.
    expect(new Date(zonedTimeToUtc(2026, 11, 1, 1, 30, 'America/New_York')).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });
});

describe('slot generation', () => {
  it('respects weekday rules in Asia/Ho_Chi_Minh, lead time and exceptions', () => {
    const rules = [{ weekday: 1, start_time: '09:00', end_time: '12:00', timezone: HCM, slot_minutes: 90 }];
    const nowMs = Date.parse('2026-10-01T00:00:00.000Z'); // Thursday
    const slots = generateSlots({ rules, exceptions: [], taken: new Set(), now: nowMs, days: 14 });
    expect(slots.map(s => s.start)).toEqual([
      '2026-10-05T02:00:00.000Z', '2026-10-05T03:30:00.000Z',
      '2026-10-12T02:00:00.000Z', '2026-10-12T03:30:00.000Z',
    ]);
    expect(slots[0].end).toBe('2026-10-05T03:30:00.000Z');

    // Block Monday 12 Oct (whole local day) and mark one slot as taken.
    const exceptions = [{ start_at: '2026-10-11T17:00:00.000Z', end_at: '2026-10-12T17:00:00.000Z' }];
    const filtered = generateSlots({ rules, exceptions, taken: new Set(['2026-10-05T03:30:00.000Z']), now: nowMs, days: 14 });
    expect(filtered.map(s => s.start)).toEqual(['2026-10-05T02:00:00.000Z']);

    // Minimum 24h lead time excludes slots that are too soon.
    const close = generateSlots({ rules, exceptions: [], taken: new Set(), now: Date.parse('2026-10-04T03:00:00.000Z'), days: 7 });
    expect(close[0].start).toBe('2026-10-05T03:30:00.000Z');
  });

  it('serves slots via REST and hides held slots', async () => {
    const res = await slotsApi(ctx({ env: { DB: d1 }, url: 'http://localhost/api/v1/booking/slots?days=3' }));
    const body = await read(res);
    expect(res.status).toBe(200);
    const slots = body.data?.slots;
    expect(Array.isArray(slots)).toBe(true);
    const starts = Array.isArray(slots) ? slots.map(s => (typeof s === 'object' && s !== null && 'start' in s ? s.start : null)) : [];
    expect(starts).toContain(SLOT_OCT6);
    expect(starts).not.toContain('2026-10-05T02:00:00.000Z'); // < 24h lead

    await holdOk(paymentEnv(), SLOT_OCT6);
    const after = await read(await slotsApi(ctx({ env: { DB: d1 }, url: 'http://localhost/api/v1/booking/slots?days=3' })));
    expect(JSON.stringify(after.data)).not.toContain(SLOT_OCT6);
  });
});

describe('holds', () => {
  it('lets exactly one of two concurrent holds win the same slot', async () => {
    const env = paymentEnv();
    const [a, b] = await Promise.all([hold(env, SLOT_OCT7), hold(env, SLOT_OCT7)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect((await read(loser)).error?.code).toBe('slot_taken');
    const count = d1.raw.query("SELECT COUNT(*) AS n FROM bookings WHERE slot_start = ? AND status = 'held'").get(SLOT_OCT7);
    expect(count).toEqual({ n: 1 });
  });

  it('reuses an expired hold lazily', async () => {
    const env = paymentEnv();
    const first = await holdOk(env, SLOT_OCT7);
    expect((await hold(env, SLOT_OCT7)).status).toBe(409);
    now += 16 * 60 * 1000;
    const second = await holdOk(env, SLOT_OCT7);
    expect(second.id).not.toBe(first.id);
    expect((await row(first.id)).status).toBe('expired');
  });

  it('rejects slots outside availability', async () => {
    const res = await hold(paymentEnv(), '2026-10-07T05:00:00.000Z');
    expect(res.status).toBe(409);
    expect((await read(res)).error?.code).toBe('slot_unavailable');
  });

  it('returns 503 payment_unconfigured when Polar credentials are missing', async () => {
    const res = await hold({ DB: d1 }, SLOT_OCT7, 'polar');
    const body = await read(res);
    expect(res.status).toBe(503);
    expect(body.error?.code).toBe('payment_unconfigured');
    expect(body.error?.message).toContain('POLAR_ACCESS_TOKEN');

    // A hold created while configured cannot fake a checkout once credentials disappear.
    const b = await holdOk(paymentEnv(), SLOT_OCT8);
    const checkout = await checkoutApi(ctx({ env: { DB: d1 }, method: 'POST', body: { token: b.token }, params: { id: b.id } }));
    expect(checkout.status).toBe(503);
    expect((await read(checkout)).error?.code).toBe('payment_unconfigured');
  });
});

describe('Polar payments', () => {
  it('rejects a bad signature with 401', async () => {
    const b = await holdOk(fullEnv(), SLOT_OCT7);
    const res = await polarEvent(fullEnv(), { bookingId: b.id, amount: 199900, badSignature: true });
    expect(res.status).toBe(401);
    expect((await row(b.id)).status).toBe('held');
  });

  it('confirms on a valid full payment, creates Meet + emails ICS, and is idempotent on replay', async () => {
    const env = fullEnv();
    const b = await holdOk(env, SLOT_OCT7);
    const checkout = await checkoutApi(ctx({ env, method: 'POST', body: { token: b.token }, params: { id: b.id } }));
    const co = await read(checkout);
    expect(checkout.status).toBe(200);
    expect(co.data?.url).toBe('https://polar.test/checkout/chk_123');
    const polarCall = calls.find(c => c.url.includes('/v1/checkouts/'));
    const polarBody: unknown = JSON.parse(String(polarCall?.init?.body));
    expect(polarBody).toMatchObject({ products: ['prod_1'], customer_email: 'lan@example.com', metadata: { booking_id: b.id } });

    const res = await polarEvent(env, { bookingId: b.id, amount: 199900, eventId: 'msg_full' });
    expect(res.status).toBe(200);
    expect((await read(res)).data?.outcome).toBe('confirmed');
    const confirmed = await row(b.id);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.meet_status).toBe('sent');
    expect(confirmed.email_status).toBe('sent');
    expect(confirmed.meet_url).toBe('https://meet.google.com/abc-defg-hij');

    const calendarCall = calls.find(c => c.url.startsWith('https://www.googleapis.com/calendar/v3/'));
    expect(calendarCall?.url).toContain('conferenceDataVersion=1');
    expect(String(calendarCall?.init?.body)).toContain('hangoutsMeet');
    const emails = calls.filter(c => c.url === 'https://api.resend.com/emails');
    expect(emails.length).toBe(1);
    const emailBody: unknown = JSON.parse(String(emails[0].init?.body));
    if (typeof emailBody !== 'object' || emailBody === null || !('attachments' in emailBody) || !Array.isArray(emailBody.attachments)) {
      throw new Error('missing attachments');
    }
    const att: unknown = emailBody.attachments[0];
    if (typeof att !== 'object' || att === null || !('filename' in att) || !('content' in att) || typeof att.content !== 'string') {
      throw new Error('bad attachment');
    }
    expect(att.filename).toBe('invite.ics');
    const ics = new TextDecoder().decode(Uint8Array.from(atob(att.content), c => c.charCodeAt(0)));
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('DTSTART:20261007T020000Z');
    expect(ics).toContain('DTEND:20261007T033000Z');
    expect(ics).toContain('ORGANIZER;CN="Zuey":mailto:hi@zuey.me');
    expect(ics).toContain('meet.google.com/abc-defg-hij');

    // Replay of the same event: no-op, no second email.
    const replay = await polarEvent(env, { bookingId: b.id, amount: 199900, eventId: 'msg_full' });
    expect(replay.status).toBe(200);
    expect((await read(replay)).data?.outcome).toBe('duplicate_event');
    // A different event for the same booking is also a no-op.
    const second = await polarEvent(env, { bookingId: b.id, amount: 199900, eventId: 'msg_other' });
    expect((await read(second)).data?.outcome).toBe('already_confirmed');
    expect(calls.filter(c => c.url === 'https://api.resend.com/emails').length).toBe(1);
    expect(d1.raw.query('SELECT COUNT(*) AS n FROM payment_events').get()).toEqual({ n: 2 });

    // Guest view exposes Meet link but never the token hash.
    const guest = await bookingApi(ctx({ env, url: `http://localhost/api/v1/booking/${b.id}?token=${encodeURIComponent(b.token)}`, params: { id: b.id } }));
    const gv = await read(guest);
    expect(gv.data?.status).toBe('confirmed');
    expect(gv.data?.meet_url).toBe('https://meet.google.com/abc-defg-hij');
    expect(JSON.stringify(gv.data)).not.toContain('manage_token_hash');
    const wrong = await bookingApi(ctx({ env, url: `http://localhost/api/v1/booking/${b.id}?token=nope`, params: { id: b.id } }));
    expect(wrong.status).toBe(404);
  });

  it('marks insufficient amount as needs_attention', async () => {
    const env = fullEnv();
    const b = await holdOk(env, SLOT_OCT7);
    const res = await polarEvent(env, { bookingId: b.id, amount: 100000 });
    expect((await read(res)).data?.outcome).toBe('needs_attention');
    const r = await row(b.id);
    expect(r.status).toBe('needs_attention');
    expect(r.attention_reason).toBe('amount_mismatch');
    expect(calls.some(c => c.url === 'https://api.resend.com/emails')).toBe(false);
  });

  it('flags payment after hold expiry as late_payment', async () => {
    const env = fullEnv();
    const b = await holdOk(env, SLOT_OCT7);
    now += 20 * 60 * 1000;
    const res = await polarEvent(env, { bookingId: b.id, amount: 199900 });
    expect(res.status).toBe(200);
    const r = await row(b.id);
    expect(r.status).toBe('needs_attention');
    expect(r.attention_reason).toBe('late_payment');
  });

  it('confirms honestly when Google and Resend are not configured', async () => {
    const env = paymentEnv();
    const b = await holdOk(env, SLOT_OCT7);
    await polarEvent(env, { bookingId: b.id, amount: 199900 });
    const r = await row(b.id);
    expect(r.status).toBe('confirmed');
    expect(r.meet_status).toBe('unconfigured');
    expect(r.email_status).toBe('unconfigured');
    expect(r.meet_url).toBeNull();
    expect(calls.length).toBe(0);
  });
});

describe('SePay payments', () => {
  const sepayPayload = (code: string, amount: number, id = 9001) => ({
    id, gateway: 'MBBank', transactionDate: '2026-10-05 07:05:00', accountNumber: '0123456789',
    content: `CK ${`ZBK${code}`.toLowerCase()} thanh toan`, transferType: 'in', transferAmount: amount, referenceCode: 'FT123',
  });

  it('checks the API key and matches the transfer content code', async () => {
    const env = fullEnv();
    const b = await holdOk(env, SLOT_OCT8, 'sepay');
    const co = await read(await checkoutApi(ctx({ env, method: 'POST', body: { token: b.token }, params: { id: b.id } })));
    expect(co.data?.transfer_content).toBe(`ZBK${b.code}`);
    expect(String(co.data?.qr_url)).toContain(`des=ZBK${b.code}`);
    expect(co.data?.amount).toBe(52000000);

    const bad = await sepayWebhook(ctx({ env, method: 'POST', body: sepayPayload(b.code, 52000000), headers: { Authorization: 'Apikey wrong' } }));
    expect(bad.status).toBe(401);

    const unrelated = await sepayWebhook(ctx({ env, method: 'POST', body: { ...sepayPayload(b.code, 52000000, 1), content: 'tien an trua' }, headers: { Authorization: 'Apikey sepay-key' } }));
    expect((await read(unrelated)).data?.outcome).toBe('ignored');
    expect((await row(b.id)).status).toBe('held');

    const ok = await sepayWebhook(ctx({ env, method: 'POST', body: sepayPayload(b.code, 52000000), headers: { Authorization: 'Apikey sepay-key' } }));
    expect(ok.status).toBe(200);
    expect((await read(ok)).data?.outcome).toBe('confirmed');
    expect((await row(b.id)).status).toBe('confirmed');
  });

  it('flags an underpaid transfer', async () => {
    const env = fullEnv();
    const b = await holdOk(env, SLOT_OCT8, 'sepay');
    await checkoutApi(ctx({ env, method: 'POST', body: { token: b.token }, params: { id: b.id } }));
    await sepayWebhook(ctx({ env, method: 'POST', body: sepayPayload(b.code, 1000000), headers: { Authorization: 'Apikey sepay-key' } }));
    const r = await row(b.id);
    expect(r.status).toBe('needs_attention');
    expect(r.attention_reason).toBe('amount_mismatch');
  });
});

describe('reschedule and admin', () => {
  async function confirmedBooking(slot: string): Promise<{ id: string; token: string }> {
    const env = fullEnv();
    const b = await holdOk(env, slot);
    await polarEvent(env, { bookingId: b.id, amount: 199900 });
    expect((await row(b.id)).status).toBe('confirmed');
    return b;
  }

  it('allows one reschedule only, and only with 48h notice on both ends', async () => {
    const env = fullEnv();
    const b = await confirmedBooking(SLOT_OCT7);

    const tooSoon = await rescheduleApi(ctx({ env, method: 'POST', body: { token: b.token, slot_start: SLOT_OCT6 }, params: { id: b.id } }));
    expect(tooSoon.status).toBe(409);

    calls = [];
    const ok = await rescheduleApi(ctx({ env, method: 'POST', body: { token: b.token, slot_start: SLOT_OCT8 }, params: { id: b.id } }));
    expect(ok.status).toBe(200);
    const r = await row(b.id);
    expect(r.slot_start).toBe(SLOT_OCT8);
    expect(r.reschedule_count).toBe(1);
    expect(calls.some(c => c.init?.method === 'PATCH' && c.url.includes('/events/evt_1'))).toBe(true);
    expect(calls.filter(c => c.url === 'https://api.resend.com/emails').length).toBe(1);

    const again = await rescheduleApi(ctx({ env, method: 'POST', body: { token: b.token, slot_start: '2026-10-09T02:00:00.000Z' }, params: { id: b.id } }));
    expect(again.status).toBe(409);
    expect((await read(again)).error?.code).toBe('reschedule_not_allowed');
  });

  it('refuses reschedule when the current session is under 48h away', async () => {
    const env = fullEnv();
    const b = await confirmedBooking(SLOT_OCT6);
    const res = await rescheduleApi(ctx({ env, method: 'POST', body: { token: b.token, slot_start: SLOT_OCT8 }, params: { id: b.id } }));
    expect(res.status).toBe(409);
    expect((await row(b.id)).slot_start).toBe(SLOT_OCT6);
  });

  it('lets admins list and cancel bookings (no automatic refund)', async () => {
    const env = fullEnv();
    const b = await confirmedBooking(SLOT_OCT7);
    const auth = { Authorization: `Bearer ${adminKey}` };
    expect((await adminListApi(ctx({ env, url: 'http://localhost/api/v1/booking/admin' }))).status).toBe(401);
    const list = await read(await adminListApi(ctx({ env, url: 'http://localhost/api/v1/booking/admin?status=confirmed', headers: auth })));
    expect(JSON.stringify(list.data)).toContain(b.id);
    expect(JSON.stringify(list.data)).not.toContain('manage_token_hash');
    const res = await adminActionApi(ctx({ env, method: 'POST', body: { id: b.id, action: 'cancel', note: 'Guest asked; refund manually' }, headers: auth }));
    expect(res.status).toBe(200);
    const r = await row(b.id);
    expect(r.status).toBe('cancelled');
    expect(r.admin_note).toBe('Guest asked; refund manually');
  });

  it('exposes MCP tools and an OpenAPI fragment', async () => {
    expect(bookingMcpModule.tools.map(t => t.name)).toEqual(['booking_slots', 'booking_list', 'availability_get', 'availability_set', 'booking_update_status']);
    let adminChecks = 0;
    const mcpCtx = {
      request: new Request('http://localhost/api/mcp'),
      env: { DB: d1 },
      d1,
      requireAdmin: async () => { adminChecks++; },
      isAdmin: async () => true,
    };
    const slots = await bookingMcpModule.call('booking_slots', { days: 3 }, mcpCtx);
    expect(JSON.stringify(slots)).toContain(SLOT_OCT6);
    await bookingMcpModule.call('availability_get', {}, mcpCtx);
    expect(adminChecks).toBe(1);
    expect(Object.keys(bookingOpenApi.paths)).toContain('/api/webhooks/polar');
    expect(Object.keys(bookingOpenApi.paths)).toContain('/api/v1/booking/{id}/reschedule');
  });
});
