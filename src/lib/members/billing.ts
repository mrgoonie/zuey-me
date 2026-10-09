import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { CardCheckout, CardSubscriptionView } from '../payments/dodo-billing';
import { listCardSubscriptions, startCardCheckout, toCardView } from '../payments/dodo-billing';
import type { SepayTransferInfo } from '../payments/sepay';
import { SEPAY_BILLING_PREFIX, extractBillingCode, extractCourseOrderCode, missingSepayBankConfig, parseSepayTime, vietQrTransfer } from '../payments/sepay';
import { bindEnteredReferral, resolveCheckoutReferral, sepayReferralAmounts } from '../referrals/checkout';
import { captureReferralCommission } from '../referrals/commissions';
import type { CheckoutReferral } from '../referrals/resolve-checkout-referral';
import { promoWins, readDiscountCode } from '../promos/checkout-discount-code';
import type { InvoiceInput } from '../promos/invoice-requests';
import { activateInvoiceRequest, createInvoiceRequest, parseInvoiceField } from '../promos/invoice-requests';
import type { PromoCode } from '../promos/promo-codes';
import { redeemPromo, requirePromoApplicable, reservePromo } from '../promos/promo-redemptions';
import { receiptEmail, renewalReminderEmail, sendLoggedEmail } from './email';
import type { BillingMonths, Entitlement, PlanId } from './plans';
import { BILLING_MONTHS, getPlan, isBillingMonths, isPlanId, parseUsdVndRate } from './plans';
import type { Plan } from './plans';
import type { Row } from './runtime';
import { DAY_MS, iso, isUniqueViolation, membersRuntime, num, numOrNull, randomCode, randomId, siteUrl, str, strOrNull } from './runtime';
import type { SubscriptionView } from './subscriptions';
import { getEntitlements, listSubscriptions, recomputeSubscription } from './subscriptions';
import { getUserById, logActivity } from './users';

/** How long a pending order's VietQR stays payable. Later transfers are flagged for the admin. */
export const ORDER_TTL_MS = 60 * 60 * 1000;
export const MAX_PENDING_ORDERS = 5;
export const REMINDER_WINDOW_DAYS = 7;
const RECONCILE_LOOKBACK_DAYS = 3;
const SEPAY_TRANSACTIONS_URL = 'https://my.sepay.vn/userapi/transactions/list';

export type OrderStatus = 'pending' | 'paid' | 'expired' | 'needs_attention';

export interface BillingOrder {
  id: string;
  code: string;
  user_id: string;
  plan: PlanId;
  months: BillingMonths;
  amount_usd_cents: number;
  usd_vnd_rate: number;
  amount_vnd: number;
  status: OrderStatus;
  expires_at: string;
  paid_at: string | null;
  amount_paid: number | null;
  payment_ref: string | null;
  attention_reason: string | null;
  /** Referral terms snapshotted at order creation (null without a referral). */
  referrer_user_id: string | null;
  referral_discount_percent: number | null;
  /** Prepaid VND total before the referral discount. */
  amount_before_referral: number | null;
  /** Promo code snapshotted at order creation (null without a promo; never together with a referral). */
  promo_code_id: string | null;
  promo_code: string | null;
  promo_discount_percent: number | null;
  created_at: string;
  updated_at: string;
}

export interface OrderView {
  code: string;
  plan: PlanId;
  plan_name: string;
  months: number;
  amount_usd_cents: number;
  amount_vnd: number;
  status: OrderStatus;
  expires_at: string;
  paid_at: string | null;
  amount_paid: number | null;
  attention_reason: string | null;
  /** Referral discount applied after the prepay discount, and the VND total before it (null without a referral). */
  referral_discount_percent: number | null;
  amount_before_referral_vnd: number | null;
  /** Promo code applied instead of a referral discount, and the VND total before it (null without a promo). */
  promo_code: string | null;
  promo_discount_percent: number | null;
  amount_before_promo_vnd: number | null;
  created_at: string;
  /** VietQR transfer instructions while the order is payable; null otherwise. */
  transfer: SepayTransferInfo | null;
}

