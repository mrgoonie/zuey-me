/**
 * Course prices. One function decides every displayed and charged amount:
 * final = list × (1 − max(subscriber %, referral %)). Discounts never stack.
 */
import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import type { PlanId } from '../members/plans';
import { PLAN_IDS, isPlanId, monthlyVnd } from '../members/plans';
import type { Row } from '../members/runtime';
import { iso, membersRuntime } from '../members/runtime';
import type { CourseRecord } from './course-types';

export type PlanDiscountTable = Record<PlanId, number>;
export const DEFAULT_PLAN_DISCOUNTS: PlanDiscountTable = { knowledges: 10, ai: 10, combo: 25, community: 40 };
export const MAX_DISCOUNT_PERCENT = 90;
const SETTINGS_KEY = 'plan_discounts';

export async function getPlanDiscountTable(d1: D1DatabaseLike): Promise<PlanDiscountTable> {
  const row = await d1.prepare('SELECT value_json FROM course_settings WHERE key = ?').bind(SETTINGS_KEY).first<Row>();
  const table: PlanDiscountTable = { ...DEFAULT_PLAN_DISCOUNTS };
  if (typeof row?.value_json !== 'string') return table;
  try {
    const parsed: unknown = JSON.parse(row.value_json);
    if (parsed && typeof parsed === 'object') {
      for (const [plan, pct] of Object.entries(parsed)) {
        if (isPlanId(plan) && typeof pct === 'number' && Number.isInteger(pct) && pct >= 0 && pct <= MAX_DISCOUNT_PERCENT) table[plan] = pct;
      }
    }
  } catch { /* fall back to defaults */ }
  return table;
}

/** Admin: replaces any subset of the global table; other plans keep their value. */
export async function setPlanDiscountTable(d1: D1DatabaseLike, body: Record<string, unknown>): Promise<PlanDiscountTable> {
  const table = await getPlanDiscountTable(d1);
  for (const [plan, pct] of Object.entries(body)) {
    if (!isPlanId(plan)) throw new AppError(400, 'invalid_field', `Unknown plan "${plan}"`, { field: plan });
    if (typeof pct !== 'number' || !Number.isInteger(pct) || pct < 0 || pct > MAX_DISCOUNT_PERCENT) {
      throw new AppError(400, 'invalid_field', `${plan} must be an integer 0–${MAX_DISCOUNT_PERCENT}`, { field: plan });
    }
    table[plan] = pct;
  }
  await d1.prepare(
    'INSERT INTO course_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at'
  ).bind(SETTINGS_KEY, JSON.stringify(table), iso(membersRuntime.now())).run();
  return table;
}

/** Effective subscriber percentages for one course (course override wins plan by plan). */
export function coursePlanDiscounts(course: Pick<CourseRecord, 'plan_discounts'>, table: PlanDiscountTable): PlanDiscountTable {
  const out = { ...table };
  for (const plan of PLAN_IDS) {
    const override = course.plan_discounts?.[plan];
    if (typeof override === 'number') out[plan] = override;
  }
  return out;
}

export interface CourseQuote {
  list_usd_cents: number;
  subscriber_pct: number;
  /** Active plan that gives the subscriber discount (largest one). */
  subscriber_plan: PlanId | null;
  referral_pct: number;
  applied_pct: number;
  discount_source: 'none' | 'subscriber' | 'referral';
  amount_usd_cents: number;
  usd_vnd_rate: number | null;
  /** VND for SePay (USD × rate, rounded up to 1,000 VND); null without a rate. */
  amount_vnd: number | null;
  /** Discount per plan for this course, to show "members save X%". */
  plan_discounts: PlanDiscountTable;
}

export interface QuoteInput {
  course: Pick<CourseRecord, 'price_usd_cents' | 'plan_discounts'>;
  table: PlanDiscountTable;
  activePlans: PlanId[];
  referralPct: number;
  usdVndRate: number | null;
}

export function quoteCoursePrice(input: QuoteInput): CourseQuote {
  const discounts = coursePlanDiscounts(input.course, input.table);
  let subscriberPct = 0;
  let subscriberPlan: PlanId | null = null;
  for (const plan of input.activePlans) {
    if (discounts[plan] > subscriberPct) { subscriberPct = discounts[plan]; subscriberPlan = plan; }
  }
  const referralPct = Math.max(0, Math.min(MAX_DISCOUNT_PERCENT, Math.floor(input.referralPct)));
  const applied = Math.max(subscriberPct, referralPct);
  // Ties go to the subscriber discount: the referral code then earns commission without lowering the price further.
  const source = applied === 0 ? 'none' : subscriberPct >= referralPct ? 'subscriber' : 'referral';
  const list = input.course.price_usd_cents;
  const amount = Math.round((list * (100 - applied)) / 100);
  return {
    list_usd_cents: list,
    subscriber_pct: subscriberPct,
    subscriber_plan: subscriberPlan,
    referral_pct: referralPct,
    applied_pct: applied,
    discount_source: source,
    amount_usd_cents: amount,
    usd_vnd_rate: input.usdVndRate,
    amount_vnd: input.usdVndRate && amount > 0 ? monthlyVnd(amount, input.usdVndRate) : input.usdVndRate ? 0 : null,
    plan_discounts: discounts,
  };
}
