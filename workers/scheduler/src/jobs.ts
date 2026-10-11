/** Job list and runner of the zuey-me-scheduler worker, kept apart from the entrypoint so tests can import it. */
import { analyticsDrainCheck } from './analytics-drain-check';

export interface SchedulerEnv {
  /** Base URL of the zuey.me app, e.g. https://zuey.me */
  SITE_URL?: string;
  /** Same value as the Pages secret CRON_SECRET. */
  CRON_SECRET?: string;
  /**
   * `live` lets the community sweep remove members. Anything else (the default) runs it as a dry run that
   * only reports who would be removed, so the first runs can be reviewed in the worker logs.
   */
  COMMUNITY_SWEEP_MODE?: string;
}

/** How a successful (2xx) job response is judged: `fail` fails the cron run, `warn` is logged with console.warn. */
export interface JobOutcome {
  level: 'ok' | 'warn' | 'fail';
  /** One log line; never the raw body when the job can summarise it. */
  summary: string;
}

export interface Job {
  path: string;
  /** Error codes that mean "not configured here": logged as skipped instead of failing the cron run. */
  skipCodes?: readonly string[];
  /** Judges a 2xx body (already JSON-parsed, or null when it is not JSON). Defaults to `defaultCheck`. */
  check?: (body: unknown, raw: string) => JobOutcome;
}

const LOG_SLICE = 500;

/** A 200 can still report per-item failures (e.g. an article whose send Resend rejected). */
function defaultCheck(_body: unknown, raw: string): JobOutcome {
  const text = raw.slice(0, LOG_SLICE);
  return raw.includes('"status":"error"') ? { level: 'fail', summary: `reported errors: ${text}` } : { level: 'ok', summary: text };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

function count(data: Record<string, unknown>, key: string): number {
  const v = data[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Sweep error codes (from src/lib/experience/community.ts) that mean the sweep as a whole cannot act, as
 * opposed to one membership Telegram refuses (`telegram_error`) or that has no configured group.
 */
const SYSTEMIC_SWEEP_ERRORS: ReadonlySet<string> = new Set(['telegram_unreachable', 'telegram_rate_limited', 'internal_error']);

/**
 * Community sweep: logs counts, action ids with reasons, error codes and the cursor instead of the body
 * (member emails are never part of it). The run fails only when a systemic error (Telegram unreachable or
 * rate limited, an internal error) comes with no progress: nothing removed or revoked in live mode, no
 * planned action in a dry run. Any other error, such as one permanently stuck membership, only warns with
 * the error count, so it never fails every 5-minute run once the backlog is cleared.
 */
export function sweepCheck(body: unknown): JobOutcome {
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  if (!data) return { level: 'fail', summary: 'unexpected sweep response (no data object)' };
  const actionRows = records(data.actions);
  const errorRows = records(data.errors);
  const actions = actionRows.map(a => `${String(a.id)}:${String(a.action)}:${String(a.reason)}`);
  const errors = errorRows.map(e => `${String(e.id)}:${String(e.code)}`);
  const removed = count(data, 'removed');
  const revoked = count(data, 'revoked');
  const summary = [
    `dry_run=${data.dry_run === true}`,
    `checked=${count(data, 'checked')}`,
    `removed=${removed}`,
    `revoked=${revoked}`,
    `exempt_admins=${count(data, 'exempt_admins')}`,
    `errors=${errors.length}${errors.length ? ` [${errors.join(', ')}]` : ''}`,
    `actions=[${actions.join(', ')}]`,
    `next_cursor=${typeof data.next_cursor === 'string' ? data.next_cursor : 'null'}`,
    `complete=${data.complete === true}`,
  ].join(' ');
  if (errors.length === 0) return { level: 'ok', summary };
  const systemic = errorRows.some(e => typeof e.code === 'string' && SYSTEMIC_SWEEP_ERRORS.has(e.code));
  const progressed = data.dry_run === true ? actionRows.length > 0 : removed + revoked > 0;
  return { level: systemic && !progressed ? 'fail' : 'warn', summary };
}

export function scheduledJobs(env: SchedulerEnv): Job[] {
  const sweepLive = env.COMMUNITY_SWEEP_MODE?.trim().toLowerCase() === 'live';
  return [
    { path: '/api/v1/articles/notifications/dispatch' },
    { path: '/api/v1/referrals/jobs/run' },
    { path: '/api/v1/courses/jobs/github-invites' },
    {
      path: sweepLive ? '/api/v1/community/sweep' : '/api/v1/community/sweep?dry_run=1',
      skipCodes: ['community_unconfigured'],
      check: sweepCheck,
    },
    // Delivers queued server analytics events (purchases, subscription lifecycle, sign-ins) with retry.
    { path: '/api/v1/analytics/outbox/drain', check: analyticsDrainCheck },
  ];
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Error code from the app's `{ success: false, error: { code } }` envelope, or null. */
function errorCode(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  return typeof body.error.code === 'string' ? body.error.code : null;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Resolves with the line to log (and whether it is a warning); rejects when the job failed. */
export async function runJob(env: SchedulerEnv, job: Job, fetchImpl: FetchLike = fetch): Promise<JobOutcome> {
  const base = (env.SITE_URL || 'https://zuey.me').replace(/\/+$/, '');
  const res = await fetchImpl(`${base}${job.path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CRON_SECRET ?? ''}`, 'Content-Type': 'application/json', 'User-Agent': 'zuey-me-scheduler' },
    body: '{}',
  });
  const raw = await res.text();
  const body = parseJson(raw);
  if (!res.ok) {
    const code = errorCode(body);
    if (res.status === 503 && code && job.skipCodes?.includes(code)) return { level: 'ok', summary: `${job.path} → skipped (${code})` };
    throw new Error(`${job.path} → ${res.status} ${raw.slice(0, LOG_SLICE)}`);
  }
  const outcome = (job.check ?? defaultCheck)(body, raw);
  const line = `${job.path} → ${res.status} ${outcome.summary}`;
  if (outcome.level === 'fail') throw new Error(line);
  return { level: outcome.level, summary: line };
}

export async function runAll(env: SchedulerEnv, fetchImpl: FetchLike = fetch): Promise<void> {
  if (!env.CRON_SECRET) throw new Error('CRON_SECRET is not configured');
  const results = await Promise.allSettled(scheduledJobs(env).map(job => runJob(env, job, fetchImpl)));
  for (const r of results) {
    if (r.status === 'rejected') console.error(r.reason instanceof Error ? r.reason.message : String(r.reason));
    else if (r.value.level === 'warn') console.warn(r.value.summary);
    else console.log(r.value.summary);
  }
  if (results.some(r => r.status === 'rejected')) throw new Error('One or more scheduled jobs failed');
}
