import type { D1DatabaseLike } from '../../db/store';
import type { Entitlement, PlanId } from './plans';
import { entitlementsForPlans, isPlanId } from './plans';
import type { Row } from './runtime';
import { iso, membersRuntime, num, randomId, str } from './runtime';

export interface SubscriptionView {
  plan: PlanId;
  status: 'active' | 'expired';
  current_period_end: string;
  created_at: string;
  updated_at: string;
}

/** Adds calendar months in UTC, clamping to the last day of shorter months (Jan 31 + 1 → Feb 28/29). */
export function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.getTime();
}

export async function listSubscriptions(d1: D1DatabaseLike, userId: string): Promise<SubscriptionView[]> {
  const now = membersRuntime.now();
  const { results } = await d1.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY plan').bind(userId).all<Row>();
  const out: SubscriptionView[] = [];
  for (const r of results ?? []) {
    const plan = r.plan;
    if (!isPlanId(plan)) continue;
    const end = str(r, 'current_period_end');
    out.push({
      plan,
      // Expiry is decided by the clock, not by whether the reminder job has run yet.
      status: str(r, 'status') === 'active' && Date.parse(end) > now ? 'active' : 'expired',
      current_period_end: end,
      created_at: str(r, 'created_at'),
      updated_at: str(r, 'updated_at'),
    });
  }
  return out;
}

export async function getEntitlements(d1: D1DatabaseLike, userId: string): Promise<{ plans: PlanId[]; entitlements: Entitlement[] }> {
  const plans = (await listSubscriptions(d1, userId)).filter(s => s.status === 'active').map(s => s.plan);
  return { plans, entitlements: entitlementsForPlans(plans) };
}

/**
 * Rebuilds a plan's period end from every paid order: each order extends from
 * max(paid_at, previous end) by its months. Deterministic, so re-running is idempotent.
 */
export async function recomputeSubscription(d1: D1DatabaseLike, userId: string, plan: PlanId): Promise<SubscriptionView | null> {
  const { results } = await d1.prepare(
    "SELECT months, paid_at FROM billing_orders WHERE user_id = ? AND plan = ? AND status = 'paid' AND paid_at IS NOT NULL ORDER BY paid_at, id"
  ).bind(userId, plan).all<Row>();
  let end = 0;
  for (const r of results ?? []) {
    const paidAt = Date.parse(str(r, 'paid_at'));
    if (!Number.isFinite(paidAt)) continue;
    end = addMonths(Math.max(paidAt, end), num(r, 'months'));
  }
  if (end === 0) return null;
  const now = membersRuntime.now();
  const endIso = iso(end);
  const status = end > now ? 'active' : 'expired';
  await d1.prepare(
    `INSERT INTO subscriptions (id, user_id, plan, status, current_period_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, plan) DO UPDATE SET status = excluded.status, current_period_end = excluded.current_period_end, updated_at = excluded.updated_at`
  ).bind(randomId('sub'), userId, plan, status, endIso, iso(now), iso(now)).run();
  const views = await listSubscriptions(d1, userId);
  return views.find(v => v.plan === plan) ?? null;
}
