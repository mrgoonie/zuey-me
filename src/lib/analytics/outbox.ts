/**
 * Analytics outbox (D1 table `analytics_outbox`). Business flows call `enqueueServerEvent` right after a
 * verified state change; the scheduler job (`drainAnalyticsOutbox`) delivers due rows with retry,
 * exponential backoff and a dead letter after OUTBOX_MAX_ATTEMPTS.
 *
 * Guarantees:
 * - One row per business fact: every row has a `dedupe_key` built from the provider transaction or event id
 *   (unique index), so a repeated webhook, a reconciliation or a recompute inserts nothing.
 * - Delivery is at-least-once with an idempotent id: the row id is the event `uuid` sent on every attempt,
 *   so PostHog de-duplicates a retried send (eventually, at merge time). A row counts as sent once PostHog
 *   (the primary destination) accepted it; GA4 gets a single best-effort copy after that and never decides
 *   whether a row is sent, retried or dead.
 * - Analytics never affects payment: enqueueing validates and inserts inside a catch-all and returns an
 *   outcome; it never throws. The insert is a separate statement after the state change (not a D1 batch
 *   with it) so a missing table or a failed insert can never roll a payment back. The one exception is
 *   `outboxInsertStatement`, for a once-per-fact gate row that must land together with its event (the
 *   Dodo refund/dispute log): the batch holds no payment state, so a failure only makes the webhook retry.
 * - A drain run is bounded: at most MAX_DRAIN_QUERIES D1 statements and DEFAULT_DRAIN_LIMIT deliveries by
 *   default, so it fits the per-invocation limits of the Workers free plan.
 */
import type { D1DatabaseLike, D1PreparedStatementLike } from '../../db/store';
import { iso, membersRuntime } from '../members/runtime';
import type { EventProperties, ServerEventName } from './events';
import { validateEvent } from './events';
import { GA4_OUTBOX_ID_PATHS, purgeExpiredGa4Clients } from './ga4-attribution';
import { isValidDistinctId } from './identity';
import type { DestinationResult, ServerDestination } from './destinations/types';
import { sendServerEvent } from './server';

/**
 * Delays after failed attempts 1..9 are 5, 10, 20, 40, 80, 160, 320 min, then 6 h twice: a row survives a
 * destination outage of about 22 hours before it is dead-lettered on the 10th failure.
 */
export const OUTBOX_MAX_ATTEMPTS = 10;
export const OUTBOX_BASE_DELAY_MS = 5 * 60 * 1000;
export const OUTBOX_MAX_DELAY_MS = 6 * 60 * 60 * 1000;
/** A claimed row whose drain run died is claimable again after this long. */
export const OUTBOX_LEASE_MS = 2 * 60 * 1000;
/**
 * Deliveries per run by default (one PostHog request each), well under the free plan's 50 subrequests. The
 * maximum stays under it too and is what the query budget allows when batches settle in one statement each.
 */
export const DEFAULT_DRAIN_LIMIT = 30;
export const MAX_DRAIN_LIMIT = 40;
/** Wall-clock budget of one drain run; no new batch is claimed after it is spent. */
export const DEFAULT_DRAIN_BUDGET_MS = 20 * 1000;
/** Rows delivered concurrently per batch. */
export const DRAIN_BATCH_SIZE = 10;
/**
 * Most D1 statements one drain run issues (sweep, claims, grouped settles, retention purge, pending count,
 * and the GA id purge when there is room).
 * A batch is claimed only when its worst case (one claim plus one settle per row) still fits.
 */
export const MAX_DRAIN_QUERIES = 20;
/** Delivered rows are deleted this long after delivery. No dedupe key is needed after it (see docs). */
export const OUTBOX_SENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** How far back the drain job looks for plans whose access ended (catches up after missed runs). */
export const EXPIRY_SWEEP_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

const DEDUPE_KEY_RE = /^[A-Za-z0-9_.:@-]{1,300}$/;
const MAX_ERROR_LENGTH = 300;
const PURGE_BATCH = 500;
const SWEEP_LIMIT = 200;
/** Statements a run keeps in reserve for its tail: the retention purge and the pending count. */
const TAIL_QUERIES = 2;

export type EnqueueOutcome = 'queued' | 'duplicate' | 'rejected' | 'failed';

