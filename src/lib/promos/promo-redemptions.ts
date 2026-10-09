/**
 * Using a promo code: the applicability check at checkout, the reservation taken when the order is created,
 * and the redemption recorded when it is paid. A reservation counts toward the code's limits until the
 * order's own expiry, so abandoned checkouts free their use without a cleanup job. Limits (total uses, once
 * per customer) are enforced by a single conditional INSERT, which D1 executes atomically.
 */
import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import type { BillingMonths, PlanId } from '../members/plans';
import type { Row } from '../members/runtime';
import { iso, membersRuntime, num, numOrNull, randomId, str, strOrNull } from '../members/runtime';
import { normalizeEmailForSelfCheck } from '../referrals/codes';
import type { PromoCode, PromoProduct } from './promo-codes';
import { getPromoByCode, getPromoById, rowToPromo } from './promo-codes';

export type PromoSourceKind = 'billing_order' | 'card_subscription' | 'booking' | 'course_order';

export type PromoRejection =
  | 'disabled' | 'not_started' | 'expired' | 'exhausted' | 'already_used'
  | 'product_not_eligible' | 'plan_not_eligible' | 'course_not_eligible' | 'term_too_short';

export interface PromoTarget {
  product: PromoProduct;
  plan?: PlanId;
  /** SePay prepaid months; card subscriptions are monthly (1). */
  months?: BillingMonths;
  courseId?: string;
  userId?: string | null;
  email?: string | null;
}

/** Counts toward limits: redeemed, or reserved by a checkout that has not expired yet. */
const ACTIVE_USE = "(r.status = 'redeemed' OR (r.status = 'reserved' AND r.expires_at > ?))";
/** Rows of this customer: same account or same canonical mailbox. Binds: userId, userId, canonical, canonical. */
const SAME_CUSTOMER = '((? IS NOT NULL AND r.user_id = ?) OR (? IS NOT NULL AND r.email_canonical = ?))';

async function customerCanonical(d1: D1DatabaseLike, target: PromoTarget): Promise<string | null> {
  const direct = normalizeEmailForSelfCheck(target.email);
  if (direct || !target.userId) return direct;
  const row = await d1.prepare('SELECT email FROM users WHERE id = ?').bind(target.userId).first<Row>();
  return row ? normalizeEmailForSelfCheck(str(row, 'email')) : null;
}

/**
 * First reason the code cannot be used for this purchase, or null when it applies. Read-only. The customer's
 * own open reservations are ignored: a new checkout with the same code supersedes them (see reservePromo), so
 * abandoning a checkout or switching rail never locks the buyer out of their code.
 */
export async function promoRejection(d1: D1DatabaseLike, promo: PromoCode, target: PromoTarget): Promise<PromoRejection | null> {
  const now = iso(membersRuntime.now());
  if (promo.status !== 'active') return 'disabled';
  if (promo.starts_at && now < promo.starts_at) return 'not_started';
  if (promo.ends_at && now >= promo.ends_at) return 'expired';
  if (promo.products && !promo.products.includes(target.product)) return 'product_not_eligible';
  if (target.product === 'membership') {
    if (promo.plans && (!target.plan || !promo.plans.includes(target.plan))) return 'plan_not_eligible';
    // Card subscriptions pass no months: the minimum prepaid term only limits SePay orders.
    if (promo.min_months && target.months !== undefined && target.months < promo.min_months) return 'term_too_short';
  }
  if (target.product === 'course' && promo.course_ids && (!target.courseId || !promo.course_ids.includes(target.courseId))) return 'course_not_eligible';
  const userId = target.userId ?? null;
  const canonical = await customerCanonical(d1, target);
  if (promo.max_uses !== null) {
    const used = await d1.prepare(
      `SELECT COUNT(*) AS n FROM promo_redemptions r WHERE r.promo_code_id = ? AND ${ACTIVE_USE} AND NOT (r.status = 'reserved' AND ${SAME_CUSTOMER})`
    ).bind(promo.id, now, userId, userId, canonical, canonical).first<Row>();
    if (Number(used?.n ?? 0) >= promo.max_uses) return 'exhausted';
  }
  if (promo.once_per_customer) {
    const hit = await d1.prepare(
      `SELECT 1 AS hit FROM promo_redemptions r WHERE r.promo_code_id = ? AND r.status = 'redeemed' AND ${SAME_CUSTOMER} LIMIT 1`
    ).bind(promo.id, userId, userId, canonical, canonical).first<Row>();
    if (hit) return 'already_used';
  }
  return null;
}