function toStatus(v: unknown): OrderStatus {
  return v === 'paid' || v === 'expired' || v === 'needs_attention' ? v : 'pending';
}

export function rowToOrder(row: Row): BillingOrder {
  const plan = row.plan;
  const months = num(row, 'months');
  return {
    id: str(row, 'id'),
    code: str(row, 'code'),
    user_id: str(row, 'user_id'),
    plan: isPlanId(plan) ? plan : 'knowledges',
    months: isBillingMonths(months) ? months : 1,
    amount_usd_cents: num(row, 'amount_usd_cents'),
    usd_vnd_rate: num(row, 'usd_vnd_rate'),
    amount_vnd: num(row, 'amount_vnd'),
    status: toStatus(row.status),
    expires_at: str(row, 'expires_at'),
    paid_at: strOrNull(row, 'paid_at'),
    amount_paid: numOrNull(row, 'amount_paid'),
    payment_ref: strOrNull(row, 'payment_ref'),
    attention_reason: strOrNull(row, 'attention_reason'),
    referrer_user_id: strOrNull(row, 'referrer_user_id'),
    referral_discount_percent: numOrNull(row, 'referral_discount_percent'),
    amount_before_referral: numOrNull(row, 'amount_before_referral'),
    promo_code_id: strOrNull(row, 'promo_code_id'),
    promo_code: strOrNull(row, 'promo_code'),
    promo_discount_percent: numOrNull(row, 'promo_discount_percent'),
    created_at: str(row, 'created_at'),
    updated_at: str(row, 'updated_at'),
  };
}

/** Env names that must be set before membership orders can be created. */
export function missingBillingConfig(env: RuntimeEnv): string[] {
  const missing = parseUsdVndRate(env) === null ? ['USD_VND_RATE'] : [];
  return [...missing, ...missingSepayBankConfig(env)];
}

export function requireBillingConfigured(env: RuntimeEnv): number {
  const missing = missingBillingConfig(env);
  const rate = parseUsdVndRate(env);
  if (missing.length > 0 || rate === null) {
    throw new AppError(503, 'billing_unconfigured', `Membership billing is not configured: missing ${missing.join(', ')}`, { missing });
  }
  return rate;
}

export function toOrderView(order: BillingOrder, env: RuntimeEnv): OrderView {
  const payable = order.status === 'pending' && Date.parse(order.expires_at) > membersRuntime.now() && missingSepayBankConfig(env).length === 0;
  return {
    code: order.code,
    plan: order.plan,
    plan_name: getPlan(order.plan).name,
    months: order.months,
    amount_usd_cents: order.amount_usd_cents,
    amount_vnd: order.amount_vnd,
    status: order.status === 'pending' && Date.parse(order.expires_at) <= membersRuntime.now() ? 'expired' : order.status,
    expires_at: order.expires_at,
    paid_at: order.paid_at,
    amount_paid: order.amount_paid,
    attention_reason: order.attention_reason,
    referral_discount_percent: order.referrer_user_id ? order.referral_discount_percent : null,
    amount_before_referral_vnd: order.referrer_user_id ? order.amount_before_referral : null,
    promo_code: order.promo_code_id ? order.promo_code : null,
    promo_discount_percent: order.promo_code_id ? order.promo_discount_percent : null,
    amount_before_promo_vnd: order.promo_code_id ? sepayReferralAmounts(order.plan, order.months, order.usd_vnd_rate, 0).beforeVnd : null,
    created_at: order.created_at,
    transfer: payable ? vietQrTransfer(env, order.amount_vnd, order.code) : null,
  };
}

async function expireStaleOrders(d1: D1DatabaseLike, userId: string | null): Promise<void> {
  const now = iso(membersRuntime.now());
  const scope = userId ? ' AND user_id = ?' : '';
  const stmt = d1.prepare(`UPDATE billing_orders SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at <= ?${scope}`);
  await (userId ? stmt.bind(now, now, userId) : stmt.bind(now, now)).run();
}

