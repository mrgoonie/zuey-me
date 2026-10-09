import type { D1DatabaseLike } from '../../db/store';
import { hashString } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { authenticateAdmin } from '../auth';
import { AppError } from '../http';
import type { FetchLike } from '../integrations/google-calendar';
import { createMeetEvent, rescheduleMeetEvent } from '../integrations/google-calendar';
import { sendEmail } from '../integrations/resend';
import { capturePaypalOrder, createPaypalOrder, missingPaypalConfig } from '../payments/paypal';
import type { PaypalReversalEvent } from '../payments/paypal';
import { missingSepayConfig, parseVndPrice, transferContent, vietQrTransfer } from '../payments/sepay';
import type { SepayTransferInfo } from '../payments/sepay';
import { promoWins, readDiscountCode } from '../promos/checkout-discount-code';
import type { InvoiceInput } from '../promos/invoice-requests';
import type { PromoCode } from '../promos/promo-codes';
import { activateInvoiceRequest, createInvoiceRequest, parseInvoiceField } from '../promos/invoice-requests';
import { redeemPromo, requirePromoApplicable, reservePromo } from '../promos/promo-redemptions';
import { BOOKING_PRICE_USD_CENTS, resolveCheckoutReferral } from '../referrals/checkout';
import { parseUsdVndRate } from '../members/plans';
import { captureReferralCommission, rescheduleBookingCommissionHold } from '../referrals/commissions';
import { applyPercent } from '../referrals/rates';
import type { ReversalOutcome } from '../referrals/refunds';
import { reverseCommission } from '../referrals/refunds';
import type { AvailabilityException, AvailabilityRule, Slot } from './availability';
import {
  DEFAULT_SLOT_MINUTES,
  HOLD_MS,
  RESCHEDULE_MIN_NOTICE_MS,
  SLOT_HORIZON_DAYS,
  generateSlots,
} from './availability';
import { buildIcs, utf8ToBase64 } from './ics';
import { DEFAULT_TIMEZONE, isValidTimeZone, parseTimeOfDay } from './timezone';

/** Injectable side effects so tests can control time and outbound HTTP. */
export const bookingRuntime: { fetch: FetchLike; now: () => number } = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
};

export const ORGANIZER_EMAIL = 'hi@zuey.me';
/** One-off consultation price charged on the USD card rail (PayPal): $1,999.00. */
export const CONSULTATION_PRICE_USD_CENTS = BOOKING_PRICE_USD_CENTS;

export type BookingStatus = 'held' | 'confirmed' | 'expired' | 'cancelled' | 'needs_attention';
export type PaymentMethod = 'sepay' | 'paypal';
/** Display order of the rails a guest may choose (only configured ones are offered). */
export const PAYMENT_METHODS: PaymentMethod[] = ['sepay', 'paypal'];

/** The live rail of a stored booking, or null for a retired rail that may remain on historical rows. */
export function paymentMethodOf(row: { payment_method: string }): PaymentMethod | null {
  return PAYMENT_METHODS.find(m => m === row.payment_method) ?? null;
}
export const BOOKING_STATUSES: BookingStatus[] = ['held', 'confirmed', 'expired', 'cancelled', 'needs_attention'];

export interface BookingRow {
  id: string;
  code: string;
  slot_start: string;
  slot_end: string;
  duration_min: number;
  status: BookingStatus;
  hold_expires_at: string;
  guest_name: string;
  guest_email: string;
  company: string | null;
  notes: string | null;
  guest_timezone: string | null;
  /** A PaymentMethod for every new booking; historical rows may still name a retired rail. */
  payment_method: string;
  amount_expected: number | null;
  currency: string | null;
  amount_paid: number | null;
  payment_ref: string | null;
  manage_token_hash: string;
  reschedule_count: number;
  meet_url: string | null;
  calendar_event_id: string | null;
  meet_status: string | null;
  meet_error: string | null;
  email_status: string | null;
  email_error: string | null;
  attention_reason: string | null;
  admin_note: string | null;
  /** Referral snapshot taken when the hold was created (all null without a referral). */
  referrer_user_id: string | null;
  referral_rate: number | null;
  referral_discount_percent: number | null;
  referral_commission_percent: number | null;
  /** List price in the booking's currency (VND for SePay, USD cents for PayPal) before the referral or promo discount. */
  amount_before_referral: number | null;
  referral_ref: string | null;
  /** Promo snapshot (all null without a promo; never together with a referral). */
  promo_code_id: string | null;
  promo_code: string | null;
  promo_discount_percent: number | null;
  created_at: string;
  updated_at: string;
}

export type AdminBookingView = Omit<BookingRow, 'manage_token_hash'>;

export interface GuestBookingView {
  id: string;
  code: string;
  status: BookingStatus;
  slot_start: string;
  slot_end: string;
  duration_min: number;
  hold_expires_at: string;
  guest_name: string;
  guest_email: string;
  guest_timezone: string | null;
  payment_method: string;
  amount_expected: number | null;
  currency: string | null;
  /** Referral discount on the consultation (null without a referral). */
  referral_discount_percent: number | null;
  /** Promo code discount on the consultation (null without a promo). */
  promo_code: string | null;
  promo_discount_percent: number | null;
  meet_url: string | null;
  reschedule_count: number;
  can_reschedule: boolean;
  reschedule_blocked_reason: string | null;
  sepay: SepayTransferInfo | null;
}

// ---------------------------------------------------------------------------
// Infrastructure helpers
// ---------------------------------------------------------------------------

export function requireDb(env: RuntimeEnv): D1DatabaseLike {
  if (!env.DB) throw new AppError(503, 'database_unavailable', 'Booking requires the D1 database binding (DB)');
  return env.DB;
}

