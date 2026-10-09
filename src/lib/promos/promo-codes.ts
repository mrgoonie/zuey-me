/**
 * Promo codes: percent-off codes managed by admins (Studio, REST, MCP). A code has an optional date window,
 * a total-use cap, a once-per-customer flag, product / plan / course restrictions, a minimum prepaid term
 * for SePay memberships and the number of monthly card charges it covers on Dodo. Codes are stored upper-case
 * and can never share a name with a referral code, so one "Mã ưu đãi" field can take either.
 */
import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import type { BillingMonths, PlanId } from '../members/plans';
import { BILLING_MONTHS, PLAN_IDS, isBillingMonths, isPlanId } from '../members/plans';
import type { Row } from '../members/runtime';
import { iso, isUniqueViolation, membersRuntime, num, numOrNull, randomId, str, strOrNull } from '../members/runtime';

export type PromoProduct = 'membership' | 'booking' | 'course';
export const PROMO_PRODUCTS: PromoProduct[] = ['membership', 'booking', 'course'];
export type PromoStatus = 'active' | 'disabled';
export const PROMO_STATUSES: PromoStatus[] = ['active', 'disabled'];

/** Upper-case letters, digits, `-` and `_`, 3–32 characters, starting with a letter or digit. */
export const PROMO_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
export const MAX_CARD_CYCLES = 24;

export interface PromoCode {
  id: string;
  code: string;
  percent: number;
  status: PromoStatus;
  label: string | null;
  note: string | null;
  starts_at: string | null;
  ends_at: string | null;
  max_uses: number | null;
  once_per_customer: boolean;
  /** Null = every product. */
  products: PromoProduct[] | null;
  /** Membership plans the code covers; null = every plan. */
  plans: PlanId[] | null;
  /** Courses the code covers; null = every course. */
  course_ids: string[] | null;
  /** Shortest SePay prepaid term (months) the code applies to; null = any term. */
  min_months: BillingMonths | null;
  /** Monthly card (Dodo) charges the discount covers. */
  card_cycles: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Trimmed, upper-cased code, or null when it cannot be a promo code. */
export function normalizePromoCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return PROMO_CODE_RE.test(code) ? code : null;
}

function parseJsonList(value: unknown): unknown[] | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function rowToPromo(row: Row): PromoCode {
  const products = parseJsonList(row.products)?.filter((p): p is PromoProduct => PROMO_PRODUCTS.some(x => x === p)) ?? null;
  const plans = parseJsonList(row.plans)?.filter(isPlanId) ?? null;
  const courseIds = parseJsonList(row.course_ids)?.filter((c): c is string => typeof c === 'string') ?? null;
  const minMonths = numOrNull(row, 'min_months');
  return {
    id: str(row, 'id'),
    code: str(row, 'code'),
    percent: num(row, 'percent'),
    status: row.status === 'disabled' ? 'disabled' : 'active',
    label: strOrNull(row, 'label'),
    note: strOrNull(row, 'note'),
    starts_at: strOrNull(row, 'starts_at'),
    ends_at: strOrNull(row, 'ends_at'),
    max_uses: numOrNull(row, 'max_uses'),
    once_per_customer: Number(row.once_per_customer ?? 1) === 1,
    products,
    plans,
    course_ids: courseIds,
    min_months: isBillingMonths(minMonths) ? minMonths : null,
    card_cycles: num(row, 'card_cycles') || 1,
    created_by: strOrNull(row, 'created_by'),
    created_at: str(row, 'created_at'),
    updated_at: str(row, 'updated_at'),
  };
}

export async function getPromoById(d1: D1DatabaseLike, id: string): Promise<PromoCode | null> {
  const row = await d1.prepare('SELECT * FROM promo_codes WHERE id = ?').bind(id).first<Row>();
  return row ? rowToPromo(row) : null;
}

/** Looks a typed code up case-insensitively; null when it is not a promo code. */
export async function getPromoByCode(d1: D1DatabaseLike, raw: unknown): Promise<PromoCode | null> {
  const code = normalizePromoCode(raw);
  if (!code) return null;
  const row = await d1.prepare('SELECT * FROM promo_codes WHERE code = ?').bind(code).first<Row>();
  return row ? rowToPromo(row) : null;
}

/** True when a referral code with this name exists (referral codes are lower-case). */
export async function isReferralCodeName(d1: D1DatabaseLike, code: string): Promise<boolean> {
  return (await d1.prepare('SELECT 1 AS hit FROM referral_profiles WHERE code = ?').bind(code.toLowerCase()).first<Row>()) !== null;
}

// ---------------------------------------------------------------------------
// Admin input
// ---------------------------------------------------------------------------

