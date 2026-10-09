import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import type { RuntimeEnv } from '../src/env';
import { adminUpdateBooking, bookingRuntime, capturePaypalBooking, rescheduleBooking, setAvailability } from '../src/lib/booking/store';
import { reconcileSepay } from '../src/lib/members/billing';
import { resolveBillingOrder } from '../src/lib/members/billing-attention';
import { ipHash } from '../src/lib/members/login-tokens';
import { membersRuntime } from '../src/lib/members/runtime';
import { createMemberSession } from '../src/lib/members/session';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { parseDodoReversalEvent, signDodoPayload } from '../src/lib/payments/dodo';
import { parsePaypalCaptureEvent, parsePaypalReversalEvent, resetPaypalTokenCache } from '../src/lib/payments/paypal';
import { ensureReferralProfile } from '../src/lib/referrals/codes';
import { getCommissionBySource, recordReferralCommission } from '../src/lib/referrals/commissions';
import { isDisposableEmail } from '../src/lib/referrals/disposable-domains';
import { assessReferral, payerTextMatches } from '../src/lib/referrals/fraud';
import type { ReferralFraudSnapshot } from '../src/lib/referrals/fraud';
import { runReferralJobs } from '../src/lib/referrals/jobs';
import { appendLedger, balanceCents } from '../src/lib/referrals/ledger';
import { reverseCommission } from '../src/lib/referrals/refunds';
import { POST as holdApi } from '../src/pages/api/v1/booking/hold';
import { POST as bookingCheckoutApi } from '../src/pages/api/v1/booking/[id]/checkout';
import { POST as ordersApi } from '../src/pages/api/v1/billing/orders/index';
import { POST as dodoWebhook } from '../src/pages/api/webhooks/dodo';
import { POST as paypalWebhook } from '../src/pages/api/webhooks/paypal';
import { POST as sepayWebhook } from '../src/pages/api/webhooks/sepay';

const ORIGIN = 'https://zuey.test';
const T0 = Date.parse('2026-10-05T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const SLOT = '2026-10-07T02:00:00.000Z';
const SLOT_END = '2026-10-07T03:30:00.000Z';
const RATE = 26350;
const DODO_SECRET = `whsec_${btoa('zuey-referral-dodo-secret')}`;
const DODO_BASE = 'https://test.dodopayments.com';
const PAYPAL_BASE = 'https://api-m.sandbox.paypal.com';

let d1: ReturnType<typeof createTestD1>;
let envOverrides: Partial<RuntimeEnv>;

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
async function fakeFetch(input: string): Promise<Response> {
  if (input === `${DODO_BASE}/discounts`) return json({ discount_id: 'dsc_1', code: 'REFCODE1' });
  if (input === `${DODO_BASE}/checkouts`) return json({ session_id: 'cks_1', checkout_url: 'https://test.checkout.dodopayments.com/session/cks_1' });
  if (input === `${PAYPAL_BASE}/v1/oauth2/token`) return json({ access_token: 'pp_access', expires_in: 32400 });
  if (input === `${PAYPAL_BASE}/v2/checkout/orders`) {
    return json({ id: 'ORDER-1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1' }] });
  }
  if (input === `${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`) return json({ verification_status: 'SUCCESS' });
  if (input === 'https://api.resend.com/emails') return json({ id: 'email_1' });
  return json({ error: `unexpected ${input}` }, 500);
}

function env(): RuntimeEnv {
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
    ...envOverrides,
  };
}

function ctx(opts: { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; params?: Record<string, string> }): APIContext {
  const headers = new Headers(opts.headers ?? {});
  const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined && !headers.has('content-type')) headers.set('Content-Type', 'application/json');
  const request = new Request(`${ORIGIN}/api/test`, { method: opts.method ?? 'GET', headers, body });
  // Handlers only read request/params/locals; a full APIContext is not constructible in tests.
  const partial = { request, params: opts.params ?? {}, url: new URL(request.url), locals: { runtime: { env: env() } } };
  return partial as unknown as APIContext;
}

async function dataOf(res: Response): Promise<unknown> {
  return field(await res.json(), 'data');
}

interface Member { userId: string; cookie: string }

async function member(email: string): Promise<Member> {
  const { user } = await findOrCreateVerifiedUser(d1, { email });
  const { token } = await createMemberSession(d1, user.id);
  return { userId: user.id, cookie: `zuey_member=${token}` };
}

