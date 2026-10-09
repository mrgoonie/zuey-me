/**
 * Course checkout: one order per attempt with a price snapshot (list, subscriber %, referral %,
 * applied %, USD and VND amounts) and the accepted terms version. SePay shows a VietQR for a ZSC
 * code; Dodo opens a hosted one-time card checkout at the server-computed amount.
 */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { requireBillingConfigured } from '../members/billing';
import { readDiscountCode } from '../promos/checkout-discount-code';
import { createInvoiceRequest, getInvoiceForSource, parseInvoiceField, toInvoiceSummary } from '../promos/invoice-requests';
import type { InvoiceSummary } from '../promos/invoice-requests';
import { releasePromo, requirePromoApplicable, reservePromo } from '../promos/promo-redemptions';
import { monthlyVnd, parseUsdVndRate } from '../members/plans';
import type { Row } from '../members/runtime';
import { iso, isUniqueViolation, membersRuntime, num, numOrNull, randomCode, randomId, siteUrl, str, strOrNull } from '../members/runtime';
import { getEntitlements } from '../members/subscriptions';
import { getUserById, logActivity } from '../members/users';
import { createDodoOneTimeCheckout, missingDodoConfig } from '../payments/dodo';
import type { SepayTransferInfo } from '../payments/sepay';
import { SEPAY_COURSE_PREFIX, missingSepayBankConfig, vietQrTransfer } from '../payments/sepay';
import { consumeRateLimit, requestCountry, requestIpHash } from './course-abuse-guards';
import { isCourseAccessLocked, ownsCourse } from './course-access';
import type { CourseQuote } from './course-pricing';
import { getPlanDiscountTable, quoteCoursePrice } from './course-pricing';
import { getCourseById, requireVisibleCourse } from './course-store';
import { COURSE_TERMS_VERSION } from './course-terms';
import type { CourseRecord } from './course-types';
import { fulfilCourseOrder } from './course-order-payments';
import { NO_REFERRAL, bindCourseReferral, resolveCourseReferral } from './referral-bridge';

export const COURSE_SEPAY_ORDER_TTL_MS = 60 * 60 * 1000;
export const COURSE_CARD_ORDER_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PENDING_COURSE_ORDERS = 5;
/** Card payments below this are refused by processors; Dodo minimum is well under $1. */
const MIN_CARD_AMOUNT_CENTS = 100;

export type CourseOrderStatus = 'pending' | 'paid' | 'expired' | 'needs_attention' | 'refunded' | 'charged_back' | 'cancelled';
export type CourseProvider = 'sepay' | 'dodo';