function invalid(field: string, message: string): AppError {
  return new AppError(400, 'invalid_field', message, { field });
}

function optionalText(body: Record<string, unknown>, field: string, max: number): string | null | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || v.trim().length > max) throw invalid(field, `${field} must be text up to ${max} characters`);
  return v.trim() || null;
}

function optionalDate(body: Record<string, unknown>, field: string): string | null | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const ms = typeof v === 'string' ? Date.parse(v) : Number.NaN;
  if (Number.isNaN(ms)) throw invalid(field, `${field} must be an ISO date-time`);
  return iso(ms);
}

function optionalInt(body: Record<string, unknown>, field: string, min: number, max: number): number | null | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw invalid(field, `${field} must be an integer ${min}–${max}`);
  return v;
}

function optionalList<T extends string>(body: Record<string, unknown>, field: string, allowed: readonly T[] | null): T[] | null | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!Array.isArray(v)) throw invalid(field, `${field} must be an array or null`);
  const out: T[] = [];
  for (const item of v) {
    if (typeof item !== 'string' || !item.trim() || (allowed && !allowed.some(a => a === item))) {
      throw invalid(field, allowed ? `${field} items must be one of ${allowed.join(', ')}` : `${field} items must be non-empty strings`);
    }
    if (!out.some(o => o === item)) out.push(item as T);
  }
  // An empty list would match nothing; treat it as "no restriction" only when explicitly null.
  if (out.length === 0) throw invalid(field, `${field} must not be empty (use null for no restriction)`);
  return out;
}

export interface PromoPatch {
  code?: string;
  percent?: number;
  status?: PromoStatus;
  label?: string | null;
  note?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  max_uses?: number | null;
  once_per_customer?: boolean;
  products?: PromoProduct[] | null;
  plans?: PlanId[] | null;
  course_ids?: string[] | null;
  min_months?: BillingMonths | null;
  card_cycles?: number;
}

/** Validates an admin create/update body; unknown keys are rejected so typos do not pass silently. */
export function parsePromoPatch(body: Record<string, unknown>): PromoPatch {
  const known = new Set(['code', 'percent', 'status', 'label', 'note', 'starts_at', 'ends_at', 'max_uses', 'once_per_customer', 'products', 'plans', 'course_ids', 'min_months', 'card_cycles']);
  for (const key of Object.keys(body)) if (!known.has(key)) throw invalid(key, `Unknown field ${key}`);
  const patch: PromoPatch = {};
  if (body.code !== undefined) {
    const code = normalizePromoCode(body.code);
    if (!code) throw invalid('code', 'code must be 3–32 letters, digits, - or _');
    patch.code = code;
  }
  const percent = optionalInt(body, 'percent', 1, 100);
  if (percent === null) throw invalid('percent', 'percent is required');
  if (percent !== undefined) patch.percent = percent;
  if (body.status !== undefined) {
    const status = PROMO_STATUSES.find(s => s === body.status);
    if (!status) throw invalid('status', `status must be one of ${PROMO_STATUSES.join(', ')}`);
    patch.status = status;
  }
  const label = optionalText(body, 'label', 120);
  if (label !== undefined) patch.label = label;
  const note = optionalText(body, 'note', 1000);
  if (note !== undefined) patch.note = note;
  const startsAt = optionalDate(body, 'starts_at');
  if (startsAt !== undefined) patch.starts_at = startsAt;
  const endsAt = optionalDate(body, 'ends_at');
  if (endsAt !== undefined) patch.ends_at = endsAt;
  const maxUses = optionalInt(body, 'max_uses', 1, 1_000_000);
  if (maxUses !== undefined) patch.max_uses = maxUses;
  if (body.once_per_customer !== undefined) {
    if (typeof body.once_per_customer !== 'boolean') throw invalid('once_per_customer', 'once_per_customer must be a boolean');
    patch.once_per_customer = body.once_per_customer;
  }
  const products = optionalList(body, 'products', PROMO_PRODUCTS);
  if (products !== undefined) patch.products = products;
  const plans = optionalList(body, 'plans', PLAN_IDS);
  if (plans !== undefined) patch.plans = plans;
  const courseIds = optionalList<string>(body, 'course_ids', null);
  if (courseIds !== undefined) patch.course_ids = courseIds;
  if (body.min_months !== undefined) {
    if (body.min_months !== null && !isBillingMonths(body.min_months)) throw invalid('min_months', `min_months must be one of ${BILLING_MONTHS.join(', ')} or null`);
    patch.min_months = body.min_months === null ? null : body.min_months;
  }
  const cycles = optionalInt(body, 'card_cycles', 1, MAX_CARD_CYCLES);
  if (cycles === null) throw invalid('card_cycles', `card_cycles must be an integer 1–${MAX_CARD_CYCLES}`);
  if (cycles !== undefined) patch.card_cycles = cycles;
  return patch;
}

