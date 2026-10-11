/**
 * Health check of an analytics outbox drain run, read from the endpoint's `{ success, data }` body. A run that
 * returned 200 can still hide a delivery problem, so the scheduler warns or fails on it:
 * - fail: analytics is disabled on the production host while events are queued (they would never leave), or
 *   nothing was delivered while the run shows a systemic problem: at least DRAIN_OUTAGE_MIN_CLAIMED rows were
 *   claimed and all failed (the destination is down or the key is wrong), or rows were dead-lettered (a row
 *   only dies after ~22 h of retries or on a rejected payload);
 * - warn: a few claimed rows were all retried (one timeout at low volume is retried with backoff), rows were
 *   dead-lettered while others were delivered, the run was skipped on a non-production host, or the body is
 *   unreadable.
 */
import type { JobOutcome } from './jobs';

/** Claimed rows that must all fail in one run before it counts as an outage rather than a transient retry. */
export const DRAIN_OUTAGE_MIN_CLAIMED = 3;

interface DrainSummary {
  status: string;
  skipped_reason: string | null;
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
  pending: number;
}

function num(record: object, key: string): number {
  const value: unknown = Reflect.get(record, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readSummary(body: unknown): DrainSummary | null {
  if (typeof body !== 'object' || body === null || !('data' in body)) return null;
  const data: unknown = body.data;
  if (typeof data !== 'object' || data === null || !('status' in data) || typeof data.status !== 'string') return null;
  const reason: unknown = 'skipped_reason' in data ? data.skipped_reason : null;
  return {
    status: data.status,
    skipped_reason: typeof reason === 'string' ? reason : null,
    claimed: num(data, 'claimed'), sent: num(data, 'sent'), retried: num(data, 'retried'), dead: num(data, 'dead'), pending: num(data, 'pending'),
  };
}

export function analyticsDrainCheck(body: unknown, _raw: string): JobOutcome {
  const s = readSummary(body);
  if (!s) return { level: 'warn', summary: 'unreadable drain summary' };
  const counts = `claimed=${s.claimed} sent=${s.sent} retried=${s.retried} dead=${s.dead} pending=${s.pending}`;
  if (s.status === 'skipped') {
    if (s.skipped_reason === 'analytics_disabled' && s.pending > 0) {
      return { level: 'fail', summary: `analytics is disabled but ${s.pending} events are queued` };
    }
    return { level: 'warn', summary: `skipped (${s.skipped_reason ?? 'unknown'}) ${counts}` };
  }
  if (s.claimed > 0 && s.sent === 0) {
    if (s.dead > 0) return { level: 'fail', summary: `nothing delivered, dead-lettered ${s.dead} ${counts}` };
    if (s.claimed >= DRAIN_OUTAGE_MIN_CLAIMED) return { level: 'fail', summary: `every delivery failed ${counts}` };
    return { level: 'warn', summary: `transient retry, nothing delivered ${counts}` };
  }
  if (s.dead > 0) return { level: 'warn', summary: `dead-lettered ${s.dead} ${counts}` };
  return { level: 'ok', summary: counts };
}