export async function requireAdmin(request: Request, d1: D1DatabaseLike): Promise<void> {
  const auth = await authenticateAdmin(request, d1);
  if (!auth.authenticated) {
    throw new AppError(auth.role ? 403 : 401, auth.role ? 'forbidden' : 'unauthorized', auth.error ?? 'Unauthorized');
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function randomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function siteUrl(env: RuntimeEnv): string {
  return (env.PUBLIC_SITE_URL || 'https://zuey.me').replace(/\/+$/, '');
}

function manageUrl(env: RuntimeEnv, id: string, token: string): string {
  return `${siteUrl(env)}/booking/${id}?token=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export interface AvailabilityConfig {
  rules: AvailabilityRule[];
  exceptions: AvailabilityException[];
}

export async function getAvailability(d1: D1DatabaseLike): Promise<AvailabilityConfig> {
  const rules = await d1.prepare(
    'SELECT id, weekday, start_time, end_time, timezone, slot_minutes FROM availability_rules ORDER BY weekday, start_time'
  ).all<AvailabilityRule>();
  const exceptions = await d1.prepare(
    'SELECT id, start_at, end_at, reason FROM availability_exceptions ORDER BY start_at'
  ).all<AvailabilityException>();
  return { rules: rules.results ?? [], exceptions: exceptions.results ?? [] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validates an availability payload from an untrusted caller. */
export function parseAvailabilityInput(body: Record<string, unknown>): AvailabilityConfig {
  const rulesRaw = body.rules;
  const exceptionsRaw = body.exceptions ?? [];
  if (!Array.isArray(rulesRaw) || !Array.isArray(exceptionsRaw)) {
    throw new AppError(400, 'invalid_availability', '`rules` and `exceptions` must be arrays');
  }
  if (rulesRaw.length > 100 || exceptionsRaw.length > 500) {
    throw new AppError(400, 'invalid_availability', 'Too many rules or exceptions');
  }
  const rules = rulesRaw.map((r, i): AvailabilityRule => {
    if (!isRecord(r)) throw new AppError(400, 'invalid_availability', `rules[${i}] must be an object`);
    const weekday = r.weekday;
    const start = typeof r.start_time === 'string' ? r.start_time : '';
    const end = typeof r.end_time === 'string' ? r.end_time : '';
    const tz = typeof r.timezone === 'string' && r.timezone ? r.timezone : DEFAULT_TIMEZONE;
    const slot = r.slot_minutes === undefined ? DEFAULT_SLOT_MINUTES : r.slot_minutes;
    const startMin = parseTimeOfDay(start);
    const endMin = parseTimeOfDay(end);
    if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new AppError(400, 'invalid_availability', `rules[${i}].weekday must be an integer 0-6`);
    }
    if (startMin === null || endMin === null || endMin <= startMin) {
      throw new AppError(400, 'invalid_availability', `rules[${i}] needs HH:MM start_time before end_time`);
    }
    if (!isValidTimeZone(tz)) throw new AppError(400, 'invalid_availability', `rules[${i}].timezone is not a valid IANA zone`);
    if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 15 || slot > 480) {
      throw new AppError(400, 'invalid_availability', `rules[${i}].slot_minutes must be an integer 15-480`);
    }
    return { weekday, start_time: start, end_time: end, timezone: tz, slot_minutes: slot };
  });
  const exceptions = exceptionsRaw.map((e, i): AvailabilityException => {
    if (!isRecord(e)) throw new AppError(400, 'invalid_availability', `exceptions[${i}] must be an object`);
    const s = typeof e.start_at === 'string' ? Date.parse(e.start_at) : NaN;
    const en = typeof e.end_at === 'string' ? Date.parse(e.end_at) : NaN;
    if (Number.isNaN(s) || Number.isNaN(en) || en <= s) {
      throw new AppError(400, 'invalid_availability', `exceptions[${i}] needs ISO start_at before end_at`);
    }
    const reason = typeof e.reason === 'string' ? e.reason.slice(0, 200) : null;
    return { start_at: iso(s), end_at: iso(en), reason };
  });
  return { rules, exceptions };
}

export async function setAvailability(d1: D1DatabaseLike, config: AvailabilityConfig): Promise<AvailabilityConfig> {
  await d1.prepare('DELETE FROM availability_rules').run();
  for (const r of config.rules) {
    await d1.prepare(
      'INSERT INTO availability_rules (weekday, start_time, end_time, timezone, slot_minutes) VALUES (?, ?, ?, ?, ?)'
    ).bind(r.weekday, r.start_time, r.end_time, r.timezone, r.slot_minutes).run();
  }
  await d1.prepare('DELETE FROM availability_exceptions').run();
  for (const e of config.exceptions) {
    await d1.prepare('INSERT INTO availability_exceptions (start_at, end_at, reason) VALUES (?, ?, ?)')
      .bind(e.start_at, e.end_at, e.reason ?? null).run();
  }
  return getAvailability(d1);
}

async function occupiedSlots(d1: D1DatabaseLike, nowIso: string): Promise<Set<string>> {
  const res = await d1.prepare(
    `SELECT slot_start FROM bookings
     WHERE status IN ('confirmed', 'needs_attention') OR (status = 'held' AND hold_expires_at >= ?)`
  ).bind(nowIso).all<{ slot_start: string }>();
  return new Set((res.results ?? []).map(r => r.slot_start));
}

export async function listSlots(d1: D1DatabaseLike, opts: { from?: number; days?: number } = {}): Promise<Slot[]> {
  const now = bookingRuntime.now();
  const config = await getAvailability(d1);
  const taken = await occupiedSlots(d1, iso(now));
  return generateSlots({ ...config, taken, now, from: opts.from, days: opts.days ?? SLOT_HORIZON_DAYS });
}

/** Finds a rule-generated slot (ignoring occupancy) that starts at `startIso`. */
async function findRuleSlot(d1: D1DatabaseLike, startIso: string, minLeadMs?: number): Promise<Slot | null> {
  const now = bookingRuntime.now();
  const config = await getAvailability(d1);
  const slots = generateSlots({ ...config, taken: new Set(), now, minLeadMs });
  return slots.find(s => s.start === startIso) ?? null;
}

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

export interface HoldInput {
  slot_start: string;
  name: string;
  email: string;
  company: string | null;
  notes: string | null;
  timezone: string | null;
  payment_method: PaymentMethod;
  /** Raw `discount_code` / `referral_code` fields (promo or referral code); resolved at hold time. */
  codes: { discount_code?: unknown; referral_code?: unknown };
  /** Business invoice request (SePay only). */
  invoice: InvoiceInput | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseHoldInput(body: Record<string, unknown>): HoldInput {
  const str = (k: string): string => (typeof body[k] === 'string' ? String(body[k]).trim() : '');
  const slotMs = Date.parse(str('slot_start'));
  if (Number.isNaN(slotMs)) throw new AppError(400, 'invalid_slot', '`slot_start` must be an ISO date-time');
  const name = str('name');
  if (!name || name.length > 120) throw new AppError(400, 'invalid_name', '`name` is required (max 120 characters)');
  const email = str('email').toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw new AppError(400, 'invalid_email', 'A valid `email` is required');
  const company = str('company');
  if (company.length > 160) throw new AppError(400, 'invalid_company', '`company` max 160 characters');
  const notes = str('notes');
  if (notes.length > 2000) throw new AppError(400, 'invalid_notes', '`notes` max 2000 characters');
  const method = PAYMENT_METHODS.find(m => m === str('payment_method'));
  if (!method) {
    throw new AppError(400, 'invalid_payment_method', `\`payment_method\` must be one of ${PAYMENT_METHODS.join(', ')}`);
  }
  const tz = str('timezone');
  return {
    slot_start: iso(slotMs),
    name,
    email,
    company: company || null,
    notes: notes || null,
    timezone: tz && isValidTimeZone(tz) ? tz : null,
    payment_method: method,
    codes: { discount_code: body.discount_code, referral_code: body.referral_code },
    invoice: parseInvoiceField(body, method),
  };
}

