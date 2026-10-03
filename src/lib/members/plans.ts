import type { RuntimeEnv } from '../../env';

export type PlanId = 'knowledges' | 'ai' | 'combo' | 'community';
export type Entitlement = 'read_full' | 'ai_chat' | 'community';

export const PLAN_IDS: PlanId[] = ['knowledges', 'ai', 'combo', 'community'];
export const ENTITLEMENTS: Entitlement[] = ['read_full', 'ai_chat', 'community'];
/** SePay prepay terms. Longer prepayments get the discount in PREPAY_DISCOUNT_PERCENT. */
export const BILLING_MONTHS = [1, 3, 6, 12] as const;
export type BillingMonths = (typeof BILLING_MONTHS)[number];
/** Percent off the plain monthly total for each SePay prepay term (12 months ≈ 2.4 months free). */
export const PREPAY_DISCOUNT_PERCENT: Record<BillingMonths, number> = { 1: 0, 3: 5, 6: 10, 12: 20 };

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  /** Monthly list price in US cents. */
  price_usd_cents: number;
  interval: 'month';
  /** Monthly Zuey AI cost ceiling per member in US cents (estimated token cost); 0 when the plan has no AI. */
  ai_budget_usd_cents: number;
  entitlements: Entitlement[];
  features: string[];
}

export const PLANS: Plan[] = [
  {
    id: 'knowledges', name: 'Knowledges', tagline: 'Đọc sâu', price_usd_cents: 900, interval: 'month', ai_budget_usd_cents: 0,
    entitlements: ['read_full'],
    features: ['Đọc toàn bộ bài viết trả phí', 'Media & interactive blocks', 'MCP / API đọc nguyên bài'],
  },
  {
    id: 'ai', name: 'Zuey AI', tagline: 'Cùng suy nghĩ', price_usd_cents: 900, interval: 'month', ai_budget_usd_cents: 300,
    entitlements: ['ai_chat'],
    features: ['Chat với Zuey AI', 'Hỏi đáp trên toàn kho kiến thức', 'Bài trả phí chỉ đọc phần preview'],
  },
  {
    id: 'combo', name: 'Kết hợp', tagline: 'Đọc & hỏi', price_usd_cents: 1900, interval: 'month', ai_budget_usd_cents: 500,
    entitlements: ['read_full', 'ai_chat'],
    features: ['Toàn bộ Knowledges + Zuey AI', 'Đọc bài rồi cùng AI thực hành', 'MCP / API tìm, hỏi và đọc nguyên bài'],
  },
  {
    id: 'community', name: 'Cộng đồng', tagline: 'Kết nối sâu hơn', price_usd_cents: 2900, interval: 'month', ai_budget_usd_cents: 500,
    entitlements: ['read_full', 'ai_chat', 'community'],
    features: ['Toàn bộ gói kết hợp', 'Nhóm kín với Duy thật', 'Nhóm tiếng Anh & tiếng Việt'],
  },
];

export function isPlanId(v: unknown): v is PlanId {
  return typeof v === 'string' && (PLAN_IDS as string[]).includes(v);
}

export function isBillingMonths(v: unknown): v is BillingMonths {
  return typeof v === 'number' && (BILLING_MONTHS as readonly number[]).includes(v);
}

export function getPlan(id: PlanId): Plan {
  const plan = PLANS.find(p => p.id === id);
  if (!plan) throw new Error(`Unknown plan ${id}`);
  return plan;
}

/** Union of the entitlements granted by the given plans, in canonical order. */
export function entitlementsForPlans(plans: PlanId[]): Entitlement[] {
  const granted = new Set(plans.flatMap(p => getPlan(p).entitlements));
  return ENTITLEMENTS.filter(e => granted.has(e));
}

/** Monthly AI budget of a member: the largest budget among their active plans (0 without an AI plan). */
export function aiBudgetCents(plans: PlanId[]): number {
  return plans.reduce((max, p) => Math.max(max, getPlan(p).ai_budget_usd_cents), 0);
}

/** Parses USD_VND_RATE (VND per 1 USD); null when missing or not a positive number. */
export function parseUsdVndRate(env: RuntimeEnv): number | null {
  const raw = (env.USD_VND_RATE ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 && Number.isFinite(n) ? n : null;
}

/** Monthly VND price: USD × rate, rounded up to the next 1,000 VND. */
export function monthlyVnd(priceUsdCents: number, rate: number): number {
  const vnd = (priceUsdCents / 100) * rate;
  return Math.ceil(Math.round(vnd * 100) / 100 / 1000) * 1000;
}

/** Prepaid USD total after the term discount, rounded to whole cents. */
export function prepayUsdCents(priceUsdCents: number, months: BillingMonths): number {
  return Math.round((priceUsdCents * months * (100 - PREPAY_DISCOUNT_PERCENT[months])) / 100);
}

/** Prepaid VND total: monthly VND × months, minus the term discount, rounded up to the next 1,000 VND. */
export function prepayVnd(priceUsdCents: number, months: BillingMonths, rate: number): number {
  const full = monthlyVnd(priceUsdCents, rate) * months;
  return Math.ceil((full * (100 - PREPAY_DISCOUNT_PERCENT[months])) / 100 / 1000) * 1000;
}

export interface PlanPrice {
  months: BillingMonths;
  discount_percent: number;
  amount_usd_cents: number;
  amount_vnd: number | null;
}

export function planPrices(plan: Plan, rate: number | null): PlanPrice[] {
  return BILLING_MONTHS.map(months => ({
    months,
    discount_percent: PREPAY_DISCOUNT_PERCENT[months],
    amount_usd_cents: prepayUsdCents(plan.price_usd_cents, months),
    amount_vnd: rate === null ? null : prepayVnd(plan.price_usd_cents, months, rate),
  }));
}