export interface OutboxEventInput<E extends ServerEventName> {
  event: E;
  /** Member id or an opaque guest id. Never an email or name. */
  distinctId: string;
  /** Stable key of the business fact, e.g. `purchase:dodo:pay_123`. */
  dedupeKey: string;
  properties: EventProperties<E>;
  /** When the business fact happened (ISO 8601). Defaults to now. */
  occurredAt?: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

function resolveOccurredAt(value: string | null | undefined, nowMs: number): string {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return iso(Number.isFinite(parsed) ? parsed : nowMs);
}

/** A `payment_events` row whose presence, when the statement runs, means the event must not be queued. */
export interface PaymentEventGuard {
  provider: string;
  eventId: string;
}

/**
 * Validates the event against the taxonomy and PII guard and returns its outbox insert (once per `dedupeKey`)
 * without running it, for a caller that writes the event in one D1 batch with the fact it reports. With
 * `unlessPaymentEvent`, nothing is inserted when that row exists at the time the batch runs. Null when the
 * event is invalid (logged). Throws only if the statement cannot be prepared.
 */
export function outboxInsertStatement<E extends ServerEventName>(
  d1: D1DatabaseLike, input: OutboxEventInput<E>, unlessPaymentEvent?: PaymentEventGuard,
): D1PreparedStatementLike | null {
  if (!DEDUPE_KEY_RE.test(input.dedupeKey) || !isValidDistinctId(input.distinctId)) {
    console.warn(`analytics outbox: rejected ${input.event} (invalid dedupe key or distinct id)`);
    return null;
  }
  const checked = validateEvent(input.event, input.properties, 'server');
  if (!checked.ok) {
    const where = 'property' in checked.error ? ` ${checked.error.property}` : '';
    console.warn(`analytics outbox: rejected ${input.event} (${checked.error.reason}${where})`);
    return null;
  }
  const nowMs = membersRuntime.now();
  const now = iso(nowMs);
  const values = [
    crypto.randomUUID(), input.dedupeKey, input.event, input.distinctId, JSON.stringify(checked.properties),
    resolveOccurredAt(input.occurredAt, nowMs), now, now, now,
  ];
  const columns = 'INSERT INTO analytics_outbox (id, dedupe_key, event, distinct_id, properties, occurred_at, status, attempts, next_attempt_at, created_at, updated_at)';
  if (!unlessPaymentEvent) {
    return d1.prepare(`${columns} VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`).bind(...values);
  }
  return d1.prepare(
    `${columns} SELECT ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM payment_events WHERE provider = ? AND event_id = ?)
     ON CONFLICT (dedupe_key) DO NOTHING`
  ).bind(...values, unlessPaymentEvent.provider, unlessPaymentEvent.eventId);
}

/**
 * Validates the event against the taxonomy and PII guard, then inserts it once per `dedupeKey`.
 * Never throws: returns `rejected` (invalid event, logged), `duplicate`, `queued` or `failed` (logged).
 */
export async function enqueueServerEvent<E extends ServerEventName>(
  d1: D1DatabaseLike | null | undefined, input: OutboxEventInput<E>,
): Promise<EnqueueOutcome> {
  try {
    if (!d1) return 'failed';
    const statement = outboxInsertStatement(d1, input);
    if (!statement) return 'rejected';
    const res = await statement.run();
    return res.meta?.changes === 0 ? 'duplicate' : 'queued';
  } catch (err) {
    console.warn(`analytics outbox: could not queue ${input.event}: ${errorMessage(err)}`);
    return 'failed';
  }
}

// ---------------------------------------------------------------------------------------------------
// Delivery

export interface DrainOptions {
  destinations: ServerDestination[];
  /** Most rows delivered in this run (1..MAX_DRAIN_LIMIT). */
  limit?: number;
  budgetMs?: number;
  /** Per-destination timeout of one delivery. */
  timeoutMs?: number;
  /** Wall clock for the run budget (tests); defaults to Date.now. */
  clock?: () => number;
}

export interface DrainResult {
  /** `skipped`: delivery is off for this host or environment; rows stay queued. */
  status: 'ok' | 'skipped';
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
  /** `subscription_expired` events queued by the expiry sweep. */
  expired_queued: number;
  /** Delivered rows deleted after the retention window. */
  purged: number;
  /** Rows still waiting for delivery after this run (pending or leased). */
  pending: number;
  /** D1 statements this run issued (at most MAX_DRAIN_QUERIES). */
  queries: number;
  /** True when the run stopped because the time or query budget was spent. */
  budget_exhausted: boolean;
}

interface ClaimedRow {
  id: string;
  event: string;
  distinct_id: string;
  properties: string;
  occurred_at: string;
  attempts: number;
}

function isClaimedRow(row: Record<string, unknown>): row is Record<string, unknown> & ClaimedRow {
  return typeof row.id === 'string' && typeof row.event === 'string' && typeof row.distinct_id === 'string'
    && typeof row.properties === 'string' && typeof row.occurred_at === 'string' && typeof row.attempts === 'number';
}

/** Delay before the next attempt after `attempts` failed ones. */
export function backoffMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  return Math.min(OUTBOX_MAX_DELAY_MS, OUTBOX_BASE_DELAY_MS * 2 ** exponent);
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_DRAIN_LIMIT;
  return Math.min(MAX_DRAIN_LIMIT, Math.max(1, Math.floor(value)));
}