const METHOD_LABEL: Record<PaymentMethod, string> = { sepay: 'SePay', paypal: 'PayPal' };

/** Env names still missing before a payment method can take money. */
export function missingPaymentConfig(env: RuntimeEnv, method: PaymentMethod): string[] {
  return method === 'paypal' ? missingPaypalConfig(env) : missingSepayConfig(env);
}

/** Payment methods whose credentials are configured, in display order (only these are offered). */
export function configuredPaymentMethods(env: RuntimeEnv): PaymentMethod[] {
  return PAYMENT_METHODS.filter(m => missingPaymentConfig(env, m).length === 0);
}

export function assertPaymentConfigured(env: RuntimeEnv, method: PaymentMethod): void {
  const missing = missingPaymentConfig(env, method);
  if (missing.length > 0) {
    throw new AppError(503, 'payment_unconfigured', `${METHOD_LABEL[method]} payments are not configured: missing ${missing.join(', ')}`, { missing });
  }
}

/** Expires stale holds for a slot so the partial unique index frees it (lazy expiry). */
async function expireStaleHolds(d1: D1DatabaseLike, nowIso: string, slotStart?: string): Promise<void> {
  if (slotStart) {
    await d1.prepare(
      "UPDATE bookings SET status = 'expired', updated_at = ? WHERE status = 'held' AND hold_expires_at < ? AND slot_start = ?"
    ).bind(nowIso, nowIso, slotStart).run();
  } else {
    await d1.prepare("UPDATE bookings SET status = 'expired', updated_at = ? WHERE status = 'held' AND hold_expires_at < ?")
      .bind(nowIso, nowIso).run();
  }
}

/** List price of the consultation on a rail: VND (CONSULTATION_PRICE_VND) for SePay, USD cents for PayPal. */
function listPrice(env: RuntimeEnv, method: PaymentMethod): { amount: number | null; currency: 'VND' | 'USD' } {
  return method === 'sepay' ? { amount: parseVndPrice(env), currency: 'VND' } : { amount: CONSULTATION_PRICE_USD_CENTS, currency: 'USD' };
}

/**
 * What the guest owes: the list price snapshotted at hold time (or today's list price) minus the referral
 * discount. Always computed server-side from the snapshot.
 */
export function bookingAmountDue(row: BookingRow, env: RuntimeEnv): { amount: number | null; currency: 'VND' | 'USD' } {
  const method: PaymentMethod = row.payment_method === 'sepay' ? 'sepay' : 'paypal';
  const list = listPrice(env, method);
  const base = row.amount_before_referral ?? list.amount;
  if (base === null) return list;
  const discount = row.promo_code_id ? row.promo_discount_percent ?? 0 : row.referrer_user_id ? row.referral_discount_percent ?? 0 : 0;
  return { amount: applyPercent(base, discount, list.currency), currency: list.currency };
}

/**
 * Holds a slot. A referral (typed code or `zr_ref` cookie, matched against the guest email) is resolved
 * and snapshotted now, so the price shown at checkout cannot change during the hold. Today's USD_VND_RATE is
 * snapshotted too: a VND booking's commission converts at the rate the guest was quoted.
 */