export function promoInvalid(reason: PromoRejection, field = 'discount_code'): AppError {
  return new AppError(400, 'promo_code_invalid', `This promo code cannot be applied (${reason})`, { field, reason });
}

/** Throws `promo_code_invalid` with the reason when the code does not apply. */
export async function requirePromoApplicable(d1: D1DatabaseLike, promo: PromoCode, target: PromoTarget): Promise<void> {
  const reason = await promoRejection(d1, promo, target);
  if (reason) throw promoInvalid(reason);
}

export interface PromoReservation {
  promo: PromoCode;
  kind: PromoSourceKind;
  sourceId: string;
  sourceCode: string | null;
  target: PromoTarget;
  currency: 'VND' | 'USD';
  amountBefore: number;
  amountDue: number;
  expiresAt: string;
}

/**
 * Takes one use of the code for a new order. The customer's earlier open reservations of the same code are
 * released first (that checkout was abandoned or replaced; if it is paid after all, redeemPromo still counts
 * it). The INSERT then re-checks the window, the total-use cap and once-per-customer in the same statement, so
 * two concurrent checkouts cannot both take the last use.
 */
export async function reservePromo(d1: D1DatabaseLike, r: PromoReservation): Promise<void> {
  const now = iso(membersRuntime.now());
  const canonical = await customerCanonical(d1, r.target);
  const userId = r.target.userId ?? null;
  await d1.prepare(`UPDATE promo_redemptions SET status = 'released', updated_at = ? WHERE promo_code_id = ? AND status = 'reserved'
      AND id IN (SELECT r.id FROM promo_redemptions r WHERE r.promo_code_id = ? AND r.status = 'reserved' AND ${SAME_CUSTOMER})`)
    .bind(now, r.promo.id, r.promo.id, userId, userId, canonical, canonical).run();
  const res = await d1.prepare(
    `INSERT INTO promo_redemptions (id, promo_code_id, code, source_kind, source_id, source_code, user_id, email_canonical, percent, currency,
       amount_before, amount_due, status, expires_at, created_at, updated_at)
     SELECT ?, p.id, p.code, ?, ?, ?, ?, ?, p.percent, ?, ?, ?, 'reserved', ?, ?, ?
     FROM promo_codes p
     WHERE p.id = ? AND p.status = 'active' AND (p.starts_at IS NULL OR p.starts_at <= ?) AND (p.ends_at IS NULL OR p.ends_at > ?)
       AND (p.max_uses IS NULL OR (SELECT COUNT(*) FROM promo_redemptions r WHERE r.promo_code_id = p.id AND ${ACTIVE_USE}) < p.max_uses)
       AND (p.once_per_customer = 0 OR NOT EXISTS (
         SELECT 1 FROM promo_redemptions r WHERE r.promo_code_id = p.id AND ${ACTIVE_USE}
           AND ${SAME_CUSTOMER}))`
  ).bind(randomId('prr'), r.kind, r.sourceId, r.sourceCode, userId, canonical, r.currency, r.amountBefore, r.amountDue, r.expiresAt, now, now,
    r.promo.id, now, now, now, now, userId, userId, canonical, canonical).run();
  if (res.meta?.changes === 1) return;
  // Lost a race (or the code changed since the check): report the reason the code no longer applies.
  throw promoInvalid((await promoRejection(d1, r.promo, r.target)) ?? 'exhausted');
}

/** Frees a reservation whose order was never created or was abandoned before payment. */
export async function releasePromo(d1: D1DatabaseLike, kind: PromoSourceKind, sourceId: string): Promise<void> {
  await d1.prepare("UPDATE promo_redemptions SET status = 'released', updated_at = ? WHERE source_kind = ? AND source_id = ? AND status = 'reserved'")
    .bind(iso(membersRuntime.now()), kind, sourceId).run();
}