/** Claims due rows (and rows whose lease lapsed) for this run; counts the attempt up front. */
async function claimBatch(d1: D1DatabaseLike, leaseToken: string, size: number): Promise<ClaimedRow[]> {
  const nowMs = membersRuntime.now();
  const now = iso(nowMs);
  const { results } = await d1.prepare(
    `UPDATE analytics_outbox SET status = 'sending', lease_token = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
     WHERE id IN (
       SELECT id FROM analytics_outbox
       WHERE (status = 'pending' AND next_attempt_at <= ?) OR (status = 'sending' AND lease_until <= ?)
       ORDER BY next_attempt_at, created_at LIMIT ?
     )
     RETURNING id, event, distinct_id, properties, occurred_at, attempts`
  ).bind(leaseToken, iso(nowMs + OUTBOX_LEASE_MS), now, now, now, size).all<Record<string, unknown>>();
  return (results ?? []).filter(isClaimedRow);
}

function describeFailure(results: DestinationResult[]): string {
  return results.map(r => (r.ok ? `${r.destination}:ok` : `${r.destination}:${r.reason}${r.status ? `:${r.status}` : ''}`)).join(',');
}

/**
 * Statuses that reject the payload itself, so a retry can never succeed. Auth and routing errors
 * (401/403/404) are retried: they come from a wrong or rotated key, which an operator can fix.
 */
const PERMANENT_STATUSES = new Set([400, 413, 422]);

function isPermanentFailure(results: DestinationResult[]): boolean {
  return results.length > 0 && results.every(r => !r.ok && r.reason === 'http' && r.status !== undefined && PERMANENT_STATUSES.has(r.status));
}

type Settled = 'sent' | 'retried' | 'dead';

interface Delivery {
  row: ClaimedRow;
  outcome: Settled;
  error: string | null;
  /** False when delivery crashed: the row is left leased and a later run reclaims it. */
  settle: boolean;
}

async function deliverRow(row: ClaimedRow, options: DrainOptions): Promise<Delivery> {
  let properties: unknown;
  try {
    properties = JSON.parse(row.properties);
  } catch {
    return { row, outcome: 'dead', error: 'invalid_properties_json', settle: true };
  }
  const result = await sendServerEvent(
    { event: row.event, distinctId: row.distinct_id, properties },
    options.destinations,
    { uuid: row.id, occurredAt: row.occurred_at, timeoutMs: options.timeoutMs },
  );
  if (result.delivered) return { row, outcome: 'sent', error: null, settle: true };
  if (result.rejected) {
    const detail = 'property' in result.rejected ? `:${result.rejected.property}` : '';
    return { row, outcome: 'dead', error: `rejected:${result.rejected.reason}${detail}`, settle: true };
  }
  const outcome: Settled = isPermanentFailure(result.results) || row.attempts >= OUTBOX_MAX_ATTEMPTS ? 'dead' : 'retried';
  return { row, outcome, error: describeFailure(result.results), settle: true };
}

/**
 * Writes the outcome of a batch with one UPDATE per group of rows that share it: all sent rows together,
 * dead rows per error, retried rows per (attempt, error). Returns the number of statements issued.
 */