export async function createHold(
  d1: D1DatabaseLike, env: RuntimeEnv, input: HoldInput, opts: { request?: Request } = {}
): Promise<{ booking: GuestBookingView; manage_token: string; manage_url: string }> {
  assertPaymentConfigured(env, input.payment_method);
  const slot = await findRuleSlot(d1, input.slot_start);
  if (!slot) throw new AppError(409, 'slot_unavailable', 'This time is not an open consultation slot');
  const entry = await readDiscountCode(d1, input.codes);
  const resolved = await resolveCheckoutReferral(d1, { email: input.email, enteredCode: entry.referralCode, request: opts.request, product: 'booking' });
  const target = { product: 'booking' as const, email: input.email };
  if (entry.promo) await requirePromoApplicable(d1, entry.promo, target);
  // One discount per order: the larger percent wins, a tie goes to the referral.
  const promo = entry.promo && promoWins(entry.promo.percent, resolved?.discountPercent) ? entry.promo : null;
  const referral = promo ? null : resolved;
  const listAmount = listPrice(env, input.payment_method).amount;

  const now = bookingRuntime.now();
  const nowIso = iso(now);
  await expireStaleHolds(d1, nowIso, slot.start);
  const attention = await d1.prepare("SELECT id FROM bookings WHERE slot_start = ? AND status = 'needs_attention' LIMIT 1")
    .bind(slot.start).first<{ id: string }>();
  if (attention) throw new AppError(409, 'slot_taken', 'This slot was just taken. Please choose another time.');

  const token = randomToken();
  const tokenHash = await hashString(token);
  const id = `bk_${crypto.randomUUID().replace(/-/g, '')}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = randomCode();
    try {
      await d1.prepare(
        `INSERT INTO bookings (id, code, slot_start, slot_end, duration_min, status, hold_expires_at, guest_name, guest_email,
          company, notes, guest_timezone, payment_method, manage_token_hash, reschedule_count, created_at, updated_at,
          referrer_user_id, referral_rate, referral_discount_percent, referral_commission_percent, amount_before_referral, usd_vnd_rate,
          promo_code_id, promo_code, promo_discount_percent)
         VALUES (?, ?, ?, ?, ?, 'held', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, code, slot.start, slot.end, slot.duration_min, iso(now + HOLD_MS), input.name, input.email,
        input.company, input.notes, input.timezone, input.payment_method, tokenHash, nowIso, nowIso,
        referral?.referrerUserId ?? null, referral?.rate ?? null, referral?.discountPercent ?? null, referral?.commissionPercent ?? null,
        referral || promo ? listAmount : null, parseUsdVndRate(env),
        promo?.id ?? null, promo?.code ?? null, promo?.percent ?? null
      ).run();
      let row = await getBookingRow(d1, id);
      if (!row) throw new Error('Inserted booking not found');
      row = await attachHoldExtras(d1, env, row, { promo, invoice: input.invoice, listAmount });
      return {
        booking: toGuestView(row, env, now),
        manage_token: token,
        manage_url: manageUrl(env, id, token),
      };
    } catch (err) {
      if (isUniqueViolation(err) && err instanceof Error && /bookings\.code/.test(err.message)) continue;
      if (isUniqueViolation(err)) throw new AppError(409, 'slot_taken', 'This slot was just taken. Please choose another time.');
      throw err;
    }
  }
  throw new AppError(500, 'code_generation_failed', 'Could not allocate a booking code');
}

/**
 * After the hold row exists: reserves the promo (the hold is deleted when the code was taken meanwhile),
 * records the invoice request, and confirms a hold that a 100% promo made free.
 */
async function attachHoldExtras(
  d1: D1DatabaseLike, env: RuntimeEnv, row: BookingRow,
  extras: { promo: PromoCode | null; invoice: InvoiceInput | null; listAmount: number | null },
): Promise<BookingRow> {
  const due = bookingAmountDue(row, env);
  if (extras.promo) {
    try {
      await reservePromo(d1, {
        promo: extras.promo, kind: 'booking', sourceId: row.id, sourceCode: row.code, target: { product: 'booking', email: row.guest_email },
        currency: due.currency, amountBefore: extras.listAmount ?? 0, amountDue: due.amount ?? 0, expiresAt: row.hold_expires_at,
      });
    } catch (err) {
      await d1.prepare("DELETE FROM bookings WHERE id = ? AND status = 'held'").bind(row.id).run().catch(() => undefined);
      throw err;
    }
  }
  if (extras.invoice && due.amount !== null && due.amount > 0) {
    await createInvoiceRequest(d1, {
      kind: 'booking', sourceId: row.id, sourceCode: row.code, userId: null, invoice: extras.invoice,
      description: `Tư vấn 1:1 — ${row.duration_min} phút`, amountVnd: due.amount,
    });
  }
  if (due.amount !== 0 || !extras.promo) return row;
  const nowIso = iso(bookingRuntime.now());
  await d1.prepare(
    "UPDATE bookings SET status = 'confirmed', amount_expected = 0, currency = ?, amount_paid = 0, payment_ref = ?, updated_at = ? WHERE id = ? AND status = 'held'"
  ).bind(due.currency, `promo:${extras.promo.code}`, nowIso, row.id).run();
  await redeemPromo(d1, 'booking', row.id, 0);
  const confirmed = await getBookingRow(d1, row.id);
  if (!confirmed) return row;
  await fulfilBooking(d1, env, confirmed, 'confirmed');
  return (await getBookingRow(d1, row.id)) ?? confirmed;
}

/** Paid booking: the promo use becomes permanent and an invoice request goes to the admins. */
async function settleBookingExtras(d1: D1DatabaseLike, env: RuntimeEnv, row: BookingRow): Promise<void> {
  try {
    if (row.promo_code_id) await redeemPromo(d1, 'booking', row.id, row.amount_paid);
    if (row.payment_method === 'sepay') await activateInvoiceRequest(d1, env, 'booking', row.id, row.amount_paid);
  } catch (err) {
    console.error(`booking ${row.code} promo/invoice bookkeeping failed:`, err instanceof Error ? err.message : 'unknown');
  }
}

// ---------------------------------------------------------------------------
// Reads and views
// ---------------------------------------------------------------------------

export async function getBookingRow(d1: D1DatabaseLike, id: string): Promise<BookingRow | null> {
  return d1.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first<BookingRow>();
}

/** Loads a booking and checks the guest manage token; 404 for both unknown id and bad token. */
export async function getBookingForGuest(d1: D1DatabaseLike, id: string, token: string | null | undefined): Promise<BookingRow> {
  const row = await getBookingRow(d1, id);
  if (!row || !token || (await hashString(token)) !== row.manage_token_hash) {
    throw new AppError(404, 'booking_not_found', 'Booking not found or manage link invalid');
  }
  return row;
}

function rescheduleBlockedReason(row: BookingRow, now: number): string | null {
  if (row.status !== 'confirmed') return 'not_confirmed';
  if (row.reschedule_count >= 1) return 'already_rescheduled';
  if (Date.parse(row.slot_start) - now < RESCHEDULE_MIN_NOTICE_MS) return 'too_close_to_start';
  return null;
}