async function referrer(email: string, discount = 15): Promise<{ id: string; code: string }> {
  const { user } = await findOrCreateVerifiedUser(d1, { email });
  const { code } = await ensureReferralProfile(d1, user.id);
  await d1.prepare('UPDATE referral_profiles SET discount_percent = ?, admin_enabled = 1 WHERE user_id = ?').bind(discount, user.id).run();
  return { id: user.id, code };
}

/** Creates a SePay order through the API; returns its id, code and amount. */
async function sepayOrder(m: Member, body: Record<string, unknown>): Promise<{ id: string; code: string; amount: number }> {
  const res = await ordersApi(ctx({ method: 'POST', body, headers: { cookie: m.cookie, Origin: ORIGIN } }));
  expect(res.status).toBe(201);
  const data = await dataOf(res);
  const code = String(field(data, 'code'));
  const row = await d1.prepare('SELECT id FROM billing_orders WHERE code = ?').bind(code).first<{ id: string }>();
  return { id: row?.id ?? '', code, amount: Number(field(data, 'amount_vnd')) };
}

async function sepayTransfer(eventId: string, content: string, amount: number): Promise<unknown> {
  const res = await sepayWebhook(ctx({
    method: 'POST', headers: { Authorization: 'Apikey sepay-key' },
    body: { id: eventId, transferType: 'in', transferAmount: amount, content, referenceCode: `FT${eventId}` },
  }));
  return field(await dataOf(res), 'outcome');
}

async function commissionCount(): Promise<number> {
  return Number((await d1.prepare('SELECT COUNT(*) AS n FROM referral_commissions').first<{ n: number }>())?.n ?? 0);
}

let webhookSeq = 0;

async function sendDodo(type: string, data: Record<string, unknown>): Promise<unknown> {
  const body = JSON.stringify({ business_id: 'bus_test', type, timestamp: new Date(T0).toISOString(), data });
  const id = `msg_${++webhookSeq}`;
  const ts = String(Math.floor(T0 / 1000));
  const signature = await signDodoPayload(DODO_SECRET, id, ts, body);
  const res = await dodoWebhook(ctx({ method: 'POST', rawBody: body, headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signature } }));
  return field(await dataOf(res), 'outcome');
}

const PAYPAL_HEADERS = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
  'paypal-transmission-id': 'tx-1',
  'paypal-transmission-sig': 'sig-abc',
  'paypal-transmission-time': '2026-10-05T00:05:00Z',
};

async function sendPaypal(payload: Record<string, unknown>): Promise<unknown> {
  const res = await paypalWebhook(ctx({ method: 'POST', rawBody: JSON.stringify(payload), headers: PAYPAL_HEADERS }));
  return field(await dataOf(res), 'outcome');
}