export interface CourseOrder {
  id: string;
  code: string;
  provider: CourseProvider;
  user_id: string;
  course_id: string;
  list_usd_cents: number;
  subscriber_pct: number;
  referral_pct: number;
  applied_pct: number;
  discount_source: 'none' | 'subscriber' | 'referral' | 'promo';
  amount_usd_cents: number;
  usd_vnd_rate: number | null;
  amount_vnd: number | null;
  status: CourseOrderStatus;
  /** Promo snapshot (null without a promo; set only when the promo won the discount). */
  promo_code_id: string | null;
  promo_code: string | null;
  promo_pct: number;
  referrer_user_id: string | null;
  referral_code: string | null;
  terms_version: string;
  terms_accepted_at: string;
  provider_session_id: string | null;
  provider_payment_id: string | null;
  amount_paid: number | null;
  currency_paid: string | null;
  attention_reason: string | null;
  expires_at: string;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

const STATUSES: CourseOrderStatus[] = ['pending', 'paid', 'expired', 'needs_attention', 'refunded', 'charged_back', 'cancelled'];

export function rowToCourseOrder(r: Row): CourseOrder {
  const discount = str(r, 'discount_source');
  return {
    id: str(r, 'id'),
    code: str(r, 'code'),
    provider: str(r, 'provider') === 'dodo' ? 'dodo' : 'sepay',
    user_id: str(r, 'user_id'),
    course_id: str(r, 'course_id'),
    list_usd_cents: num(r, 'list_usd_cents'),
    subscriber_pct: num(r, 'subscriber_pct'),
    referral_pct: num(r, 'referral_pct'),
    applied_pct: num(r, 'applied_pct'),
    discount_source: discount === 'subscriber' || discount === 'referral' || discount === 'promo' ? discount : 'none',
    amount_usd_cents: num(r, 'amount_usd_cents'),
    usd_vnd_rate: numOrNull(r, 'usd_vnd_rate'),
    amount_vnd: numOrNull(r, 'amount_vnd'),
    status: STATUSES.find(s => s === r.status) ?? 'pending',
    promo_code_id: strOrNull(r, 'promo_code_id'),
    promo_code: strOrNull(r, 'promo_code'),
    promo_pct: numOrNull(r, 'promo_pct') ?? 0,
    referrer_user_id: strOrNull(r, 'referrer_user_id'),
    referral_code: strOrNull(r, 'referral_code'),
    terms_version: str(r, 'terms_version'),
    terms_accepted_at: str(r, 'terms_accepted_at'),
    provider_session_id: strOrNull(r, 'provider_session_id'),
    provider_payment_id: strOrNull(r, 'provider_payment_id'),
    amount_paid: numOrNull(r, 'amount_paid'),
    currency_paid: strOrNull(r, 'currency_paid'),
    attention_reason: strOrNull(r, 'attention_reason'),
    expires_at: str(r, 'expires_at'),
    paid_at: strOrNull(r, 'paid_at'),
    created_at: str(r, 'created_at'),
    updated_at: str(r, 'updated_at'),
  };
}

export async function getCourseOrderByCode(d1: D1DatabaseLike, code: string): Promise<CourseOrder | null> {
  const row = await d1.prepare('SELECT * FROM course_orders WHERE code = ?').bind(code.trim().toUpperCase()).first<Row>();
  return row ? rowToCourseOrder(row) : null;
}

/** The caller's own order (any order for admins); other members' orders are a 404. */
export async function getCourseOrderFor(d1: D1DatabaseLike, code: string, viewer: { userId: string | null; isAdmin: boolean }): Promise<CourseOrder> {
  const order = await getCourseOrderByCode(d1, code);
  if (!order || (!viewer.isAdmin && order.user_id !== viewer.userId)) throw new AppError(404, 'not_found', 'Order not found');
  return order;
}

async function expireStaleCourseOrders(d1: D1DatabaseLike, userId: string | null): Promise<void> {
  const now = iso(membersRuntime.now());
  const scope = userId ? ' AND user_id = ?' : '';
  const stmt = d1.prepare(`UPDATE course_orders SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at <= ?${scope}`);
  await (userId ? stmt.bind(now, now, userId) : stmt.bind(now, now)).run();
}

export async function listCourseOrders(d1: D1DatabaseLike, filter: { userId?: string; status?: CourseOrderStatus; limit?: number }): Promise<CourseOrder[]> {
  await expireStaleCourseOrders(d1, filter.userId ?? null);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filter.userId) { where.push('user_id = ?'); binds.push(filter.userId); }
  if (filter.status) { where.push('status = ?'); binds.push(filter.status); }
  const sql = `SELECT * FROM course_orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
  const { results } = await d1.prepare(sql).bind(...binds, Math.min(500, filter.limit ?? 50)).all<Row>();
  return (results ?? []).map(rowToCourseOrder);
}

export interface CourseOrderView {
  code: string;
  provider: CourseProvider;
  course: { id: string; slug: string; title: string } | null;
  status: CourseOrderStatus;
  list_usd_cents: number;
  applied_pct: number;
  discount_source: CourseOrder['discount_source'];
  /** Promo code that set the price (null when another discount or none applied). */
  promo_code: string | null;
  amount_usd_cents: number;
  amount_vnd: number | null;
  amount_paid: number | null;
  currency_paid: string | null;
  attention_reason: string | null;
  expires_at: string;
  paid_at: string | null;
  created_at: string;
  status_url: string;
  /** VietQR transfer for a payable SePay order. */
  transfer: SepayTransferInfo | null;
  /** Business invoice requested at checkout (SePay only). */
  invoice: InvoiceSummary | null;
}

export function toCourseOrderView(order: CourseOrder, course: CourseRecord | null, env: RuntimeEnv, invoice: InvoiceSummary | null = null): CourseOrderView {
  const expired = order.status === 'pending' && Date.parse(order.expires_at) <= membersRuntime.now();
  const payable = order.provider === 'sepay' && order.status === 'pending' && !expired && order.amount_vnd !== null && missingSepayBankConfig(env).length === 0;
  return {
    code: order.code,
    provider: order.provider,
    course: course ? { id: course.id, slug: course.slug, title: course.title } : null,
    status: expired ? 'expired' : order.status,
    list_usd_cents: order.list_usd_cents,
    applied_pct: order.applied_pct,
    discount_source: order.discount_source,
    promo_code: order.discount_source === 'promo' ? order.promo_code : null,
    amount_usd_cents: order.amount_usd_cents,
    amount_vnd: order.amount_vnd,
    amount_paid: order.amount_paid,
    currency_paid: order.currency_paid,
    attention_reason: order.attention_reason,
    expires_at: order.expires_at,
    paid_at: order.paid_at,
    created_at: order.created_at,
    status_url: `${siteUrl(env)}/courses/orders/${order.code}`,
    transfer: payable && order.amount_vnd !== null && order.amount_vnd > 0 ? vietQrTransfer(env, order.amount_vnd, order.code) : null,
    invoice,
  };
}

export async function courseOrderView(d1: D1DatabaseLike, env: RuntimeEnv, order: CourseOrder): Promise<CourseOrderView> {
  const [course, invoice] = await Promise.all([getCourseById(d1, order.course_id), getInvoiceForSource(d1, 'course_order', order.id)]);
  return toCourseOrderView(order, course, env, toInvoiceSummary(invoice));
}

/** Price the caller would pay right now (no referral or promo code applied: that happens at checkout). */
export async function quoteForUser(d1: D1DatabaseLike, env: RuntimeEnv, course: CourseRecord, userId: string | null, referralPct = 0, promoPct = 0): Promise<CourseQuote> {
  const [table, plans] = await Promise.all([getPlanDiscountTable(d1), userId ? getEntitlements(d1, userId).then(e => e.plans) : Promise.resolve([])]);
  return quoteCoursePrice({ course, table, activePlans: plans, referralPct, promoPct, usdVndRate: parseUsdVndRate(env) });
}

export type CourseCheckout = CourseOrderView & { checkout_url: string | null };

/**
 * Starts a course purchase. Body: `{ course, provider?: 'sepay'|'dodo', accept_terms: true, discount_code?, referral_code?,
 * invoice?: { tax_id, email } }` (invoice: SePay only). A 100% promo makes the order free: it is paid and fulfilled at once.
 * Refuses when the course is not for sale, already owned, the account is locked, or terms are not accepted.
 */
export async function createCourseCheckout(
  d1: D1DatabaseLike, env: RuntimeEnv, userId: string, body: Record<string, unknown>, request?: Request,
): Promise<CourseCheckout> {
  if (typeof body.course !== 'string' || !body.course) throw new AppError(400, 'invalid_field', 'course (slug or id) is required', { field: 'course' });
  if (body.accept_terms !== true) {
    throw new AppError(400, 'terms_required', 'Accept the Terms of Use and the no-refund policy (accept_terms: true) to buy a course', { field: 'accept_terms', terms_url: '/terms', policy_url: '/policy' });
  }
  const provider = body.provider ?? 'sepay';
  if (provider !== 'sepay' && provider !== 'dodo') throw new AppError(400, 'invalid_field', "provider must be 'sepay' or 'dodo'", { field: 'provider' });
  const course = await requireVisibleCourse(d1, body.course, false);
  if (course.status !== 'published' || course.price_usd_cents <= 0) throw new AppError(400, 'not_for_sale', 'This course is not for sale');
  if (await ownsCourse(d1, userId, course.id)) throw new AppError(409, 'already_owned', 'You already own this course');
  if (await isCourseAccessLocked(d1, userId)) throw new AppError(403, 'account_locked', 'Course purchases are paused on this account pending review; contact support');
  await consumeRateLimit(d1, 'checkout', userId);
  await expireStaleCourseOrders(d1, userId);
  const pending = await d1.prepare("SELECT COUNT(*) AS n FROM course_orders WHERE user_id = ? AND status = 'pending'").bind(userId).first<Row>();
  if (Number(pending?.n ?? 0) >= MAX_PENDING_COURSE_ORDERS) {
    throw new AppError(429, 'too_many_pending_orders', 'You have several unpaid course orders; pay one or wait for them to expire');
  }

  let rate: number | null = null;
  if (provider === 'sepay') rate = requireBillingConfigured(env);
  else {
    const missing = missingDodoConfig(env);
    if (!env.DODO_PRODUCT_COURSE) missing.push('DODO_PRODUCT_COURSE');
    if (missing.length) throw new AppError(503, 'payment_unconfigured', `Card payments for courses are not configured: missing ${missing.join(', ')}`, { missing });
  }
  const invoice = parseInvoiceField(body, provider);
  const entry = await readDiscountCode(d1, body);
  const resolved = await resolveCourseReferral(d1, env, userId, { referral_code: entry.referralCode ?? undefined }, request);
  if (entry.promo) await requirePromoApplicable(d1, entry.promo, { product: 'course', courseId: course.id, userId });
  const quote = await quoteForUser(d1, env, course, userId, resolved.pct, entry.promo?.percent ?? 0);
  // The promo is used only when it set the price; then the order carries no referrer (no stacking, no commission).
  const promo = quote.discount_source === 'promo' ? entry.promo : null;
  const referral = promo ? NO_REFERRAL : resolved;
  const free = quote.amount_usd_cents === 0;
  const amountVnd = provider === 'sepay' && rate ? (free ? 0 : monthlyVnd(quote.amount_usd_cents, rate)) : null;
  if (provider === 'dodo' && !free && quote.amount_usd_cents < MIN_CARD_AMOUNT_CENTS) throw new AppError(400, 'amount_too_small', 'This price is too small for a card payment; use bank transfer');

  const nowMs = membersRuntime.now();
  const id = randomId('cor');
  const ttl = provider === 'sepay' ? COURSE_SEPAY_ORDER_TTL_MS : COURSE_CARD_ORDER_TTL_MS;
  const [ip, country] = request ? [await requestIpHash(env, request), requestCountry(request)] : [null, null];
  let code = '';
  for (let attempt = 0; attempt < 3 && !code; attempt++) {
    const candidate = SEPAY_COURSE_PREFIX + randomCode(8);
    try {
      await d1.prepare(
        `INSERT INTO course_orders (id, code, provider, user_id, course_id, list_usd_cents, subscriber_pct, referral_pct, applied_pct, discount_source,
           amount_usd_cents, usd_vnd_rate, amount_vnd, status, referrer_user_id, referral_code, referral_commission_percent, terms_version, terms_accepted_at,
           ip_hash, country, expires_at, created_at, updated_at, promo_code_id, promo_code, promo_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, candidate, provider, userId, course.id, quote.list_usd_cents, quote.subscriber_pct, promo ? 0 : quote.referral_pct, quote.applied_pct,
        quote.discount_source, quote.amount_usd_cents, rate, amountVnd, referral.referrerUserId, referral.code, referral.commissionPercent, COURSE_TERMS_VERSION, iso(nowMs),
        ip, country, iso(nowMs + ttl), iso(nowMs), iso(nowMs), promo?.id ?? null, promo?.code ?? null, promo ? quote.promo_pct : 0).run();
      code = candidate;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  if (!code) throw new AppError(500, 'internal_error', 'Could not allocate an order code');
  if (promo) {
    try {
      await reservePromo(d1, {
        promo, kind: 'course_order', sourceId: id, sourceCode: code, target: { product: 'course', courseId: course.id, userId },
        currency: provider === 'sepay' ? 'VND' : 'USD',
        amountBefore: provider === 'sepay' && rate ? monthlyVnd(quote.list_usd_cents, rate) : quote.list_usd_cents,
        amountDue: provider === 'sepay' ? amountVnd ?? 0 : quote.amount_usd_cents, expiresAt: iso(nowMs + ttl),
      });
    } catch (err) {
      await d1.prepare("DELETE FROM course_orders WHERE id = ? AND status = 'pending'").bind(id).run().catch(() => undefined);
      throw err;
    }
  }
  await bindCourseReferral(d1, env, userId, referral, request);
  if (invoice && amountVnd) {
    await createInvoiceRequest(d1, { kind: 'course_order', sourceId: id, sourceCode: code, userId, invoice, description: `Khoá học: ${course.title}`, amountVnd });
  }
  await logActivity(d1, userId, 'courses.order_created', {
    code, course_id: course.id, provider, amount_usd_cents: quote.amount_usd_cents, amount_vnd: amountVnd, promo_code: promo?.code ?? null,
  }, request);