export function toGuestView(row: BookingRow, env: RuntimeEnv, now: number): GuestBookingView {
  const blocked = rescheduleBlockedReason(row, now);
  const effectiveStatus: BookingStatus = row.status === 'held' && row.hold_expires_at < iso(now) ? 'expired' : row.status;
  let sepay: SepayTransferInfo | null = null;
  if (effectiveStatus === 'held' && row.payment_method === 'sepay' && missingSepayConfig(env).length === 0) {
    const due = bookingAmountDue(row, env).amount;
    if (due !== null) sepay = vietQrTransfer(env, due, transferContent(row.code));
  }
  return {
    id: row.id,
    code: row.code,
    status: effectiveStatus,
    slot_start: row.slot_start,
    slot_end: row.slot_end,
    duration_min: row.duration_min,
    hold_expires_at: row.hold_expires_at,
    guest_name: row.guest_name,
    guest_email: row.guest_email,
    guest_timezone: row.guest_timezone,
    payment_method: row.payment_method,
    amount_expected: row.amount_expected,
    currency: row.currency,
    referral_discount_percent: row.referrer_user_id ? row.referral_discount_percent : null,
    promo_code: row.promo_code_id ? row.promo_code : null,
    promo_discount_percent: row.promo_code_id ? row.promo_discount_percent : null,
    meet_url: row.status === 'confirmed' ? row.meet_url : null,
    reschedule_count: row.reschedule_count,
    can_reschedule: blocked === null,
    reschedule_blocked_reason: blocked,
    sepay,
  };
}

export function toAdminView(row: BookingRow): AdminBookingView {
  const { manage_token_hash: _hidden, ...rest } = row;
  return rest;
}

export interface BookingListFilter {
  status?: BookingStatus;
  from?: string;
  to?: string;
  limit?: number;
}

export async function listBookings(d1: D1DatabaseLike, filter: BookingListFilter = {}): Promise<AdminBookingView[]> {
  await expireStaleHolds(d1, iso(bookingRuntime.now()));
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filter.status) { where.push('status = ?'); binds.push(filter.status); }
  if (filter.from) { where.push('slot_start >= ?'); binds.push(filter.from); }
  if (filter.to) { where.push('slot_start < ?'); binds.push(filter.to); }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const sql = `SELECT * FROM bookings ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY slot_start DESC LIMIT ${limit}`;
  const res = await d1.prepare(sql).bind(...binds).all<BookingRow>();
  return (res.results ?? []).map(toAdminView);
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export type CheckoutResult =
  | { provider: 'paypal'; url: string; order_id: string; amount_usd_cents: number; expires_at: string }
  | (SepayTransferInfo & { expires_at: string });

