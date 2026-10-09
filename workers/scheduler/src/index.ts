/**
 * zuey-me-scheduler: Cloudflare Worker whose Cron Trigger drives time-based jobs of the zuey.me Pages app
 * (Pages Functions have no cron). Each tick POSTs the app's job endpoint with a shared secret; all logic and
 * idempotency live in the app, so a missed or doubled tick is harmless.
 */

interface Env {
  /** Base URL of the zuey.me app, e.g. https://zuey.me */
  SITE_URL?: string;
  /** Same value as the Pages secret CRON_SECRET. */
  CRON_SECRET?: string;
}

interface ScheduledEventLike {
  cron: string;
  scheduledTime: number;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

const JOBS = ['/api/v1/articles/notifications/dispatch', '/api/v1/courses/jobs/github-invites'];

async function runJob(env: Env, path: string): Promise<string> {
  const base = (env.SITE_URL || 'https://zuey.me').replace(/\/+$/, '');
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CRON_SECRET ?? ''}`, 'Content-Type': 'application/json', 'User-Agent': 'zuey-me-scheduler' },
    body: '{}',
  });
  const body = (await res.text()).slice(0, 500);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${body}`);
  // A 200 can still report per-item failures (e.g. an article whose send Resend rejected).
  if (body.includes('"status":"error"')) throw new Error(`${path} → ${res.status} reported errors: ${body}`);
  return `${path} → ${res.status} ${body}`;
}

async function runAll(env: Env): Promise<void> {
  if (!env.CRON_SECRET) throw new Error('CRON_SECRET is not configured');
  const results = await Promise.allSettled(JOBS.map(path => runJob(env, path)));
  for (const r of results) {
    if (r.status === 'fulfilled') console.log(r.value);
    else console.error(r.reason instanceof Error ? r.reason.message : String(r.reason));
  }
  if (results.some(r => r.status === 'rejected')) throw new Error('One or more scheduled jobs failed');
}

export default {
  async scheduled(_event: ScheduledEventLike, env: Env, ctx: ExecutionContextLike): Promise<void> {
    ctx.waitUntil(runAll(env));
  },
  /** Health check only; jobs never run from public HTTP requests. */
  async fetch(): Promise<Response> {
    return new Response('zuey-me-scheduler: cron worker\n', { headers: { 'Content-Type': 'text/plain' } });
  },
};