export async function getOrderByCode(d1: D1DatabaseLike, code: string): Promise<BillingOrder | null> {
  const row = await d1.prepare('SELECT * FROM billing_orders WHERE code = ?').bind(code.trim().toUpperCase()).first<Row>();
  return row ? rowToOrder(row) : null;
}

/** The caller's own order (or any order for admins); other members' orders are a 404. */
export async function getOrderFor(d1: D1DatabaseLike, code: string, viewer: { userId: string | null; isAdmin: boolean }): Promise<BillingOrder> {
  const order = await getOrderByCode(d1, code);
  if (!order || (!viewer.isAdmin && order.user_id !== viewer.userId)) throw new AppError(404, 'not_found', 'Order not found');
  if (order.status === 'pending' && Date.parse(order.expires_at) <= membersRuntime.now()) await expireStaleOrders(d1, order.user_id);
  return order;
}

export async function listOrders(d1: D1DatabaseLike, userId: string, limit = 50): Promise<BillingOrder[]> {
  await expireStaleOrders(d1, userId);
  const { results } = await d1.prepare('SELECT * FROM billing_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').bind(userId, limit).all<Row>();
  return (results ?? []).map(rowToOrder);
}

/**
 * Creates a prepaid SePay order for 1/3/6/12 months with the term discount (PREPAY_DISCOUNT_PERCENT), then
 * ONE code discount: the referral (optional typed code, the account binding or the `zr_ref` cookie) or a promo
 * code typed in `discount_code`, whichever percent is larger (ties go to the referral). Amounts are always
 * computed here and the discount terms are snapshotted on the order. An optional `invoice: { tax_id, email }`
 * records a business invoice request that becomes due once the order is paid.
 */
export async function createOrder(d1: D1DatabaseLike, env: RuntimeEnv, userId: string, body: Record<string, unknown>, request?: Request): Promise<BillingOrder> {
  if (!isPlanId(body.plan)) throw new AppError(400, 'invalid_field', "plan must be one of 'knowledges', 'ai', 'combo', 'community'", { field: 'plan' });
  const months = body.months ?? 1;
  if (!isBillingMonths(months)) throw new AppError(400, 'invalid_field', `months must be one of ${BILLING_MONTHS.join(', ')}`, { field: 'months' });
  const entry = await readDiscountCode(d1, body);
  const invoice = parseInvoiceField(body, 'sepay');
  const rate = requireBillingConfigured(env);
  await expireStaleOrders(d1, userId);
  const pending = await d1.prepare("SELECT COUNT(*) AS n FROM billing_orders WHERE user_id = ? AND status = 'pending'").bind(userId).first<Row>();
  if (Number(pending?.n ?? 0) >= MAX_PENDING_ORDERS) {
    throw new AppError(429, 'too_many_pending_orders', 'You have several unpaid orders; pay one or wait for them to expire');
  }

  const plan = getPlan(body.plan);
  const referral = await resolveCheckoutReferral(d1, { userId, enteredCode: entry.referralCode, request, product: 'membership' });
  if (entry.promo) await requirePromoApplicable(d1, entry.promo, { product: 'membership', plan: plan.id, months, userId });
  const usePromo = entry.promo !== null && promoWins(entry.promo.percent, referral?.discountPercent);
  return insertSepayOrder(d1, env, userId, { plan, months, rate, referral: usePromo ? null : referral, promo: usePromo ? entry.promo : null, invoice }, request);
}

interface SepayOrderInput {
  plan: Plan;
  months: BillingMonths;
  rate: number;
  referral: CheckoutReferral | null;
  promo: PromoCode | null;
  invoice: InvoiceInput | null;
}

/**
 * Inserts the order with its discount snapshot, reserves the promo use (the order is removed again if the code
 * ran out meanwhile), binds a typed referral code and records the invoice request. A 100% promo makes a 0 VND
 * order that is paid and fulfilled at once.
 */