export async function startCheckout(d1: D1DatabaseLike, env: RuntimeEnv, id: string, token: string | null): Promise<CheckoutResult> {
  const row = await getBookingForGuest(d1, id, token);
  const now = bookingRuntime.now();
  if (row.status !== 'held' || row.hold_expires_at < iso(now)) {
    throw new AppError(409, 'hold_not_active', 'This hold is no longer active. Please choose a slot again.', { status: row.status });
  }
  const method = paymentMethodOf(row);
  if (!method) {
    throw new AppError(409, 'payment_method_retired', 'This payment method is no longer offered. Please choose a slot again or email hi@zuey.me.');
  }
  assertPaymentConfigured(env, method);
  const due = bookingAmountDue(row, env).amount;
  if (due === null) throw new AppError(503, 'payment_unconfigured', 'The consultation price is not configured', { missing: ['CONSULTATION_PRICE_VND'] });
  if (method === 'paypal') {
    // PayPal appends its own `token` (the order id) to these URLs, so the manage token travels as `manage`.
    const base = `${siteUrl(env)}/booking/${row.id}?manage=${encodeURIComponent(token ?? '')}`;
    const order = await createPaypalOrder(env, {
      bookingId: row.id,
      bookingCode: row.code,
      amountCents: due,
      returnUrl: `${base}&paypal=return`,
      cancelUrl: `${base}&paypal=cancel`,
    }, bookingRuntime.fetch, now);
    await d1.prepare('UPDATE bookings SET amount_expected = ?, currency = ?, payment_ref = ?, updated_at = ? WHERE id = ?')
      .bind(due, 'USD', order.id, iso(now), row.id).run();
    return { provider: 'paypal', url: order.approveUrl, order_id: order.id, amount_usd_cents: due, expires_at: row.hold_expires_at };
  }
  const transfer = vietQrTransfer(env, due, transferContent(row.code));
  await d1.prepare('UPDATE bookings SET amount_expected = ?, currency = ?, updated_at = ? WHERE id = ?')
    .bind(transfer.amount, 'VND', iso(now), row.id).run();
  return { ...transfer, expires_at: row.hold_expires_at };
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export interface PaymentNotice {
  provider: PaymentMethod;
  eventId: string;
  rawType: string;
  amount: number;
  currency: string;
  paymentRef: string | null;
  /** Locates the booking; returns null when it cannot be matched. */
  bookingId: string | null;
  bookingCode?: string | null;
  checkoutId?: string | null;
  /** Bank transfer content or PayPal payer name; used only as a referral fraud signal. */
  payerText?: string | null;
  /** PayPal payer email; used only as a referral fraud signal. */
  payerEmail?: string | null;
}

export type PaymentOutcome =
  | 'duplicate_event'
  | 'unmatched'
  | 'already_confirmed'
  | 'confirmed'
  | 'needs_attention';

function expectedAmount(row: BookingRow, env: RuntimeEnv): { amount: number | null; currency: string } {
  const due = bookingAmountDue(row, env);
  return { amount: row.amount_expected ?? due.amount, currency: due.currency };
}

async function findBookingForPayment(d1: D1DatabaseLike, n: PaymentNotice): Promise<BookingRow | null> {
  if (n.bookingId) {
    const row = await getBookingRow(d1, n.bookingId);
    if (row) return row;
  }
  if (n.bookingCode) {
    const row = await d1.prepare('SELECT * FROM bookings WHERE code = ?').bind(n.bookingCode).first<BookingRow>();
    if (row) return row;
  }
  if (n.checkoutId) {
    return d1.prepare('SELECT * FROM bookings WHERE payment_ref = ?').bind(n.checkoutId).first<BookingRow>();
  }
  return null;
}

async function markAttention(d1: D1DatabaseLike, row: BookingRow, reason: string, n: PaymentNotice, nowIso: string): Promise<void> {
  await d1.prepare(
    `UPDATE bookings SET status = 'needs_attention', attention_reason = ?, amount_paid = ?, payment_ref = COALESCE(?, payment_ref), updated_at = ?
     WHERE id = ? AND status <> 'confirmed'`
  ).bind(reason, n.amount, n.paymentRef, nowIso, row.id).run();
}

/**
 * Applies a verified payment notification. Records the provider event first (idempotency gate),
 * then confirms only an active hold paid in full; everything else is flagged for the admin.
 */
export async function applyPayment(d1: D1DatabaseLike, env: RuntimeEnv, n: PaymentNotice): Promise<{ outcome: PaymentOutcome; booking_id: string | null }> {
  const now = bookingRuntime.now();
  const nowIso = iso(now);
  const row = await findBookingForPayment(d1, n);
  try {
    await d1.prepare(
      'INSERT INTO payment_events (provider, event_id, booking_id, amount, currency, raw_type, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(n.provider, n.eventId, row?.id ?? null, n.amount, n.currency, n.rawType, nowIso).run();
  } catch (err) {
    if (isUniqueViolation(err)) return { outcome: 'duplicate_event', booking_id: row?.id ?? null };
    throw err;
  }

  try {
    if (!row) return { outcome: 'unmatched', booking_id: null };
    if (row.status === 'confirmed') return { outcome: 'already_confirmed', booking_id: row.id };

    const expected = expectedAmount(row, env);
    const sufficient = expected.amount !== null && n.currency.toUpperCase() === expected.currency && n.amount >= expected.amount
      && n.provider === row.payment_method;
    if (!sufficient) {
      await markAttention(d1, row, 'amount_mismatch', n, nowIso);
      return { outcome: 'needs_attention', booking_id: row.id };
    }

    let changes = 0;
    try {
      const res = await d1.prepare(
        `UPDATE bookings SET status = 'confirmed', amount_paid = ?, payment_ref = COALESCE(?, payment_ref), attention_reason = NULL, updated_at = ?
         WHERE id = ? AND status = 'held' AND hold_expires_at >= ?`
      ).bind(n.amount, n.paymentRef, nowIso, row.id, nowIso).run();
      changes = res.meta?.changes ?? 0;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    if (changes === 1) {
      const confirmed = await getBookingRow(d1, row.id);
      if (confirmed) await fulfilBooking(d1, env, confirmed, 'confirmed');
      if (confirmed) await settleBookingExtras(d1, env, confirmed);
      if (row.referrer_user_id) {
        await captureReferralCommission(d1, env, { kind: 'booking', id: row.id, payerText: n.payerText ?? null, payerEmail: n.payerEmail ?? null });
      }
      return { outcome: 'confirmed', booking_id: row.id };
    }
    const current = await getBookingRow(d1, row.id);
    if (current?.status === 'confirmed') return { outcome: 'already_confirmed', booking_id: row.id };
    await markAttention(d1, row, 'late_payment', n, nowIso);
    return { outcome: 'needs_attention', booking_id: row.id };
  } catch (err) {
    // Release the idempotency record so the provider's retry can be processed.
    await d1.prepare('DELETE FROM payment_events WHERE provider = ? AND event_id = ?').bind(n.provider, n.eventId).run().catch(() => undefined);
    throw err;
  }
}

/**
 * PayPal refund, reversal or dispute on a booking's capture: reverses its referral commission. The booking
 * is matched by custom_id (booking id) or by the capture id stored as `payment_ref`; its status is left for
 * the admin. Idempotent through the commission reversal.
 */
export async function applyPaypalReversal(
  d1: D1DatabaseLike, event: PaypalReversalEvent
): Promise<{ outcome: ReversalOutcome | 'unmatched'; booking_id: string | null }> {
  let row = event.customId ? await getBookingRow(d1, event.customId) : null;
  if ((!row || row.payment_method !== 'paypal') && event.captureId) {
    row = await d1.prepare("SELECT * FROM bookings WHERE payment_method = 'paypal' AND payment_ref = ?").bind(event.captureId).first<BookingRow>();
  }
  if (!row || row.payment_method !== 'paypal') return { outcome: 'unmatched', booking_id: null };
  const result = await reverseCommission(d1, { sourceKind: 'booking', sourceId: row.id }, `paypal_${event.kind}`);
  return { outcome: result.outcome, booking_id: row.id };
}

export type CaptureStatus = 'confirmed' | 'pending' | 'not_approved' | 'declined' | 'needs_attention' | 'unchanged';

/**
 * Guest returned from PayPal: captures the approved order server-side and applies the capture through
 * the same idempotent path as the PAYMENT.CAPTURE.COMPLETED webhook (event id = capture id). An expired
 * hold is never captured, so the guest is not charged for a slot that was already released.
 */
export async function capturePaypalBooking(
  d1: D1DatabaseLike, env: RuntimeEnv, id: string, token: string | null
): Promise<{ booking: GuestBookingView; capture_status: CaptureStatus }> {
  const row = await getBookingForGuest(d1, id, token);
  const now = bookingRuntime.now();
  if (row.payment_method !== 'paypal') throw new AppError(409, 'invalid_payment_method', 'This booking is not paid with PayPal');
  if (row.status !== 'held') return { booking: toGuestView(row, env, now), capture_status: 'unchanged' };
  if (row.hold_expires_at < iso(now)) {
    throw new AppError(409, 'hold_not_active', 'This hold expired before the payment was captured, so you have not been charged. Please choose a slot again.', { status: 'expired' });
  }
  if (!row.payment_ref) throw new AppError(409, 'checkout_not_started', 'Start the PayPal checkout first');
  assertPaymentConfigured(env, 'paypal');
  const order = await capturePaypalOrder(env, row.payment_ref, bookingRuntime.fetch, now);
  const capture = order.capture;
  let status: CaptureStatus = order.status === 'NOT_APPROVED' ? 'not_approved' : capture?.status === 'PENDING' ? 'pending' : 'declined';
  if (capture?.status === 'COMPLETED') {
    if (capture.amountCents === null || !capture.currency) throw new AppError(502, 'payment_provider_error', 'PayPal capture has no amount');
    const result = await applyPayment(d1, env, {
      provider: 'paypal',
      eventId: capture.id,
      rawType: 'capture_on_return',
      amount: capture.amountCents,
      currency: capture.currency,
      paymentRef: capture.id,
      bookingId: capture.customId ?? row.id,
      checkoutId: order.orderId,
      // The webhook's capture resource has no payer; whichever path confirms first decides, so this is best-effort.
      payerText: order.payer?.name ?? null,
      payerEmail: order.payer?.email ?? null,
    });
    status = result.outcome === 'needs_attention' ? 'needs_attention' : 'confirmed';
  }
  const fresh = (await getBookingRow(d1, row.id)) ?? row;
  return { booking: toGuestView(fresh, env, bookingRuntime.now()), capture_status: status };
}

// ---------------------------------------------------------------------------
// Fulfilment: Google Calendar + Resend
// ---------------------------------------------------------------------------

function formatForGuest(isoValue: string, timeZone: string | null): string {
  const tz = timeZone && isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
  return `${new Intl.DateTimeFormat('vi-VN', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(new Date(isoValue))} (${tz})`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

/** Creates/moves the Meet event and emails the guest an invite; records honest per-channel status. */
export async function fulfilBooking(
  d1: D1DatabaseLike, env: RuntimeEnv, row: BookingRow, kind: 'confirmed' | 'rescheduled'
): Promise<BookingRow> {
  const fetchImpl = bookingRuntime.fetch;
  const summary = `Zuey for Business — Consultation (${row.guest_name})`;
  const baseDescription = [
    'Zuey for Business: 90-minute one-off consultation.',
    `Booking code: ${row.code}`,
    row.company ? `Company: ${row.company}` : '',
    row.notes ? `Notes: ${row.notes}` : '',
  ].filter(Boolean).join('\n');

  let meetStatus = row.meet_status;
  let meetError: string | null = row.meet_error;
  let meetUrl = row.meet_url;
  let eventId = row.calendar_event_id;
  if (kind === 'rescheduled' && eventId) {
    const r = await rescheduleMeetEvent(env, eventId, row.slot_start, row.slot_end, fetchImpl);
    meetStatus = r.status;
    meetError = r.error ?? null;
    meetUrl = r.meetUrl ?? meetUrl;
  } else {
    const r = await createMeetEvent(env, {
      requestId: `${row.id}-${row.reschedule_count}`,
      summary,
      description: baseDescription,
      start: row.slot_start,
      end: row.slot_end,
      attendeeEmail: row.guest_email,
      attendeeName: row.guest_name,
    }, fetchImpl);
    meetStatus = r.status;
    meetError = r.error ?? null;
    meetUrl = r.meetUrl ?? null;
    eventId = r.eventId ?? null;
  }

  const when = formatForGuest(row.slot_start, row.guest_timezone);
  const meetLine = meetUrl ? `Google Meet: ${meetUrl}` : 'Link Google Meet sẽ được Zuey gửi riêng trước buổi tư vấn.';
  const ics = buildIcs({
    uid: `${row.id}@zuey.me`,
    start: row.slot_start,
    end: row.slot_end,
    summary,
    description: `${baseDescription}\n${meetLine}`,
    location: meetUrl,
    organizerEmail: ORGANIZER_EMAIL,
    organizerName: 'Zuey',
    attendeeEmail: row.guest_email,
    attendeeName: row.guest_name,
    sequence: row.reschedule_count,
    stamp: iso(bookingRuntime.now()),
  });
  const heading = kind === 'confirmed' ? 'Buổi tư vấn của bạn đã được xác nhận' : 'Buổi tư vấn của bạn đã được dời lịch';
  const text = [
    `Chào ${row.guest_name},`,
    '',
    `${heading}.`,
    `Thời gian: ${when}`,
    meetLine,
    `Mã đặt lịch: ${row.code}`,
    '',
    'Dùng đường link quản lý bạn nhận được khi đặt lịch để xem trạng thái hoặc dời lịch (một lần, trước ít nhất 48 giờ).',
    '',
    'Zuey',
  ].join('\n');
  const html = `<p>Chào ${escapeHtml(row.guest_name)},</p><p><strong>${heading}.</strong></p>`
    + `<p>Thời gian: ${escapeHtml(when)}<br/>${meetUrl ? `Google Meet: <a href="${escapeHtml(meetUrl)}">${escapeHtml(meetUrl)}</a>` : escapeHtml(meetLine)}<br/>Mã đặt lịch: ${escapeHtml(row.code)}</p>`
    + '<p>Dùng đường link quản lý bạn nhận được khi đặt lịch để xem trạng thái hoặc dời lịch (một lần, trước ít nhất 48 giờ).</p><p>Zuey</p>';
  const email = await sendEmail(env, {
    to: row.guest_email,
    subject: `${heading} — Zuey for Business`,
    text,
    html,
    attachments: [{ filename: 'invite.ics', content: utf8ToBase64(ics), content_type: 'text/calendar; charset=utf-8; method=REQUEST' }],
  }, fetchImpl);

  await d1.prepare(
    `UPDATE bookings SET meet_status = ?, meet_error = ?, meet_url = ?, calendar_event_id = ?, email_status = ?, email_error = ?, updated_at = ?
     WHERE id = ?`
  ).bind(meetStatus, meetError, meetUrl, eventId, email.status, email.error ?? null, iso(bookingRuntime.now()), row.id).run();
  return (await getBookingRow(d1, row.id)) ?? row;
}

// ---------------------------------------------------------------------------
// Reschedule (guest, once) and admin actions
// ---------------------------------------------------------------------------

export async function rescheduleBooking(
  d1: D1DatabaseLike, env: RuntimeEnv, id: string, token: string | null, newStartRaw: string
): Promise<GuestBookingView> {
  const row = await getBookingForGuest(d1, id, token);
  const now = bookingRuntime.now();
  const blocked = rescheduleBlockedReason(row, now);
  if (blocked) {
    throw new AppError(409, 'reschedule_not_allowed', {
      not_confirmed: 'Only confirmed bookings can be rescheduled',
      already_rescheduled: 'This booking has already been rescheduled once',
      too_close_to_start: 'Rescheduling closes 48 hours before the session',
    }[blocked] ?? 'Reschedule not allowed', { reason: blocked });
  }
  const newMs = Date.parse(newStartRaw);
  if (Number.isNaN(newMs)) throw new AppError(400, 'invalid_slot', '`slot_start` must be an ISO date-time');
  if (newMs - now < RESCHEDULE_MIN_NOTICE_MS) {
    throw new AppError(409, 'reschedule_not_allowed', 'The new time must be at least 48 hours away', { reason: 'new_slot_too_soon' });
  }
  const newIso = iso(newMs);
  if (newIso === row.slot_start) throw new AppError(400, 'invalid_slot', 'Choose a different time');
  const slot = await findRuleSlot(d1, newIso, RESCHEDULE_MIN_NOTICE_MS);
  if (!slot) throw new AppError(409, 'slot_unavailable', 'This time is not an open consultation slot');
  await expireStaleHolds(d1, iso(now), slot.start);
  const occupied = await occupiedSlots(d1, iso(now));
  if (occupied.has(slot.start)) throw new AppError(409, 'slot_taken', 'This slot was just taken. Please choose another time.');

  let changes = 0;
  try {
    const res = await d1.prepare(
      `UPDATE bookings SET slot_start = ?, slot_end = ?, duration_min = ?, reschedule_count = reschedule_count + 1, updated_at = ?
       WHERE id = ? AND status = 'confirmed' AND reschedule_count < 1 AND slot_start = ?`
    ).bind(slot.start, slot.end, slot.duration_min, iso(now), row.id, row.slot_start).run();
    changes = res.meta?.changes ?? 0;
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, 'slot_taken', 'This slot was just taken. Please choose another time.');
    throw err;
  }
  if (changes !== 1) throw new AppError(409, 'reschedule_not_allowed', 'Booking changed concurrently; reload and try again');
  const updated = await getBookingRow(d1, row.id);
  if (!updated) throw new AppError(404, 'booking_not_found', 'Booking not found');
  if (updated.referrer_user_id) await rescheduleBookingCommissionHold(d1, updated.id, updated.slot_end);
  const fulfilled = await fulfilBooking(d1, env, updated, 'rescheduled');
  return toGuestView(fulfilled, env, bookingRuntime.now());
}

export type AdminAction = 'cancel' | 'resolve' | 'mark_attention' | 'note';
export const ADMIN_ACTIONS: AdminAction[] = ['cancel', 'resolve', 'mark_attention', 'note'];

/**
 * Admin-only state changes. `cancel` never refunds automatically but reverses the referral commission;
 * `resolve` confirms a booking whose payment the admin verified manually (still guarded by the active-slot
 * unique index) and captures its referral commission like a webhook-confirmed one.
 */
export async function adminUpdateBooking(
  d1: D1DatabaseLike, env: RuntimeEnv, id: string, action: AdminAction, note: string | null
): Promise<AdminBookingView> {
  const row = await getBookingRow(d1, id);
  if (!row) throw new AppError(404, 'booking_not_found', 'Booking not found');
  const nowIso = iso(bookingRuntime.now());
  const noteValue = note ? note.slice(0, 2000) : row.admin_note;
  if (action === 'note') {
    await d1.prepare('UPDATE bookings SET admin_note = ?, updated_at = ? WHERE id = ?').bind(noteValue, nowIso, id).run();
  } else if (action === 'cancel') {
    await d1.prepare("UPDATE bookings SET status = 'cancelled', admin_note = ?, updated_at = ? WHERE id = ?").bind(noteValue, nowIso, id).run();
    if (row.referrer_user_id) await reverseCommission(d1, { sourceKind: 'booking', sourceId: id }, 'admin_cancel', 'admin');
  } else if (action === 'mark_attention') {
    await d1.prepare("UPDATE bookings SET status = 'needs_attention', attention_reason = COALESCE(attention_reason, 'admin'), admin_note = ?, updated_at = ? WHERE id = ? AND status <> 'cancelled'")
      .bind(noteValue, nowIso, id).run();
  } else {
    if (row.status === 'confirmed') throw new AppError(409, 'already_confirmed', 'Booking is already confirmed');
    try {
      await d1.prepare("UPDATE bookings SET status = 'confirmed', attention_reason = NULL, admin_note = ?, updated_at = ? WHERE id = ?")
        .bind(noteValue, nowIso, id).run();
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'slot_taken', 'Another active booking holds this slot; cancel or move it first');
      throw err;
    }
    const confirmed = await getBookingRow(d1, id);
    if (confirmed && confirmed.meet_status !== 'sent') await fulfilBooking(d1, env, confirmed, 'confirmed');
    if (confirmed) await settleBookingExtras(d1, env, confirmed);
    if (row.referrer_user_id) await captureReferralCommission(d1, env, { kind: 'booking', id });
  }
  const updated = await getBookingRow(d1, id);
  if (!updated) throw new AppError(404, 'booking_not_found', 'Booking not found');
  return toAdminView(updated);
}

export function parseAdminAction(value: unknown): AdminAction {
  const found = ADMIN_ACTIONS.find(a => a === value);
  if (!found) throw new AppError(400, 'invalid_action', `action must be one of ${ADMIN_ACTIONS.join(', ')}`);
  return found;
}

export function parseStatusFilter(value: string | null | undefined): BookingStatus | undefined {
  if (!value) return undefined;
  const found = BOOKING_STATUSES.find(s => s === value);
  if (!found) throw new AppError(400, 'invalid_status', `status must be one of ${BOOKING_STATUSES.join(', ')}`);
  return found;
}

