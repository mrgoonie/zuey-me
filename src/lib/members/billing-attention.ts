import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { captureReferralCommission } from '../referrals/commissions';
import type { BillingOrder, OrderView } from './billing';
import { fulfilOrder, getOrderByCode, rowToOrder, toOrderView } from './billing';
import type { PlanId } from './plans';
import { getPlan, isPlanId } from './plans';
import type { Principal } from './policy';
import type { Row } from './runtime';
import { iso, membersRuntime, numOrNull, str, strOrNull } from './runtime';
import type { SubscriptionView } from './subscriptions';
import { logActivity } from './users';

/**
 * Admin attention queue for membership payments. SePay orders land in `needs_attention` when a
 * transfer is late, short or repeated; Dodo card rows when webhook metadata or price do not match.
 *
 * SePay resolution reuses the existing columns: `activate` marks the order `paid` and runs the
 * normal fulfilment path (period math lives in recomputeSubscription), `dismiss` closes it as
 * `expired` while keeping `attention_reason`, so "expired with a reason" means "dismissed by an
 * admin". The admin, action and note are recorded in the member's activity log.
 */

export const ATTENTION_LIMIT = 200;
export const MAX_NOTE_LENGTH = 500;

export type ResolveAction = 'activate' | 'dismiss';
export const RESOLVE_ACTIONS: ResolveAction[] = ['activate', 'dismiss'];

export type ResolveOutcome = 'activated' | 'already_activated' | 'dismissed' | 'already_dismissed';