beforeEach(async () => {
  d1 = createTestD1();
  envOverrides = {};
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

describe('SePay commission capture', () => {
  it('creates exactly one pending commission on the collected USD amount, idempotent across webhook retries', async () => {
    const ref = await referrer('ref@example.com', 15);
    const m = await member('lan@example.com');
    const order = await sepayOrder(m, { plan: 'combo', months: 12, referral_code: ref.code });
    expect(order.amount).toBe(4_089_000);
    expect(await sepayTransfer('9001', `NGUYEN THI LAN chuyen tien ${order.code}`, order.amount)).toBe('paid');
    expect(await sepayTransfer('9001', `NGUYEN THI LAN chuyen tien ${order.code}`, order.amount)).toBe('duplicate_event');
    expect(await sepayTransfer('9002', `again ${order.code}`, order.amount)).toBe('already_paid');
    expect(await commissionCount()).toBe(1);

    const c = await getCommissionBySource(d1, 'billing_order', order.id);
    expect(c?.status).toBe('pending');
    expect(c?.referrer_user_id).toBe(ref.id);
    expect(c?.referee_user_id).toBe(m.userId);
    expect(c?.base_amount_cents).toBe(Math.round((4_089_000 / RATE) * 100));
    expect(c?.commission_percent).toBe(5);
    expect(c?.commission_cents).toBe(Math.floor((Math.round((4_089_000 / RATE) * 100) * 5) / 100));
    expect(c?.hold_until).toBe(new Date(T0 + 30 * DAY).toISOString());
    expect(c?.provider_payment_id).toBe('FT9001');
    // Pending is not balance: nothing is in the ledger until approval.
    expect(await balanceCents(d1, ref.id)).toBe(0);
    const event = await d1.prepare("SELECT action FROM referral_events WHERE action LIKE 'commission.%'").first<{ action: string }>();
    expect(event?.action).toBe('commission.pending');
  });

  it('records no commission for an order without a referral', async () => {
    const m = await member('lan@example.com');
    const order = await sepayOrder(m, { plan: 'ai' });
    expect(await sepayTransfer('9100', order.code, order.amount)).toBe('paid');
    expect(await commissionCount()).toBe(0);
  });

  it('blocks self-referral and a referee who already paid; commission is first order only', async () => {
    const ref = await referrer('ref@example.com', 10);
    const m = await member('lan@example.com');
    const first = await sepayOrder(m, { plan: 'ai', referral_code: ref.code });
    expect(await sepayTransfer('9201', first.code, first.amount)).toBe('paid');
    const second = await sepayOrder(m, { plan: 'knowledges' });
    // A stale referral snapshot on a later order (e.g. created before the first was paid) never earns twice.
    await d1.prepare('UPDATE billing_orders SET referrer_user_id = ?, referral_rate = 20, referral_discount_percent = 10, referral_commission_percent = 10 WHERE id = ?')
      .bind(ref.id, second.id).run();
    expect(await sepayTransfer('9202', second.code, second.amount)).toBe('paid');
    expect((await getCommissionBySource(d1, 'billing_order', first.id))?.status).toBe('pending');
    const repeat = await getCommissionBySource(d1, 'billing_order', second.id);
    expect(repeat?.status).toBe('blocked');
    expect(repeat?.review_reasons).toEqual(['referee_previously_paid']);

    // A snapshot pointing at the payer themself (e.g. a forged or stale row) is blocked, not paid.
    const self = await member('self@example.com');
    const own = await sepayOrder(self, { plan: 'ai' });
    await d1.prepare('UPDATE billing_orders SET referrer_user_id = ?, referral_rate = 20, referral_discount_percent = 0, referral_commission_percent = 20 WHERE id = ?')
      .bind(self.userId, own.id).run();
    expect(await sepayTransfer('9203', own.code, own.amount)).toBe('paid');
    const blocked = await getCommissionBySource(d1, 'billing_order', own.id);
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.review_reasons).toContain('self_referral');
  });

  it('queues soft signals for review: disposable email, payer named like the referrer', async () => {
    const ref = await referrer('ref@example.com', 10);
    const disposable = await member('someone@yopmail.com');
    const o1 = await sepayOrder(disposable, { plan: 'ai', referral_code: ref.code });
    expect(await sepayTransfer('9301', o1.code, o1.amount)).toBe('paid');
    const c1 = await getCommissionBySource(d1, 'billing_order', o1.id);
    expect(c1?.status).toBe('review');
    expect(c1?.review_reasons).toEqual(['disposable_email']);

    const now = new Date(T0).toISOString();
    await d1.prepare("INSERT INTO referral_payout_profiles (user_id, method, full_name, bank_account, status, created_at, updated_at) VALUES (?, 'vn_bank', 'Trần Văn Đức', '9704123456', 'verified', ?, ?)")
      .bind(ref.id, now, now).run();
    const m = await member('lan@example.com');
    const o2 = await sepayOrder(m, { plan: 'ai', referral_code: ref.code });
    expect(await sepayTransfer('9302', `TRAN VAN DUC chuyen khoan ${o2.code}`, o2.amount)).toBe('paid');
    const c2 = await getCommissionBySource(d1, 'billing_order', o2.id);
    expect(c2?.status).toBe('review');
    expect(c2?.review_reasons).toEqual(['payer_matches_referrer']);
  });
});

describe('fraud verdict (pure)', () => {
  const clean: ReferralFraudSnapshot = {
    selfReferral: false, refereePreviouslyPaid: false, referrerLocked: false, refereeEmail: 'a@example.com',
    sharedIp: false, payerMatchesReferrer: false, boundSignupsLast24h: 0,
  };

  it('blocks hard signals, reviews soft ones and passes clean referrals', () => {
    expect(assessReferral(clean)).toEqual({ verdict: 'ok', reasons: [] });
    expect(assessReferral({ ...clean, referrerLocked: true, sharedIp: true })).toEqual({ verdict: 'block', reasons: ['referrer_locked', 'shared_ip'] });
    expect(assessReferral({ ...clean, sharedIp: true })).toEqual({ verdict: 'review', reasons: ['shared_ip'] });
    expect(assessReferral({ ...clean, boundSignupsLast24h: 5 }).verdict).toBe('ok');
    expect(assessReferral({ ...clean, boundSignupsLast24h: 6 })).toEqual({ verdict: 'review', reasons: ['signup_velocity'] });
    expect(assessReferral({ ...clean, refereeEmail: 'x@mail.yopmail.com' }).reasons).toEqual(['disposable_email']);
  });

  it('matches payer text by folded full name or account number only', () => {
    const payout = { fullName: 'Nguyễn Thị Hằng', bankAccount: '0123-456-789' };
    expect(payerTextMatches('NGUYEN THI HANG CK ZSB123', payout)).toBe(true);
    expect(payerTextMatches('tu tk 0123456789 ZSB123', payout)).toBe(true);
    expect(payerTextMatches('NGUYEN THI HANGA', payout)).toBe(false);
    expect(payerTextMatches('ZSB123', { fullName: 'Hang', bankAccount: null })).toBe(false);
    expect(isDisposableEmail('a@gmail.com')).toBe(false);
  });
});

describe('Dodo commission and refunds', () => {
  async function paidCard(): Promise<{ cardId: string; referrerId: string }> {
    const ref = await referrer('ref@example.com', 15);
    const m = await member('lan@example.com');
    const res = await ordersApi(ctx({ method: 'POST', body: { plan: 'combo', provider: 'dodo', referral_code: ref.code }, headers: { cookie: m.cookie, Origin: ORIGIN } }));
    const cardId = String(field(await dataOf(res), 'id'));
    const metadata = { user_id: m.userId, plan: 'combo', card_ref: cardId };
    const payment = {
      payload_type: 'Payment', payment_id: 'pay_first', subscription_id: 'sub_1', total_amount: 1777, tax: 162, currency: 'USD', status: 'succeeded',
      customer: { customer_id: 'cus_1', email: 'lan@example.com' }, metadata,
    };
    expect(await sendDodo('payment.succeeded', payment)).toBe('updated');
    // A renewal must not create a second commission.
    expect(await sendDodo('payment.succeeded', { ...payment, payment_id: 'pay_renewal', total_amount: 2090, tax: 190 })).toBe('updated');
    return { cardId, referrerId: ref.id };
  }

  it('captures the commission on the first payment net of tax, and reverses it on refund.succeeded', async () => {
    const { cardId } = await paidCard();
    expect(await commissionCount()).toBe(1);
    const c = await getCommissionBySource(d1, 'card_subscription', cardId);
    expect(c?.status).toBe('pending');
    expect(c?.base_amount_cents).toBe(1615);
    expect(c?.commission_cents).toBe(80);
    expect(c?.provider_payment_id).toBe('pay_first');

    // A refund of a renewal does not touch the first-order commission.
    expect(await sendDodo('refund.succeeded', { payload_type: 'Refund', refund_id: 'rfd_0', payment_id: 'pay_renewal', amount: 2090, currency: 'USD' })).toBe('ignored');
    expect(await sendDodo('refund.succeeded', { payload_type: 'Refund', refund_id: 'rfd_1', payment_id: 'pay_first', amount: 1777, currency: 'USD', is_partial: false })).toBe('reversed');
    expect((await getCommissionBySource(d1, 'card_subscription', cardId))?.status).toBe('reversed');
    expect(await sendDodo('refund.succeeded', { payload_type: 'Refund', refund_id: 'rfd_1', payment_id: 'pay_first', amount: 1777, currency: 'USD' })).toBe('already_reversed');
  });

  it('reverses on dispute.opened and parses only refund/dispute events', async () => {
    const { cardId } = await paidCard();
    expect(await sendDodo('dispute.opened', { payload_type: 'Dispute', dispute_id: 'dsp_1', payment_id: 'pay_first', amount: '1777', currency: 'USD' })).toBe('reversed');
    expect((await getCommissionBySource(d1, 'card_subscription', cardId))?.status).toBe('reversed');
    expect(parseDodoReversalEvent({ type: 'dispute.won', data: { payment_id: 'pay_first' } })).toBeNull();
    expect(parseDodoReversalEvent({ type: 'refund.succeeded', data: {} })).toBeNull();
  });
});

describe('ledger reversal after approval', () => {
  it('appends one negative line for an approved commission, and carries a negative balance after payout', async () => {
    const ref = await referrer('ref@example.com', 10);
    const m = await member('lan@example.com');
    const order = await sepayOrder(m, { plan: 'combo', months: 12, referral_code: ref.code });
    await sepayTransfer('9401', order.code, order.amount);
    const c = await getCommissionBySource(d1, 'billing_order', order.id);
    if (!c) throw new Error('commission missing');
    // Approval (daily job) credits the ledger; the monthly close pays the balance out.
    await d1.prepare("UPDATE referral_commissions SET status = 'approved', approved_at = ? WHERE id = ?").bind(new Date(T0).toISOString(), c.id).run();
    await appendLedger(d1, { referrerUserId: ref.id, kind: 'commission', amountCents: c.commission_cents, commissionId: c.id });
    await appendLedger(d1, { referrerUserId: ref.id, kind: 'payout', amountCents: -c.commission_cents, payoutId: 'pay_2026_10' });
    expect(await balanceCents(d1, ref.id)).toBe(0);

    const first = await reverseCommission(d1, { commissionId: c.id }, 'admin_refund', 'admin:ops');
    expect(first.outcome).toBe('reversed');
    expect(first.ledger_reversed).toBe(true);
    expect(first.commission?.status).toBe('reversed');
    expect(await balanceCents(d1, ref.id)).toBe(-c.commission_cents);

    const again = await reverseCommission(d1, { sourceKind: 'billing_order', sourceId: order.id }, 'admin_refund');
    expect(again.outcome).toBe('already_reversed');
    expect(again.ledger_reversed).toBe(false);
    expect(await balanceCents(d1, ref.id)).toBe(-c.commission_cents);
    const lines = await d1.prepare("SELECT COUNT(*) AS n FROM referral_ledger WHERE kind = 'reversal'").first<{ n: number }>();
    expect(lines?.n).toBe(1);
    const audit = await d1.prepare("SELECT actor FROM referral_events WHERE action = 'commission.reversed'").first<{ actor: string }>();
    expect(audit?.actor).toBe('admin:ops');
    expect((await reverseCommission(d1, { commissionId: 'rcm_missing' }, 'x')).outcome).toBe('not_found');
  });
});

describe('booking commissions and PayPal refunds', () => {
  async function paypalBooking(): Promise<{ id: string; referrerId: string }> {
    const ref = await referrer('ref@example.com', 10);
    const holdRes = await holdApi(ctx({ method: 'POST', body: { slot_start: SLOT, name: 'Lan', email: 'lan@example.com', payment_method: 'paypal', referral_code: ref.code } }));
    const held = await dataOf(holdRes);
    const id = String(field(field(held, 'booking'), 'id'));
    await bookingCheckoutApi(ctx({ method: 'POST', body: { token: field(held, 'manage_token') }, params: { id } }));
    const outcome = await sendPaypal({
      id: 'WH-CAPTURE', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource_type: 'capture',
      resource: { id: 'CAPTURE-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1899.05' }, custom_id: id, supplementary_data: { related_ids: { order_id: 'ORDER-1' } } },
    });
    expect(outcome).toBe('confirmed');
    return { id, referrerId: ref.id };
  }

  const refunded = (customId: string | null): Record<string, unknown> => ({
    id: 'WH-REFUND', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource_type: 'refund',
    resource: {
      id: 'REFUND-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1899.05' }, ...(customId ? { custom_id: customId } : {}),
      links: [{ rel: 'up', method: 'GET', href: `${PAYPAL_BASE}/v2/payments/captures/CAPTURE-1` }],
    },
  });

  it('holds a booking commission until slot end + 30 days and reverses it on PAYMENT.CAPTURE.REFUNDED', async () => {
    const { id, referrerId } = await paypalBooking();
    const c = await getCommissionBySource(d1, 'booking', id);
    // Guest emails are unverified: booking commissions always wait for an admin decision.
    expect(c?.status).toBe('review');
    expect(c?.review_reasons).toEqual(['booking_manual_review']);
    expect(c?.referrer_user_id).toBe(referrerId);
    expect(c?.referee_email).toBe('lan@example.com');
    expect(c?.base_amount_cents).toBe(189_905);
    expect(c?.commission_cents).toBe(9495);
    expect(c?.hold_until).toBe(new Date(Date.parse(SLOT_END) + 30 * DAY).toISOString());

    // The refund event is not a capture: it never confirms or re-pays anything.
    expect(parsePaypalCaptureEvent(refunded(null))).toBeNull();
    expect(parsePaypalReversalEvent(refunded(null))).toEqual({ eventId: 'WH-REFUND', eventType: 'PAYMENT.CAPTURE.REFUNDED', kind: 'refund', captureId: 'CAPTURE-1', customId: null });
    expect(await sendPaypal(refunded(null))).toBe('reversed');
    expect((await getCommissionBySource(d1, 'booking', id))?.status).toBe('reversed');
    const booking = await d1.prepare('SELECT status FROM bookings WHERE id = ?').bind(id).first<{ status: string }>();
    expect(booking?.status).toBe('confirmed');
    expect(await sendPaypal(refunded(id))).toBe('already_reversed');
  });

  it('reverses on CUSTOMER.DISPUTE.CREATED matched by the disputed capture id', async () => {
    const { id } = await paypalBooking();
    const outcome = await sendPaypal({
      id: 'WH-DISPUTE', event_type: 'CUSTOMER.DISPUTE.CREATED', resource_type: 'dispute',
      resource: { dispute_id: 'PP-D-1', disputed_transactions: [{ seller_transaction_id: 'CAPTURE-1' }] },
    });
    expect(outcome).toBe('reversed');
    expect((await getCommissionBySource(d1, 'booking', id))?.status).toBe('reversed');
  });

  it('confirms a SePay booking even when the commission cannot be computed, and audits the failure', async () => {
    const ref = await referrer('ref@example.com', 10);
    const holdRes = await holdApi(ctx({ method: 'POST', body: { slot_start: SLOT, name: 'Lan', email: 'lan@example.com', payment_method: 'sepay', referral_code: ref.code } }));
    const held = await dataOf(holdRes);
    const code = String(field(field(held, 'booking'), 'code'));
    const id = String(field(field(held, 'booking'), 'id'));
    // A hold without a rate snapshot (held before the snapshot existed) and no configured rate cannot convert.
    await d1.prepare('UPDATE bookings SET usd_vnd_rate = NULL WHERE id = ?').bind(id).run();
    envOverrides = { USD_VND_RATE: undefined };
    const res = await sepayWebhook(ctx({
      method: 'POST', headers: { Authorization: 'Apikey sepay-key' },
      body: { id: 'sp-1', transferType: 'in', transferAmount: 49_400_000, content: `ZBK${code}`, referenceCode: 'FT1' },
    }));
    expect(field(await dataOf(res), 'outcome')).toBe('confirmed');
    expect(await getCommissionBySource(d1, 'booking', id)).toBeNull();
    const failed = await d1.prepare("SELECT detail FROM referral_events WHERE action = 'commission.failed'").first<{ detail: string }>();
    expect(failed?.detail).toContain(id);

    // With the rate configured the same booking converts VND at today's rate.
    envOverrides = {};
    const recorded = await recordReferralCommission(d1, env(), { kind: 'booking', id });
    expect(recorded.created).toBe(true);
    expect(recorded.commission?.base_amount_cents).toBe(Math.round((49_400_000 / RATE) * 100));
  });
});