async function insertSepayOrder(d1: D1DatabaseLike, env: RuntimeEnv, userId: string, input: SepayOrderInput, request?: Request): Promise<BillingOrder> {
  const { plan, months, rate, referral, promo } = input;
  const percent = promo ? promo.percent : referral?.discountPercent ?? 0;
  const amounts = sepayReferralAmounts(plan.id, months, rate, percent);
  const now = membersRuntime.now();
  const expiresAt = iso(now + ORDER_TTL_MS);
  const id = randomId('ord');
  let code = '';
  for (let attempt = 0; attempt < 3 && !code; attempt++) {
    const candidate = SEPAY_BILLING_PREFIX + randomCode(8);
    try {
      await d1.prepare(
        `INSERT INTO billing_orders (id, code, user_id, plan, months, amount_usd_cents, usd_vnd_rate, amount_vnd, status, expires_at, created_at, updated_at,
           referrer_user_id, referral_rate, referral_discount_percent, referral_commission_percent, amount_before_referral,
           promo_code_id, promo_code, promo_discount_percent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, candidate, userId, plan.id, months, amounts.usdCents, rate, amounts.vnd, expiresAt, iso(now), iso(now),
        referral?.referrerUserId ?? null, referral?.rate ?? null, referral?.discountPercent ?? null, referral?.commissionPercent ?? null,
        referral ? amounts.beforeVnd : null, promo?.id ?? null, promo?.code ?? null, promo?.percent ?? null).run();
      code = candidate;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  if (!code) throw new AppError(500, 'internal_error', 'Could not allocate an order code');
  if (promo) {
    try {
      await reservePromo(d1, {
        promo, kind: 'billing_order', sourceId: id, sourceCode: code, target: { product: 'membership', plan: plan.id, months, userId },
        currency: 'VND', amountBefore: amounts.beforeVnd, amountDue: amounts.vnd, expiresAt,
      });
    } catch (err) {
      await d1.prepare("DELETE FROM billing_orders WHERE id = ? AND status = 'pending'").bind(id).run().catch(() => undefined);
      throw err;
    }
  }
  // A typed code binds only now that the order exists, never for a checkout that failed validation.
  await bindEnteredReferral(d1, env, userId, referral, request);
  if (input.invoice && amounts.vnd > 0) {
    await createInvoiceRequest(d1, {
      kind: 'billing_order', sourceId: id, sourceCode: code, userId, invoice: input.invoice, amountVnd: amounts.vnd,
      description: `Zuey ${plan.name} — ${months} tháng`,
    });
  }
  await logActivity(d1, userId, 'billing.order_created', {
    code, plan: plan.id, months, amount_vnd: amounts.vnd, referral_discount_percent: referral?.discountPercent ?? null,
    promo_code: promo?.code ?? null, invoice: input.invoice ? true : null,
  }, request);
  if (amounts.vnd === 0) {
    // Fully discounted: nothing to transfer, so the order is paid now.
    const paidAt = iso(membersRuntime.now());
    await d1.prepare("UPDATE billing_orders SET status = 'paid', paid_at = ?, amount_paid = 0, payment_ref = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .bind(paidAt, `promo:${promo?.code ?? 'free'}`, paidAt, id).run();
  }
  const order = await getOrderByCode(d1, code);
  if (!order) throw new AppError(500, 'internal_error', 'Order was not persisted');
  if (order.status === 'paid') await fulfilOrder(d1, env, order);
  return order;
}

/** Months granted by a 100% promo used on the card rail: its card cycles, rounded down to a prepaid term. */
export function freeCardMonths(cardCycles: number): BillingMonths {
  return [...BILLING_MONTHS].reverse().find(m => m <= cardCycles) ?? 1;
}

export interface SubscriptionSummary {
  subscriptions: SubscriptionView[];
  /** Card (Dodo) subscriptions with provider status, renewal date and manage/cancel availability. */
  card_subscriptions: CardSubscriptionView[];
  active_plans: PlanId[];
  entitlements: Entitlement[];
}

/** Plans, card subscriptions and the entitlements currently in effect (REST and MCP share this). */
export async function subscriptionSummary(d1: D1DatabaseLike, env: RuntimeEnv, userId: string): Promise<SubscriptionSummary> {
  const [subscriptions, cards, effective] = await Promise.all([
    listSubscriptions(d1, userId), listCardSubscriptions(d1, userId), getEntitlements(d1, userId),
  ]);
  return { subscriptions, card_subscriptions: cards.map(c => toCardView(c, env)), active_plans: effective.plans, entitlements: effective.entitlements };
}

export type CheckoutProvider = 'sepay' | 'dodo';
export const CHECKOUT_PROVIDERS: CheckoutProvider[] = ['sepay', 'dodo'];

export type MemberCheckout =
  | (OrderView & { provider: 'sepay'; status_url: string })
  | (CardCheckout & { provider: 'dodo' });

/**
 * Starts a membership purchase on the chosen rail: `sepay` (default) creates a prepaid VietQR order,
 * `dodo` opens a monthly card subscription checkout (months must be 1 or omitted).
 */
export async function createMemberCheckout(
  d1: D1DatabaseLike, env: RuntimeEnv, userId: string, body: Record<string, unknown>, request?: Request
): Promise<MemberCheckout> {
  const provider = body.provider ?? 'sepay';
  if (provider === 'dodo') {
    if (!isPlanId(body.plan)) throw new AppError(400, 'invalid_field', "plan must be one of 'knowledges', 'ai', 'combo', 'community'", { field: 'plan' });
    if (body.months !== undefined && body.months !== 1) {
      throw new AppError(400, 'invalid_field', 'Card subscriptions renew monthly; months must be 1 or omitted', { field: 'months' });
    }
    parseInvoiceField(body, 'dodo');
    const entry = await readDiscountCode(d1, body);
    const referral = await resolveCheckoutReferral(d1, { userId, enteredCode: entry.referralCode, request, product: 'membership' });
    if (entry.promo) await requirePromoApplicable(d1, entry.promo, { product: 'membership', plan: body.plan, months: 1, userId });
    const promo = entry.promo !== null && promoWins(entry.promo.percent, referral?.discountPercent) ? entry.promo : null;
    if (promo && promo.percent >= 100) {
      // Nothing to charge: grant the covered months as a paid 0 VND prepaid order instead of a card subscription.
      const rate = parseUsdVndRate(env);
      if (rate === null) throw new AppError(503, 'billing_unconfigured', 'Membership billing is not configured: missing USD_VND_RATE', { missing: ['USD_VND_RATE'] });
      const order = await insertSepayOrder(d1, env, userId, { plan: getPlan(body.plan), months: freeCardMonths(promo.card_cycles), rate, referral: null, promo, invoice: null }, request);
      const view = toOrderView(order, env);
      return { ...view, provider: 'sepay', status_url: `${siteUrl(env)}/billing/${view.code}` };
    }
    const checkout = await startCardCheckout(d1, env, userId, body.plan, request, promo ? null : referral, promo);
    if (!promo) await bindEnteredReferral(d1, env, userId, referral, request);
    return { ...checkout, provider: 'dodo' };
  }
  if (provider !== 'sepay') throw new AppError(400, 'invalid_field', `provider must be one of ${CHECKOUT_PROVIDERS.join(', ')}`, { field: 'provider' });
  const view = toOrderView(await createOrder(d1, env, userId, body, request), env);
  return { ...view, provider: 'sepay', status_url: `${siteUrl(env)}/billing/${view.code}` };
}

// ---------------------------------------------------------------------------
// Payments (SePay webhook and reconciliation share this path)
// ---------------------------------------------------------------------------

export interface BillingPaymentNotice {
  eventId: string;
  amount: number;
  orderCode: string;
  paymentRef: string | null;
  rawType: string;
  /** Bank transfer content (may carry the payer's name); used only as a referral fraud signal. */
  payerText?: string | null;
  /** Bank booking time from SePay (epoch ms); decides on-time payment when the notice arrives late. */
  transactedAt?: number | null;
}

/**
 * When the transfer counts as paid: the bank booking time, clamped to [order creation, now] so a
 * wrong or future bank clock can neither predate the order nor extend it. Falls back to now.
 */
function paymentTimeMs(order: BillingOrder, transactedAt: number | null | undefined, nowMs: number): number {
  if (typeof transactedAt !== 'number' || !Number.isFinite(transactedAt)) return nowMs;
  return Math.min(nowMs, Math.max(Date.parse(order.created_at), transactedAt));
}

/** Pending, or expired only by the clock (never flagged or dismissed by an admin). */
function isPayable(order: BillingOrder): boolean {
  return order.status === 'pending' || (order.status === 'expired' && order.attention_reason === null);
}

export type BillingOutcome = 'duplicate_event' | 'unmatched' | 'paid' | 'already_paid' | 'needs_attention';

async function markAttention(d1: D1DatabaseLike, order: BillingOrder, reason: string, n: BillingPaymentNotice): Promise<void> {
  await d1.prepare(
    `UPDATE billing_orders SET status = 'needs_attention', attention_reason = ?, amount_paid = COALESCE(amount_paid, 0) + ?,
       payment_ref = COALESCE(?, payment_ref), provider_event_id = ?, updated_at = ?
     WHERE id = ? AND status <> 'paid'`
  ).bind(reason, n.amount, n.paymentRef, n.eventId, iso(membersRuntime.now()), order.id).run();
  await logActivity(d1, order.user_id, 'billing.needs_attention', { code: order.code, reason, amount: n.amount });
}

/** Extends the plan from paid orders, then records and emails a receipt (email failure never undoes payment). */
export async function fulfilOrder(d1: D1DatabaseLike, env: RuntimeEnv, order: BillingOrder): Promise<SubscriptionView | null> {
  const sub = await recomputeSubscription(d1, order.user_id, order.plan);
  try {
    if (order.promo_code_id) await redeemPromo(d1, 'billing_order', order.id, order.amount_paid ?? order.amount_vnd);
    await activateInvoiceRequest(d1, env, 'billing_order', order.id, order.amount_paid ?? order.amount_vnd);
  } catch (err) {
    console.error(`promo/invoice bookkeeping for ${order.code} failed:`, err instanceof Error ? err.message : 'unknown');
  }
  await logActivity(d1, order.user_id, 'billing.paid', { code: order.code, plan: order.plan, months: order.months, period_end: sub?.current_period_end ?? null });
  const user = await getUserById(d1, order.user_id);
  if (user && sub) {
    const mail = await sendLoggedEmail(d1, env, {
      key: `receipt:${order.id}`,
      kind: 'payment_receipt',
      to: user.email,
      userId: user.id,
      ...receiptEmail({
        code: order.code,
        planName: getPlan(order.plan).name,
        months: order.months,
        amountVnd: order.amount_paid ?? order.amount_vnd,
        paidAt: order.paid_at ?? iso(membersRuntime.now()),
        periodEnd: sub.current_period_end,
        accountUrl: `${siteUrl(env)}/account#billing`,
      }),
    });
    if (mail.status !== 'sent' && mail.status !== 'duplicate') {
      console.warn(`receipt email for ${order.code} ${mail.status}${mail.error ? `: ${mail.error}` : ''}`);
    }
  }
  return sub;
}