/**
 * The order was paid: the use becomes permanent and the collected amount is recorded for revenue reports.
 * A released or lapsed reservation is redeemed too (a late payment, or a checkout the buyer replaced and then
 * paid anyway), so every paid order counts; `max_uses` is therefore a soft cap for such late payments.
 */
export async function redeemPromo(d1: D1DatabaseLike, kind: PromoSourceKind, sourceId: string, amountPaid: number | null): Promise<void> {
  const now = iso(membersRuntime.now());
  await d1.prepare(
    "UPDATE promo_redemptions SET status = 'redeemed', amount_paid = ?, redeemed_at = ?, updated_at = ? WHERE source_kind = ? AND source_id = ? AND status IN ('reserved', 'released')"
  ).bind(amountPaid, now, now, kind, sourceId).run();
}

// ---------------------------------------------------------------------------
// Admin reporting
// ---------------------------------------------------------------------------

export interface PromoStats {
  /** Paid orders that used the code. */
  redeemed: number;
  /** Open checkouts currently holding a use. */
  reserved: number;
  revenue_vnd: number;
  revenue_usd_cents: number;
  discount_vnd: number;
  discount_usd_cents: number;
}

export interface PromoWithStats extends PromoCode {
  stats: PromoStats;
  /** Uses left under max_uses (null when unlimited). */
  remaining_uses: number | null;
}

function statsFrom(row: Row | undefined): PromoStats {
  return {
    redeemed: Number(row?.redeemed ?? 0),
    reserved: Number(row?.reserved ?? 0),
    revenue_vnd: Number(row?.revenue_vnd ?? 0),
    revenue_usd_cents: Number(row?.revenue_usd ?? 0),
    discount_vnd: Number(row?.discount_vnd ?? 0),
    discount_usd_cents: Number(row?.discount_usd ?? 0),
  };
}

const STATS_SQL = `SELECT promo_code_id,
    SUM(CASE WHEN status = 'redeemed' THEN 1 ELSE 0 END) AS redeemed,
    SUM(CASE WHEN status = 'reserved' AND expires_at > ? THEN 1 ELSE 0 END) AS reserved,
    SUM(CASE WHEN status = 'redeemed' AND currency = 'VND' THEN COALESCE(amount_paid, amount_due) ELSE 0 END) AS revenue_vnd,
    SUM(CASE WHEN status = 'redeemed' AND currency = 'USD' THEN COALESCE(amount_paid, amount_due) ELSE 0 END) AS revenue_usd,
    SUM(CASE WHEN status = 'redeemed' AND currency = 'VND' THEN amount_before - amount_due ELSE 0 END) AS discount_vnd,
    SUM(CASE WHEN status = 'redeemed' AND currency = 'USD' THEN amount_before - amount_due ELSE 0 END) AS discount_usd
  FROM promo_redemptions`;

function withStats(promo: PromoCode, stats: PromoStats): PromoWithStats {
  return { ...promo, stats, remaining_uses: promo.max_uses === null ? null : Math.max(0, promo.max_uses - stats.redeemed - stats.reserved) };
}