describe('fraud signals from sign-in IPs, binding windows and provider payer details', () => {
  it('flags a referee who entered the code from an IP the referrer signed in from (member session)', async () => {
    const ref = await referrer('ref@example.com', 10);
    const ip = { 'cf-connecting-ip': '198.51.100.23' };
    // The referrer signed in (e.g. Google) from this IP: only the session records it, no magic-link token.
    await createMemberSession(d1, ref.id, undefined, await ipHash(env(), new Request(ORIGIN, { headers: ip })));
    const m = await member('lan@example.com');
    const res = await ordersApi(ctx({ method: 'POST', body: { plan: 'ai', referral_code: ref.code }, headers: { cookie: m.cookie, Origin: ORIGIN, ...ip } }));
    expect(res.status).toBe(201);
    const bound = await d1.prepare('SELECT referred_by_user_id, referral_signup_ip_hash FROM users WHERE id = ?').bind(m.userId).first<{ referred_by_user_id: string; referral_signup_ip_hash: string | null }>();
    expect(bound?.referred_by_user_id).toBe(ref.id);
    expect(bound?.referral_signup_ip_hash).toBeTruthy();
    const code = String(field(await dataOf(res), 'code'));
    const order = await d1.prepare('SELECT id, amount_vnd FROM billing_orders WHERE code = ?').bind(code).first<{ id: string; amount_vnd: number }>();
    expect(await sepayTransfer('9501', code, order?.amount_vnd ?? 0)).toBe('paid');
    const c = await getCommissionBySource(d1, 'billing_order', order?.id ?? '');
    expect(c?.status).toBe('review');
    expect(c?.review_reasons).toEqual(['shared_ip']);
  });

  it('counts accounts bound around the referee’s own binding time, however late they pay', async () => {
    const ref = await referrer('ref@example.com', 10);
    const m = await member('lan@example.com');
    const boundAt = new Date(T0 - 20 * DAY).toISOString();
    const farm = [m.userId];
    for (let i = 0; i < 5; i++) farm.push((await findOrCreateVerifiedUser(d1, { email: `farm${i}@example.com` })).user.id);
    for (const id of farm) await d1.prepare('UPDATE users SET referred_by_user_id = ?, referred_at = ? WHERE id = ?').bind(ref.id, boundAt, id).run();
    const order = await sepayOrder(m, { plan: 'ai' });
    expect(await sepayTransfer('9502', order.code, order.amount)).toBe('paid');
    const c = await getCommissionBySource(d1, 'billing_order', order.id);
    expect(c?.status).toBe('review');
    expect(c?.review_reasons).toEqual(['signup_velocity']);
  });

  it('feeds the SePay reconcile transfer content into the payer check', async () => {
    const ref = await referrer('ref@example.com', 10);
    const stamp = new Date(T0).toISOString();
    await d1.prepare("INSERT INTO referral_payout_profiles (user_id, method, full_name, bank_account, status, created_at, updated_at) VALUES (?, 'vn_bank', 'Trần Văn Đức', '9704123456', 'verified', ?, ?)")
      .bind(ref.id, stamp, stamp).run();
    const m = await member('lan@example.com');
    const order = await sepayOrder(m, { plan: 'ai', referral_code: ref.code });
    envOverrides = { SEPAY_API_TOKEN: 'sepay-api' };
    const transactions = [{ id: 7001, amount_in: String(order.amount), transaction_content: `TRAN VAN DUC chuyen tien ${order.code}`, reference_number: 'FT7001' }];
    membersRuntime.fetch = async (input: string) => input.startsWith('https://my.sepay.vn/') ? json({ transactions }) : fakeFetch(input);
    const result = await reconcileSepay(d1, env());
    expect(result.results[0]?.outcome).toBe('paid');
    expect((await getCommissionBySource(d1, 'billing_order', order.id))?.review_reasons).toEqual(['payer_matches_referrer']);
  });
});