async function settleBatch(d1: D1DatabaseLike, leaseToken: string, deliveries: Delivery[]): Promise<number> {
  const nowMs = membersRuntime.now();
  const now = iso(nowMs);
  const groups = new Map<string, { outcome: Settled; error: string | null; nextAttemptAt: string | null; ids: string[] }>();
  for (const d of deliveries) {
    if (!d.settle) continue;
    const error = d.error ? d.error.slice(0, MAX_ERROR_LENGTH) : null;
    const nextAttemptAt = d.outcome === 'retried' ? iso(nowMs + backoffMs(d.row.attempts)) : null;
    const key = JSON.stringify([d.outcome, error, nextAttemptAt]);
    const group = groups.get(key) ?? { outcome: d.outcome, error, nextAttemptAt, ids: [] };
    group.ids.push(d.row.id);
    groups.set(key, group);
  }
  // A sent or dead row no longer needs the GA ids, so no copy of them outlives delivery (a requeued dead row
  // falls back to the hashed client id).
  const dropGaIds = `properties = CASE WHEN json_valid(properties) THEN json_remove(properties, ${GA4_OUTBOX_ID_PATHS}) ELSE properties END`;
  for (const g of groups.values()) {
    const ids = g.ids.map(() => '?').join(', ');
    if (g.outcome === 'sent') {
      await d1.prepare(
        `UPDATE analytics_outbox SET status = 'sent', sent_at = ?, last_error = NULL, lease_token = NULL, lease_until = NULL, updated_at = ?, ${dropGaIds}
         WHERE lease_token = ? AND id IN (${ids})`
      ).bind(now, now, leaseToken, ...g.ids).run();
    } else if (g.outcome === 'dead') {
      await d1.prepare(
        `UPDATE analytics_outbox SET status = 'dead', last_error = ?, lease_token = NULL, lease_until = NULL, updated_at = ?, ${dropGaIds}
         WHERE lease_token = ? AND id IN (${ids})`
      ).bind(g.error, now, leaseToken, ...g.ids).run();
    } else {
      await d1.prepare(
        `UPDATE analytics_outbox SET status = 'pending', next_attempt_at = ?, last_error = ?, lease_token = NULL, lease_until = NULL, updated_at = ?
         WHERE lease_token = ? AND id IN (${ids})`
      ).bind(g.nextAttemptAt, g.error, now, leaseToken, ...g.ids).run();
    }
  }
  return groups.size;
}

/**
 * Queues `subscription_expired` for plans whose access ended within the lookback window, in one
 * `INSERT … SELECT`. The dedupe key (member, plan, period end) is the one `recomputeSubscription` uses when
 * it revokes access, so each end of access is reported once, whichever path sees it first. Ends already in
 * the outbox are skipped by the select, so the LIMIT only counts new ones.
 */
export async function sweepExpiredSubscriptions(d1: D1DatabaseLike): Promise<number> {
  const nowMs = membersRuntime.now();
  const now = iso(nowMs);
  // The row id is a random v4 UUID (PostHog requires a UUID as event id).
  const res = await d1.prepare(
    `INSERT INTO analytics_outbox (id, dedupe_key, event, distinct_id, properties, occurred_at, status, attempts, next_attempt_at, created_at, updated_at)
     SELECT
       lower(substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-'
         || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(h, 18, 3) || '-' || substr(h, 21, 12)),
       'subscription_expired:' || user_id || ':' || plan || ':' || current_period_end,
       'subscription_expired', user_id, json_object('plan', plan, 'period_end', current_period_end), current_period_end,
       'pending', 0, ?, ?, ?
     FROM (
       SELECT hex(randomblob(16)) AS h, s.user_id, s.plan, s.current_period_end FROM subscriptions s
       WHERE s.status IN ('active', 'expired') AND s.current_period_end <= ? AND s.current_period_end > ?
         AND NOT EXISTS (
           SELECT 1 FROM analytics_outbox o
           WHERE o.dedupe_key = 'subscription_expired:' || s.user_id || ':' || s.plan || ':' || s.current_period_end
         )
       ORDER BY s.current_period_end LIMIT ?
     )
     WHERE true
     ON CONFLICT (dedupe_key) DO NOTHING`
  ).bind(now, now, now, now, iso(nowMs - EXPIRY_SWEEP_LOOKBACK_MS), SWEEP_LIMIT).run();
  return res.meta?.changes ?? 0;
}