function checkWindow(startsAt: string | null, endsAt: string | null): void {
  if (startsAt && endsAt && endsAt <= startsAt) throw invalid('ends_at', 'ends_at must be after starts_at');
}

const listJson = (v: readonly string[] | null | undefined): string | null => (v ? JSON.stringify(v) : null);

/** Admin: creates a code. Its name must be free among promo AND referral codes. */
export async function createPromo(d1: D1DatabaseLike, body: Record<string, unknown>, actor: string): Promise<PromoCode> {
  const p = parsePromoPatch(body);
  if (!p.code) throw invalid('code', 'code is required');
  if (p.percent === undefined) throw invalid('percent', 'percent is required');
  checkWindow(p.starts_at ?? null, p.ends_at ?? null);
  if (await isReferralCodeName(d1, p.code)) throw new AppError(409, 'code_taken', 'A referral code already uses this name', { field: 'code' });
  const now = iso(membersRuntime.now());
  const id = randomId('promo');
  try {
    await d1.prepare(
      `INSERT INTO promo_codes (id, code, percent, status, label, note, starts_at, ends_at, max_uses, once_per_customer, products, plans, course_ids,
         min_months, card_cycles, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, p.code, p.percent, p.status ?? 'active', p.label ?? null, p.note ?? null, p.starts_at ?? null, p.ends_at ?? null, p.max_uses ?? null,
      p.once_per_customer === false ? 0 : 1, listJson(p.products), listJson(p.plans), listJson(p.course_ids), p.min_months ?? null, p.card_cycles ?? 1,
      actor, now, now).run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, 'code_taken', 'A promo code with this name already exists', { field: 'code' });
    throw err;
  }
  const created = await getPromoById(d1, id);
  if (!created) throw new AppError(500, 'internal_error', 'Promo code was not persisted');
  return created;
}

/**
 * Admin: partial update. The code name cannot change once the code has been used, so orders and reports keep
 * pointing at the name the customer typed. Percent changes affect only checkouts started afterwards.
 */
export async function updatePromo(d1: D1DatabaseLike, id: string, body: Record<string, unknown>): Promise<PromoCode> {
  const current = await getPromoById(d1, id);
  if (!current) throw new AppError(404, 'not_found', 'Promo code not found');
  const p = parsePromoPatch(body);
  if (p.code && p.code !== current.code) {
    const used = await d1.prepare('SELECT 1 AS hit FROM promo_redemptions WHERE promo_code_id = ? LIMIT 1').bind(id).first<Row>();
    if (used) throw new AppError(409, 'code_in_use', 'This code has been used; create a new code instead of renaming it', { field: 'code' });
    if (await isReferralCodeName(d1, p.code)) throw new AppError(409, 'code_taken', 'A referral code already uses this name', { field: 'code' });
  }
  checkWindow(p.starts_at !== undefined ? p.starts_at : current.starts_at, p.ends_at !== undefined ? p.ends_at : current.ends_at);
  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (col: string, value: unknown) => { sets.push(`${col} = ?`); binds.push(value); };
  if (p.code !== undefined) set('code', p.code);
  if (p.percent !== undefined) set('percent', p.percent);
  if (p.status !== undefined) set('status', p.status);
  if (p.label !== undefined) set('label', p.label);
  if (p.note !== undefined) set('note', p.note);
  if (p.starts_at !== undefined) set('starts_at', p.starts_at);
  if (p.ends_at !== undefined) set('ends_at', p.ends_at);
  if (p.max_uses !== undefined) set('max_uses', p.max_uses);
  if (p.once_per_customer !== undefined) set('once_per_customer', p.once_per_customer ? 1 : 0);
  if (p.products !== undefined) set('products', listJson(p.products));
  if (p.plans !== undefined) set('plans', listJson(p.plans));
  if (p.course_ids !== undefined) set('course_ids', listJson(p.course_ids));
  if (p.min_months !== undefined) set('min_months', p.min_months);
  if (p.card_cycles !== undefined) set('card_cycles', p.card_cycles);
  if (sets.length) {
    set('updated_at', iso(membersRuntime.now()));
    try {
      await d1.prepare(`UPDATE promo_codes SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'code_taken', 'A promo code with this name already exists', { field: 'code' });
      throw err;
    }
  }
  const updated = await getPromoById(d1, id);
  if (!updated) throw new AppError(404, 'not_found', 'Promo code not found');
  return updated;
}
