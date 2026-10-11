/**
 * zuey-me-scheduler: Cloudflare Worker whose Cron Trigger drives time-based jobs of the zuey.me Pages app
 * (Pages Functions have no cron). Each tick POSTs the app's job endpoint with a shared secret; all logic and
 * idempotency live in the app, so a missed or doubled tick is harmless. Jobs are listed in ./jobs.ts.
 */

import type { SchedulerEnv } from './jobs';
import { runAll } from './jobs';

interface ScheduledEventLike {
  cron: string;
  scheduledTime: number;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async scheduled(_event: ScheduledEventLike, env: SchedulerEnv, ctx: ExecutionContextLike): Promise<void> {
    ctx.waitUntil(runAll(env));
  },
  /** Health check only; jobs never run from public HTTP requests. */
  async fetch(): Promise<Response> {
    return new Response('zuey-me-scheduler: cron worker\n', { headers: { 'Content-Type': 'text/plain' } });
  },
};