/** Same format as the key built in `sweepExpiredSubscriptions`. */
export function subscriptionExpiredKey(userId: string, plan: string, periodEnd: string): string {
  return `subscription_expired:${userId}:${plan}:${periodEnd}`;
}

/** Deletes rows delivered before the retention window (uses the `(status, sent_at)` index). */
async function purgeSent(d1: D1DatabaseLike): Promise<number> {
  const res = await d1.prepare(
    `DELETE FROM analytics_outbox WHERE id IN (
       SELECT id FROM analytics_outbox WHERE status = 'sent' AND sent_at < ? LIMIT ?
     )`
  ).bind(iso(membersRuntime.now() - OUTBOX_SENT_RETENTION_MS), PURGE_BATCH).run();
  return res.meta?.changes ?? 0;
}

/**
 * Enforces the 30-day retention of stored GA ids on the drain's schedule, not only at the next checkout.
 * Best-effort and only when the query budget has room; a busy run leaves it to the next one (every 5 min).
 */
async function purgeGa4ClientsIfBudget(d1: D1DatabaseLike, out: DrainResult): Promise<void> {
  if (out.queries + 1 > MAX_DRAIN_QUERIES) return;
  await purgeExpiredGa4Clients(d1);
  out.queries += 1;
}

async function countPending(d1: D1DatabaseLike): Promise<number> {
  const row = await d1.prepare("SELECT COUNT(*) AS n FROM analytics_outbox WHERE status IN ('pending', 'sending')").first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * One scheduler run: sweep ended plans into the outbox, then deliver due rows in small concurrent batches
 * until `limit` rows, the time budget or the query budget are used up, then purge old delivered rows and
 * count what is still pending. With no destination (not production, or analytics off) nothing is claimed
 * and rows stay queued.
 */
export async function drainAnalyticsOutbox(d1: D1DatabaseLike, options: DrainOptions): Promise<DrainResult> {
  const clock = options.clock ?? Date.now;
  const started = clock();
  const budget = options.budgetMs ?? DEFAULT_DRAIN_BUDGET_MS;
  // Each row may cost one request per destination (GA4 on purchases and refunds): keep the run's worst case
  // at MAX_DRAIN_LIMIT requests, under the Workers free plan's subrequest limit.
  const limit = Math.min(clampLimit(options.limit), Math.max(1, Math.floor(MAX_DRAIN_LIMIT / Math.max(1, options.destinations.length))));
  const out: DrainResult = {
    status: 'ok', claimed: 0, sent: 0, retried: 0, dead: 0, expired_queued: 0, purged: 0, pending: 0, queries: 0,
    budget_exhausted: false,
  };
  out.expired_queued = await sweepExpiredSubscriptions(d1);
  out.queries += 1;
  if (options.destinations.length === 0) {
    out.pending = await countPending(d1);
    out.queries += 1;
    await purgeGa4ClientsIfBudget(d1, out);
    return { ...out, status: 'skipped' };
  }

  const leaseToken = crypto.randomUUID();
  while (out.claimed < limit) {
    const size = Math.min(DRAIN_BATCH_SIZE, limit - out.claimed);
    // Worst case of a batch: its claim plus one settle statement per row.
    if (clock() - started >= budget || out.queries + 1 + size + TAIL_QUERIES > MAX_DRAIN_QUERIES) {
      out.budget_exhausted = true;
      break;
    }
    const batch = await claimBatch(d1, leaseToken, size);
    out.queries += 1;
    if (batch.length === 0) break;
    out.claimed += batch.length;
    const deliveries = await Promise.all(batch.map(async (row): Promise<Delivery> => {
      try {
        return await deliverRow(row, options);
      } catch (err) {
        console.warn(`analytics outbox: delivery of ${row.event} failed: ${errorMessage(err)}`);
        return { row, outcome: 'retried', error: null, settle: false };
      }
    }));
    out.queries += await settleBatch(d1, leaseToken, deliveries);
    for (const d of deliveries) out[d.outcome] += 1;
  }
  out.purged = await purgeSent(d1);
  out.pending = await countPending(d1);
  out.queries += TAIL_QUERIES;
  await purgeGa4ClientsIfBudget(d1, out);
  return out;
}