describe('commission capture on admin actions and the recapture job', () => {
  async function sepayBookingHold(code: string): Promise<{ id: string; code: string; token: string }> {
    const held = await dataOf(await holdApi(ctx({ method: 'POST', body: { slot_start: SLOT, name: 'Lan', email: 'lan@example.com', payment_method: 'sepay', referral_code: code } })));
    return { id: String(field(field(held, 'booking'), 'id')), code: String(field(field(held, 'booking'), 'code')), token: String(field(held, 'manage_token')) };
  }

  it('captures the commission when an admin activates a flagged referred order', async () => {
    const ref = await referrer('ref@example.com', 10);
    const m = await member('lan@example.com');
    const order = await sepayOrder(m, { plan: 'ai', referral_code: ref.code });
    await d1.prepare("UPDATE billing_orders SET status = 'needs_attention', attention_reason = 'amount_mismatch' WHERE id = ?").bind(order.id).run();
    expect((await resolveBillingOrder(d1, env(), order.code, { action: 'activate', note: null }, 'boss@example.com')).outcome).toBe('activated');
    expect((await getCommissionBySource(d1, 'billing_order', order.id))?.status).toBe('pending');
  });

  it('captures on an admin-resolved booking and reverses on an admin cancel', async () => {
    const ref = await referrer('ref@example.com', 10);
    const hold = await sepayBookingHold(ref.code);
    await d1.prepare("UPDATE bookings SET status = 'needs_attention', attention_reason = 'amount_mismatch' WHERE id = ?").bind(hold.id).run();
    expect((await adminUpdateBooking(d1, env(), hold.id, 'resolve', 'paid by transfer')).status).toBe('confirmed');
    const c = await getCommissionBySource(d1, 'booking', hold.id);
    expect(c?.status).toBe('review');
    expect(c?.review_reasons).toEqual(['booking_manual_review']);

    expect((await adminUpdateBooking(d1, env(), hold.id, 'cancel', null)).status).toBe('cancelled');
    expect((await getCommissionBySource(d1, 'booking', hold.id))?.status).toBe('reversed');
    const event = await d1.prepare("SELECT actor, detail FROM referral_events WHERE action = 'commission.reversed'").first<{ actor: string; detail: string }>();
    expect(event?.actor).toBe('admin');
    expect(event?.detail).toContain('admin_cancel');
  });

  it('converts a SePay booking at the rate snapshotted at hold, and moves the hold after a reschedule', async () => {
    const ref = await referrer('ref@example.com', 10);
    const hold = await sepayBookingHold(ref.code);
    expect((await d1.prepare('SELECT usd_vnd_rate FROM bookings WHERE id = ?').bind(hold.id).first<{ usd_vnd_rate: number }>())?.usd_vnd_rate).toBe(RATE);
    envOverrides = { USD_VND_RATE: '30000' };
    const res = await sepayWebhook(ctx({
      method: 'POST', headers: { Authorization: 'Apikey sepay-key' },
      body: { id: 'sp-2', transferType: 'in', transferAmount: 49_400_000, content: `ZBK${hold.code}`, referenceCode: 'FT2' },
    }));
    expect(field(await dataOf(res), 'outcome')).toBe('confirmed');
    const c = await getCommissionBySource(d1, 'booking', hold.id);
    expect(c?.base_amount_cents).toBe(Math.round((49_400_000 / RATE) * 100));

    const newStart = '2026-10-08T02:00:00.000Z';
    await rescheduleBooking(d1, env(), hold.id, hold.token, newStart);
    const moved = await getCommissionBySource(d1, 'booking', hold.id);
    expect(moved?.hold_until).toBe(new Date(Date.parse('2026-10-08T03:30:00.000Z') + 30 * DAY).toISOString());
  });

  it('recaptures a commission whose capture failed at payment time, but never one refunded before capture', async () => {
    const ref = await referrer('ref@example.com', 10);
    const hold = await sepayBookingHold(ref.code);
    await d1.prepare('UPDATE bookings SET usd_vnd_rate = NULL WHERE id = ?').bind(hold.id).run();
    envOverrides = { USD_VND_RATE: undefined };
    await sepayWebhook(ctx({
      method: 'POST', headers: { Authorization: 'Apikey sepay-key' },
      body: { id: 'sp-3', transferType: 'in', transferAmount: 49_400_000, content: `ZBK${hold.code}`, referenceCode: 'FT3' },
    }));
    expect(await getCommissionBySource(d1, 'booking', hold.id)).toBeNull();
    const stillFailing = await runReferralJobs(d1, env(), T0);
    expect(stillFailing.recapture.status === 'ok' && stillFailing.recapture.failed.length).toBe(1);

    envOverrides = {};
    const repaired = await runReferralJobs(d1, env(), T0);
    expect(repaired.recapture.status === 'ok' && repaired.recapture.created).toBe(1);
    expect((await getCommissionBySource(d1, 'booking', hold.id))?.status).toBe('review');

    // A paid order whose capture failed and that was then refunded must stay without commission.
    const m = await member('mai@example.com');
    const order = await sepayOrder(m, { plan: 'ai', referral_code: ref.code });
    expect(await sepayTransfer('9601', order.code, order.amount)).toBe('paid');
    await d1.prepare("DELETE FROM referral_commissions WHERE source_kind = 'billing_order' AND source_id = ?").bind(order.id).run();
    expect((await reverseCommission(d1, { sourceKind: 'billing_order', sourceId: order.id }, 'admin_refund', 'admin')).outcome).toBe('not_found');
    const after = await runReferralJobs(d1, env(), T0);
    expect(after.recapture.status === 'ok' && after.recapture.created).toBe(0);
    expect(await getCommissionBySource(d1, 'billing_order', order.id)).toBeNull();
  });
});

