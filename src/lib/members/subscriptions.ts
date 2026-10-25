import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import type { MembershipProvider } from '../analytics/commerce-events';
import { queueSubscriptionChange } from '../analytics/commerce-events';
import { channelAccessPushConfigured, deferChannelAccessPush, invalidateUserChannelAccess } from '../channel-access/invalidate';
import type { WaitUntil } from '../channel-access/invalidate';
import { CARD_RENEWAL_GRACE_MS } from './card-renewal-grace';
import type { Entitlement, PlanId } from './plans';
import { entitlementsForPlans, getPlan, isPlanId } from './plans';
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

/** Latest access end granted by active card (Dodo) subscriptions for a plan; 0 when none. */
async function cardAccessEnd(d1: D1DatabaseLike, userId: string, plan: PlanId): Promise<number> {
  const { results } = await d1.prepare(
    "SELECT current_period_end, cancel_at_period_end FROM card_subscriptions WHERE user_id = ? AND plan = ? AND status = 'active' AND current_period_end IS NOT NULL"
  ).bind(userId, plan).all<Row>();
  let end = 0;
  for (const r of results ?? []) {
    const periodEnd = Date.parse(str(r, 'current_period_end'));
    if (!Number.isFinite(periodEnd)) continue;
    end = Math.max(end, periodEnd + (num(r, 'cancel_at_period_end') === 1 ? 0 : CARD_RENEWAL_GRACE_MS));
  }
  return end;
}

export interface RecomputeOptions {
  /**
   * Rail whose record change triggers this recompute: `sepay` for a billing order, `dodo` for a card subscription.
   * An expiry the recompute causes is reported with this `provider` (see `SubscriptionChange.changedProvider`).
   */
  provider: MembershipProvider;
  /**
   * When given, a flip of the plan's active status caused by this recompute (payment, reversal, card change) on a plan
   * that grants `agent_chat` is pushed to dewee so the channel gate re-checks the member at once (best effort; skipped
   * when the push env is incomplete). Plain clock expiry needs no push: dewee re-checks live once its cache expires.
   */
  env?: RuntimeEnv;
  /** Cloudflare `ctx.waitUntil`: the push runs after the response; without it the push runs inline (bounded). */
  waitUntil?: WaitUntil;
}

/**
 * Rebuilds a plan's period end from every paid SePay order (each extends from max(paid_at, previous
 * end) by its months) and from active card subscriptions (provider period end). Deterministic, so
 * re-running is idempotent; when nothing grants the plan any more, access ends now. Queues the
 * resulting lifecycle analytics event (activated, renewed or expired; never throws).
 */
export async function recomputeSubscription(
  d1: D1DatabaseLike, userId: string, plan: PlanId, opts: RecomputeOptions
): Promise<SubscriptionView | null> {
  const env = opts.env;
  const watch = env !== undefined && getPlan(plan).entitlements.includes('agent_chat') && channelAccessPushConfigured(env);
  const before = watch ? ((await listSubscriptions(d1, userId)).find(v => v.plan === plan)?.status ?? 'expired') : null;
  const view = await rebuildSubscription(d1, userId, plan, opts.provider);
  if (env && watch && (view?.status ?? 'expired') !== before) {
    // Billing never waits on or fails because of the push: errors are swallowed inside.
    await deferChannelAccessPush(invalidateUserChannelAccess(d1, env, userId), opts.waitUntil);
  }
  return view;
}

async function rebuildSubscription(
  d1: D1DatabaseLike, userId: string, plan: PlanId, changedProvider: MembershipProvider,
): Promise<SubscriptionView | null> {
  const before = await d1.prepare('SELECT status, current_period_end FROM subscriptions WHERE user_id = ? AND plan = ?').bind(userId, plan).first<Row>();
  const { results } = await d1.prepare(
    "SELECT months, paid_at FROM billing_orders WHERE user_id = ? AND plan = ? AND status = 'paid' AND paid_at IS NOT NULL ORDER BY paid_at, id"
  ).bind(userId, plan).all<Row>();
  let end = 0;
  for (const r of results ?? []) {
    const paidAt = Date.parse(str(r, 'paid_at'));
    if (!Number.isFinite(paidAt)) continue;
    end = addMonths(Math.max(paidAt, end), num(r, 'months'));
  }
  const cardEnd = await cardAccessEnd(d1, userId, plan);
  const provider = cardEnd > end ? 'dodo' : 'sepay';
  end = Math.max(end, cardEnd);
  const now = membersRuntime.now();
  if (end === 0) {
    // A revoked card subscription was the only source: end access now instead of at the old period end.
    await d1.prepare(
      `UPDATE subscriptions SET status = 'expired', current_period_end = CASE WHEN current_period_end > ? THEN ? ELSE current_period_end END, updated_at = ?
       WHERE user_id = ? AND plan = ?`
    ).bind(iso(now), iso(now), iso(now), userId, plan).run();
  } else {
    const endIso = iso(end);
    const status = end > now ? 'active' : 'expired';
    await d1.prepare(
      `INSERT INTO subscriptions (id, user_id, plan, status, current_period_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, plan) DO UPDATE SET status = excluded.status, current_period_end = excluded.current_period_end, updated_at = excluded.updated_at`
    ).bind(randomId('sub'), userId, plan, status, endIso, iso(now), iso(now)).run();
  }
  const views = await listSubscriptions(d1, userId);
  const view = views.find(v => v.plan === plan) ?? null;
  const previousEndMs = before ? Date.parse(str(before, 'current_period_end')) || 0 : 0;
  await queueSubscriptionChange(d1, {
    userId, plan, provider, changedProvider, after: view, previousEndMs,
    wasActive: before !== null && str(before, 'status') === 'active' && previousEndMs > now,
  });
  return view;
}