export interface AttentionOrder {
  code: string;
  user_id: string;
  member_email: string | null;
  plan: PlanId;
  plan_name: string;
  months: number;
  amount_vnd: number;
  amount_paid: number | null;
  attention_reason: string | null;
  payment_ref: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface AttentionCard {
  id: string;
  user_id: string | null;
  /** The linked member's email, else the email Dodo reported for the customer. */
  member_email: string | null;
  plan: PlanId | null;
  plan_name: string | null;
  amount_cents: number | null;
  currency: string | null;
  attention_reason: string | null;
  provider_subscription_id: string | null;
  current_period_end: string | null;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AttentionQueue {
  orders: AttentionOrder[];
  card_subscriptions: AttentionCard[];
  /** Why card rows are read-only here. */
  card_note: string;
}

export const CARD_READ_ONLY_NOTE =
  'Card subscriptions are listed read-only: their live state (status, period end, amount) is owned by Dodo Payments and is not '
  + 'stored once a row is flagged, so granting or closing access here could contradict the provider. Resolve them in the Dodo '
  + 'dashboard; the next verified webhook updates the row.';

function toAttentionOrder(row: Row): AttentionOrder {
  const order = rowToOrder(row);
  return {
    code: order.code,
    user_id: order.user_id,
    member_email: strOrNull(row, 'member_email'),
    plan: order.plan,
    plan_name: getPlan(order.plan).name,
    months: order.months,
    amount_vnd: order.amount_vnd,
    amount_paid: order.amount_paid,
    attention_reason: order.attention_reason,
    payment_ref: order.payment_ref,
    expires_at: order.expires_at,
    created_at: order.created_at,
    updated_at: order.updated_at,
  };
}

function toAttentionCard(row: Row): AttentionCard {
  const plan = row.plan;
  return {
    id: str(row, 'id'),
    user_id: strOrNull(row, 'user_id'),
    member_email: strOrNull(row, 'member_email') ?? strOrNull(row, 'customer_email'),
    plan: isPlanId(plan) ? plan : null,
    plan_name: isPlanId(plan) ? getPlan(plan).name : null,
    amount_cents: numOrNull(row, 'amount_cents'),
    currency: strOrNull(row, 'currency'),
    attention_reason: strOrNull(row, 'attention_reason'),
    provider_subscription_id: strOrNull(row, 'provider_subscription_id'),
    current_period_end: strOrNull(row, 'current_period_end'),
    last_event_at: strOrNull(row, 'last_event_at'),
    created_at: str(row, 'created_at'),
    updated_at: str(row, 'updated_at'),
  };
}

/** Oldest first, so the longest-waiting payments are handled first. */
export async function listBillingAttention(d1: D1DatabaseLike): Promise<AttentionQueue> {
  const [orders, cards] = await Promise.all([
    d1.prepare(
      `SELECT o.*, u.email AS member_email FROM billing_orders o LEFT JOIN users u ON u.id = o.user_id
       WHERE o.status = 'needs_attention' ORDER BY o.updated_at, o.id LIMIT ?`
    ).bind(ATTENTION_LIMIT).all<Row>(),
    d1.prepare(
      `SELECT c.*, u.email AS member_email FROM card_subscriptions c LEFT JOIN users u ON u.id = c.user_id
       WHERE c.status = 'needs_attention' ORDER BY c.updated_at, c.id LIMIT ?`
    ).bind(ATTENTION_LIMIT).all<Row>(),
  ]);
  return {
    orders: (orders.results ?? []).map(toAttentionOrder),
    card_subscriptions: (cards.results ?? []).map(toAttentionCard),
    card_note: CARD_READ_ONLY_NOTE,
  };
}

export interface ResolveInput {
  action: ResolveAction;
  note: string | null;
}

/** Validates `{ action: 'activate' | 'dismiss', note?: string }` from REST or MCP. */
export function parseResolveInput(body: Record<string, unknown>): ResolveInput {
  const action = RESOLVE_ACTIONS.find(a => a === body.action);
  if (!action) throw new AppError(400, 'invalid_field', `action must be one of ${RESOLVE_ACTIONS.join(', ')}`, { field: 'action' });
  const rawNote = body.note;
  if (rawNote !== undefined && rawNote !== null && typeof rawNote !== 'string') {
    throw new AppError(400, 'invalid_field', 'note must be a string', { field: 'note' });
  }
  const note = typeof rawNote === 'string' ? rawNote.trim() : '';
  if (note.length > MAX_NOTE_LENGTH) {
    throw new AppError(400, 'invalid_field', `note must be at most ${MAX_NOTE_LENGTH} characters`, { field: 'note' });
  }
  return { action, note: note || null };
}

/** Human label of the admin for audit entries: email when known, else the credential kind. */
export function adminLabel(p: Principal): string {
  return p.email ?? p.via;
}

export interface ResolveResult {
  outcome: ResolveOutcome;
  order: OrderView;
  /** The plan after activation; null for dismissals. */
  subscription: SubscriptionView | null;
}

/** An order dismissed by an admin: closed as expired but still carrying its attention reason. */
function isDismissed(order: BillingOrder): boolean {
  return order.status === 'expired' && order.attention_reason !== null;
}

async function loadOrder(d1: D1DatabaseLike, code: string): Promise<BillingOrder> {
  const order = await getOrderByCode(d1, code);
  if (!order) throw new AppError(404, 'not_found', 'Order not found');
  return order;
}

async function activate(d1: D1DatabaseLike, env: RuntimeEnv, order: BillingOrder, input: ResolveInput, admin: string, request?: Request): Promise<ResolveResult> {
  if (order.status === 'paid') return { outcome: 'already_activated', order: toOrderView(order, env), subscription: null };
  if (order.status !== 'needs_attention' && !isDismissed(order)) {
    throw new AppError(409, 'not_in_attention', `Order ${order.code} is ${order.status} and does not need attention`);
  }
  const nowIso = iso(membersRuntime.now());
  // The guarded update is the idempotency gate: only one concurrent resolver flips the order to paid.
  const res = await d1.prepare(
    `UPDATE billing_orders SET status = 'paid', paid_at = ?, updated_at = ?
     WHERE id = ? AND (status = 'needs_attention' OR (status = 'expired' AND attention_reason IS NOT NULL))`
  ).bind(nowIso, nowIso, order.id).run();
  if (res.meta?.changes !== 1) {
    const current = await loadOrder(d1, order.code);
    if (current.status === 'paid') return { outcome: 'already_activated', order: toOrderView(current, env), subscription: null };
    throw new AppError(409, 'not_in_attention', `Order ${order.code} is ${current.status} and does not need attention`);
  }
  const paid: BillingOrder = { ...order, status: 'paid', paid_at: nowIso, updated_at: nowIso };
  const subscription = await fulfilOrder(d1, env, paid);
  // An admin-activated referred order earns its commission like a webhook-paid one (base capped at collected/owed).
  if (order.referrer_user_id) await captureReferralCommission(d1, env, { kind: 'billing_order', id: order.id });
  await logActivity(d1, order.user_id, 'billing.attention_resolved', {
    code: order.code, action: 'activate', reason: order.attention_reason, note: input.note, admin,
    period_end: subscription?.current_period_end ?? null,
  }, request);
  return { outcome: 'activated', order: toOrderView(paid, env), subscription };
}

async function dismiss(d1: D1DatabaseLike, env: RuntimeEnv, order: BillingOrder, input: ResolveInput, admin: string, request?: Request): Promise<ResolveResult> {
  if (isDismissed(order)) return { outcome: 'already_dismissed', order: toOrderView(order, env), subscription: null };
  if (order.status !== 'needs_attention') {
    throw new AppError(409, 'not_in_attention', `Order ${order.code} is ${order.status} and cannot be dismissed`);
  }
  const nowIso = iso(membersRuntime.now());
  const res = await d1.prepare(
    "UPDATE billing_orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'needs_attention'"
  ).bind(nowIso, order.id).run();
  if (res.meta?.changes !== 1) {
    const current = await loadOrder(d1, order.code);
    if (isDismissed(current)) return { outcome: 'already_dismissed', order: toOrderView(current, env), subscription: null };
    throw new AppError(409, 'not_in_attention', `Order ${order.code} is ${current.status} and cannot be dismissed`);
  }
  await logActivity(d1, order.user_id, 'billing.attention_resolved', {
    code: order.code, action: 'dismiss', reason: order.attention_reason, note: input.note, admin,
  }, request);
  return { outcome: 'dismissed', order: toOrderView({ ...order, status: 'expired', updated_at: nowIso }, env), subscription: null };
}

/**
 * Resolves a flagged SePay order. Repeating the same action is a no-op (`already_*`); activating a
 * dismissed order is allowed (the admin changed their mind), dismissing a paid order is a 409.
 */
export async function resolveBillingOrder(
  d1: D1DatabaseLike, env: RuntimeEnv, code: string, input: ResolveInput, admin: string, request?: Request
): Promise<ResolveResult> {
  const order = await loadOrder(d1, code);
  return input.action === 'activate'
    ? activate(d1, env, order, input, admin, request)
    : dismiss(d1, env, order, input, admin, request);
}