  if (free) {
    // A 100% promo: nothing to collect, so the order is paid and the course granted right away.
    await d1.prepare("UPDATE course_orders SET status = 'paid', amount_paid = 0, currency_paid = ?, paid_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .bind(provider === 'sepay' ? 'VND' : 'USD', iso(nowMs), iso(nowMs), id).run();
    const paid = await getCourseOrderByCode(d1, code);
    if (!paid) throw new AppError(500, 'internal_error', 'Order was not persisted');
    await fulfilCourseOrder(d1, env, paid);
    return { ...(await courseOrderView(d1, env, (await getCourseOrderByCode(d1, code)) ?? paid)), checkout_url: null };
  }

  let checkoutUrl: string | null = null;
  if (provider === 'dodo') {
    const user = await getUserById(d1, userId);
    if (!user) throw new AppError(404, 'not_found', 'Account not found');
    try {
      const session = await createDodoOneTimeCheckout(env, {
        productId: env.DODO_PRODUCT_COURSE ?? '',
        amountCents: quote.amount_usd_cents,
        customerEmail: user.email,
        customerName: user.name,
        returnUrl: `${siteUrl(env)}/courses/orders/${code}`,
        metadata: { course_order: code, user_id: userId, course_id: course.id },
      }, membersRuntime.fetch);
      checkoutUrl = session.url;
      await d1.prepare('UPDATE course_orders SET provider_session_id = ?, updated_at = ? WHERE code = ?').bind(session.sessionId, iso(membersRuntime.now()), code).run();
    } catch (err) {
      await d1.prepare("UPDATE course_orders SET status = 'cancelled', attention_reason = 'checkout_failed', updated_at = ? WHERE code = ?").bind(iso(membersRuntime.now()), code).run();
      if (promo) await releasePromo(d1, 'course_order', id).catch(() => undefined);
      throw err;
    }
  }
  const order = await getCourseOrderByCode(d1, code);
  if (!order) throw new AppError(500, 'internal_error', 'Order was not persisted');
  return { ...(await courseOrderView(d1, env, order)), checkout_url: checkoutUrl };
}