/**
 * Applies a verified incoming transfer to a ZSB order. The payment event is recorded first
 * (idempotency gate shared with booking); full payment of a live pending order marks it paid,
 * anything else (underpaid, late, already paid) is flagged for the admin.
 */
export async function applyBillingPayment(d1: D1DatabaseLike, env: RuntimeEnv, n: BillingPaymentNotice): Promise<{ outcome: BillingOutcome; order_code: string | null }> {
  const order = await getOrderByCode(d1, n.orderCode);
  const nowMs = membersRuntime.now();
  const nowIso = iso(nowMs);
  try {
    await d1.prepare(
      'INSERT INTO payment_events (provider, event_id, booking_id, billing_order_id, amount, currency, raw_type, received_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)'
    ).bind('sepay', n.eventId, order?.id ?? null, n.amount, 'VND', n.rawType, nowIso).run();
  } catch (err) {
    if (isUniqueViolation(err)) return { outcome: 'duplicate_event', order_code: order?.code ?? null };
    throw err;
  }

  try {
    if (!order) return { outcome: 'unmatched', order_code: null };
    if (order.status === 'paid') {
      await d1.prepare("UPDATE billing_orders SET attention_reason = COALESCE(attention_reason, 'duplicate_payment'), updated_at = ? WHERE id = ?")
        .bind(nowIso, order.id).run();
      await logActivity(d1, order.user_id, 'billing.extra_payment', { code: order.code, amount: n.amount });
      return { outcome: 'already_paid', order_code: order.code };
    }
    // A webhook delayed or retried past the deadline still pays an order the bank booked in time.
    const paidIso = iso(paymentTimeMs(order, n.transactedAt, nowMs));
    if (!isPayable(order) || order.expires_at < paidIso) {
      await markAttention(d1, order, order.status === 'needs_attention' ? (order.attention_reason ?? 'additional_payment') : 'late_payment', n);
      return { outcome: 'needs_attention', order_code: order.code };
    }
    if (n.amount < order.amount_vnd) {
      await markAttention(d1, order, 'underpaid', n);
      return { outcome: 'needs_attention', order_code: order.code };
    }
    const res = await d1.prepare(
      `UPDATE billing_orders SET status = 'paid', paid_at = ?, amount_paid = ?, payment_ref = ?, provider_event_id = ?, updated_at = ?
       WHERE id = ? AND (status = 'pending' OR (status = 'expired' AND attention_reason IS NULL)) AND expires_at >= ?`
    ).bind(nowIso, n.amount, n.paymentRef, n.eventId, nowIso, order.id, paidIso).run();
    if (res.meta?.changes === 1) {
      await fulfilOrder(d1, env, { ...order, status: 'paid', paid_at: nowIso, amount_paid: n.amount });
      if (order.referrer_user_id) await captureReferralCommission(d1, env, { kind: 'billing_order', id: order.id, payerText: n.payerText ?? null });
      return { outcome: 'paid', order_code: order.code };
    }
    const current = await getOrderByCode(d1, order.code);
    if (current?.status === 'paid') return { outcome: 'already_paid', order_code: order.code };
    if (current) await markAttention(d1, current, 'late_payment', n);
    return { outcome: 'needs_attention', order_code: order.code };
  } catch (err) {
    // Release the idempotency record so the provider's retry can be processed.
    await d1.prepare('DELETE FROM payment_events WHERE provider = ? AND event_id = ?').bind('sepay', n.eventId).run().catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Admin reconciliation via the SePay user API
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function saigonDate(ms: number): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

export interface ReconcileResult {
  checked: number;
  matched: number;
  results: { transaction_id: string; order_code: string; outcome: string }[];
}

/** Applies a transfer carrying a course order code (ZSC); injected so billing stays independent of courses. */
export type CourseTransferApplier = (notice: BillingPaymentNotice) => Promise<{ outcome: string }>;

/**
 * Lists recent incoming SePay transactions and applies any carrying a ZSB (or, with `applyCourse`, ZSC)
 * code. Uses the same transaction id as the webhook, so payments already delivered by webhook are
 * skipped as duplicates.
 */
export async function reconcileSepay(d1: D1DatabaseLike, env: RuntimeEnv, applyCourse?: CourseTransferApplier): Promise<ReconcileResult> {
  if (!env.SEPAY_API_TOKEN) {
    throw new AppError(503, 'reconcile_unconfigured', 'SePay reconciliation is not configured: missing SEPAY_API_TOKEN', { missing: ['SEPAY_API_TOKEN'] });
  }
  const qs = new URLSearchParams({ transaction_date_min: saigonDate(membersRuntime.now() - RECONCILE_LOOKBACK_DAYS * DAY_MS), limit: '500' });
  if (env.SEPAY_BANK_ACCOUNT) qs.set('account_number', env.SEPAY_BANK_ACCOUNT);
  let res: Response;
  try {
    res = await membersRuntime.fetch(`${SEPAY_TRANSACTIONS_URL}?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${env.SEPAY_API_TOKEN}`, Accept: 'application/json' },
    });
  } catch {
    throw new AppError(502, 'sepay_api_error', 'Could not reach the SePay API');
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || !isRecord(body) || !Array.isArray(body.transactions)) {
    throw new AppError(502, 'sepay_api_error', `SePay API returned HTTP ${res.status}`);
  }
  const out: ReconcileResult = { checked: 0, matched: 0, results: [] };
  for (const tx of body.transactions) {
    if (!isRecord(tx)) continue;
    out.checked += 1;
    const id = typeof tx.id === 'string' || typeof tx.id === 'number' ? String(tx.id) : null;
    const amountIn = Number(tx.amount_in);
    const content = typeof tx.transaction_content === 'string' ? tx.transaction_content : '';
    const billingCode = extractBillingCode(content);
    const courseCode = applyCourse ? extractCourseOrderCode(content) : null;
    const code = billingCode ?? courseCode;
    if (!id || !code || !Number.isFinite(amountIn) || amountIn <= 0) continue;
    const notice: BillingPaymentNotice = {
      eventId: id,
      amount: Math.round(amountIn),
      orderCode: code,
      paymentRef: typeof tx.reference_number === 'string' && tx.reference_number ? tx.reference_number : id,
      rawType: 'reconcile',
      // The transfer content may name the payer: same referral fraud signal as the webhook path.
      payerText: typeof tx.transaction_content === 'string' ? tx.transaction_content : null,
      transactedAt: parseSepayTime(tx.transaction_date),
    };
    const result = billingCode || !applyCourse ? await applyBillingPayment(d1, env, notice) : await applyCourse(notice);
    out.matched += 1;
    out.results.push({ transaction_id: id, order_code: code, outcome: result.outcome });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Renewal reminders (run by the billing-reminders GitHub Actions cron)
// ---------------------------------------------------------------------------

export interface ReminderResult {
  due: number;
  sent: number;
  duplicate: number;
  skipped: number;
  failed: number;
}

/**
 * Emails members whose plan ends within the reminder window; one email per plan period. Plans kept
 * alive by an auto-renewing card subscription are skipped: the card renews them.
 */
export async function sendRenewalReminders(d1: D1DatabaseLike, env: RuntimeEnv): Promise<ReminderResult> {
  if (!env.RESEND_API_KEY) {
    throw new AppError(503, 'email_unconfigured', 'Renewal reminders are unavailable: RESEND_API_KEY is not configured', { missing: ['RESEND_API_KEY'] });
  }
  const nowMs = membersRuntime.now();
  const now = iso(nowMs);
  await d1.prepare("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE status = 'active' AND current_period_end <= ?").bind(now, now).run();
  await expireStaleOrders(d1, null);
  const { results } = await d1.prepare(
    `SELECT s.user_id, s.plan, s.current_period_end, u.email FROM subscriptions s JOIN users u ON u.id = s.user_id
     WHERE s.status = 'active' AND s.current_period_end > ? AND s.current_period_end <= ? AND u.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM card_subscriptions c
         WHERE c.user_id = s.user_id AND c.plan = s.plan AND c.status = 'active' AND c.cancel_at_period_end = 0
       )`
  ).bind(now, iso(nowMs + REMINDER_WINDOW_DAYS * DAY_MS)).all<Row>();
  const out: ReminderResult = { due: 0, sent: 0, duplicate: 0, skipped: 0, failed: 0 };
  for (const r of results ?? []) {
    const plan = r.plan;
    if (!isPlanId(plan)) continue;
    out.due += 1;
    const periodEnd = str(r, 'current_period_end');
    const sent = await sendLoggedEmail(d1, env, {
      key: `renewal:${str(r, 'user_id')}:${plan}:${periodEnd}`,
      kind: 'renewal_reminder',
      to: str(r, 'email'),
      userId: str(r, 'user_id'),
      ...renewalReminderEmail({ planName: getPlan(plan).name, periodEnd, pricingUrl: `${siteUrl(env)}/pricing?plan=${plan}` }),
    });
    out[sent.status] += 1;
  }
  return out;
}