/** Admin: codes (newest first), optionally filtered by status or a search on code/label, with usage and revenue. */
export async function listPromosWithStats(d1: D1DatabaseLike, filter: { q?: string | null; status?: string | null; limit?: unknown } = {}): Promise<PromoWithStats[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filter.status === 'active' || filter.status === 'disabled') { where.push('status = ?'); binds.push(filter.status); }
  const q = typeof filter.q === 'string' ? filter.q.trim() : '';
  if (q) { where.push('(code LIKE ? OR label LIKE ?)'); binds.push(`%${q.toUpperCase()}%`, `%${q}%`); }
  const limit = typeof filter.limit === 'number' && Number.isInteger(filter.limit) ? Math.min(Math.max(filter.limit, 1), 500)
    : typeof filter.limit === 'string' && /^\d+$/.test(filter.limit) ? Math.min(Math.max(Number(filter.limit), 1), 500) : 200;
  const page = `SELECT * FROM promo_codes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
  const { results } = await d1.prepare(page).bind(...binds, limit).all<Row>();
  const promos = (results ?? []).map(rowToPromo);
  if (!promos.length) return [];
  // Same page as a subquery: binding one id per code would exceed D1's 100-parameter limit.
  const stats = await d1.prepare(`${STATS_SQL} WHERE promo_code_id IN (SELECT id FROM (${page})) GROUP BY promo_code_id`)
    .bind(iso(membersRuntime.now()), ...binds, limit).all<Row>();
  const byId = new Map((stats.results ?? []).map(r => [str(r, 'promo_code_id'), r]));
  return promos.map(p => withStats(p, statsFrom(byId.get(p.id))));
}

export async function getPromoWithStats(d1: D1DatabaseLike, id: string): Promise<PromoWithStats> {
  const promo = await getPromoById(d1, id);
  if (!promo) throw new AppError(404, 'not_found', 'Promo code not found');
  const row = await d1.prepare(`${STATS_SQL} WHERE promo_code_id = ? GROUP BY promo_code_id`).bind(iso(membersRuntime.now()), id).first<Row>();
  return withStats(promo, statsFrom(row ?? undefined));
}

export interface PromoRedemptionView {
  id: string;
  source_kind: PromoSourceKind;
  source_code: string | null;
  user_email: string | null;
  status: 'reserved' | 'redeemed' | 'released' | 'expired';
  percent: number;
  currency: 'VND' | 'USD';
  amount_before: number;
  amount_due: number;
  amount_paid: number | null;
  redeemed_at: string | null;
  created_at: string;
}

/** Admin: the uses of one code, newest first (an unpaid reservation past its expiry is shown as expired). */
export async function listPromoRedemptions(d1: D1DatabaseLike, promoId: string, limit = 200): Promise<PromoRedemptionView[]> {
  const now = iso(membersRuntime.now());
  const { results } = await d1.prepare(
    `SELECT r.*, u.email AS user_email FROM promo_redemptions r LEFT JOIN users u ON u.id = r.user_id
     WHERE r.promo_code_id = ? ORDER BY r.created_at DESC LIMIT ?`
  ).bind(promoId, Math.min(Math.max(limit, 1), 500)).all<Row>();
  return (results ?? []).map(r => {
    const raw = str(r, 'status');
    const status = raw === 'redeemed' || raw === 'released' ? raw : str(r, 'expires_at') <= now ? 'expired' : 'reserved';
    const kind = str(r, 'source_kind');
    return {
      id: str(r, 'id'),
      source_kind: kind === 'card_subscription' || kind === 'booking' || kind === 'course_order' ? kind : 'billing_order',
      source_code: strOrNull(r, 'source_code'),
      user_email: strOrNull(r, 'user_email') ?? strOrNull(r, 'email_canonical'),
      status,
      percent: num(r, 'percent'),
      currency: str(r, 'currency') === 'USD' ? 'USD' : 'VND',
      amount_before: num(r, 'amount_before'),
      amount_due: num(r, 'amount_due'),
      amount_paid: numOrNull(r, 'amount_paid'),
      redeemed_at: strOrNull(r, 'redeemed_at'),
      created_at: str(r, 'created_at'),
    };
  });
}

// ---------------------------------------------------------------------------
// Public quote
// ---------------------------------------------------------------------------

/** What the checkout field shows for a typed promo code (display only; checkout re-validates everything). */
export interface PromoQuote {
  code: string;
  percent: number;
  products: PromoProduct[] | null;
  plans: PlanId[] | null;
  course_ids: string[] | null;
  min_months: BillingMonths | null;
  card_cycles: number;
  ends_at: string | null;
}

/**
 * Public lookup for `GET /api/v1/promos/quote`: the code's terms when it is live today, else 400
 * `promo_code_invalid` with the reason. Per-customer and product checks happen at checkout.
 */
export async function promoQuote(d1: D1DatabaseLike, raw: unknown): Promise<PromoQuote | null> {
  const promo = await getPromoByCode(d1, raw);
  if (!promo) return null;
  const reason = await promoRejection(d1, promo, { product: promo.products?.[0] ?? 'membership', plan: promo.plans?.[0], months: promo.min_months ?? undefined, courseId: promo.course_ids?.[0] });
  if (reason) throw promoInvalid(reason, 'code');
  return {
    code: promo.code, percent: promo.percent, products: promo.products, plans: promo.plans, course_ids: promo.course_ids,
    min_months: promo.min_months, card_cycles: promo.card_cycles, ends_at: promo.ends_at,
  };
}