describe('PayPal payer details', () => {
  it('flags a booking paid from the referrer’s own PayPal account (capture on return)', async () => {
    const ref = await referrer('ref@example.com', 10);
    const held = await dataOf(await holdApi(ctx({ method: 'POST', body: { slot_start: SLOT, name: 'Lan', email: 'lan@example.com', payment_method: 'paypal', referral_code: ref.code } })));
    const id = String(field(field(held, 'booking'), 'id'));
    const token = String(field(held, 'manage_token'));
    await bookingCheckoutApi(ctx({ method: 'POST', body: { token }, params: { id } }));
    const captured = {
      id: 'ORDER-1', status: 'COMPLETED', payer: { email_address: 'Ref@Example.com', name: { given_name: 'Someone', surname: 'Else' } },
      purchase_units: [{ custom_id: id, payments: { captures: [{ id: 'CAPTURE-9', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1899.05' }, custom_id: id }] } }],
    };
    bookingRuntime.fetch = async (input: string) => input === `${PAYPAL_BASE}/v2/checkout/orders/ORDER-1/capture` ? json(captured, 201) : fakeFetch(input);
    expect((await capturePaypalBooking(d1, env(), id, token)).capture_status).toBe('confirmed');
    const c = await getCommissionBySource(d1, 'booking', id);
    expect(c?.status).toBe('review');
    expect(c?.review_reasons).toEqual(['payer_matches_referrer', 'booking_manual_review']);
  });
});
