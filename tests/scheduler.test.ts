import { describe, expect, it } from 'bun:test';
import type { FetchLike } from '../workers/scheduler/src/jobs';
import { runAll, runJob, scheduledJobs } from '../workers/scheduler/src/jobs';

const SWEEP = '/api/v1/community/sweep';
const env = { SITE_URL: 'https://zuey.test/', CRON_SECRET: 'cron-secret' };

function respond(status: number, body: unknown): FetchLike {
  return async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The rejection message of a promise, or null when it resolved. */
async function failure(p: Promise<unknown>): Promise<string | null> {
  return p.then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
}

const unconfigured ={ success: false, error: { code: 'community_unconfigured', message: 'The Telegram community is not configured yet' } };

describe('scheduler worker jobs', () => {
  it('runs the community sweep as a dry run unless COMMUNITY_SWEEP_MODE is live', () => {
    const sweepPath = (mode?: string) => scheduledJobs({ ...env, COMMUNITY_SWEEP_MODE: mode }).find(j => j.path.startsWith(SWEEP))?.path;
    expect(sweepPath()).toBe(`${SWEEP}?dry_run=1`);
    expect(sweepPath('dry_run')).toBe(`${SWEEP}?dry_run=1`);
    expect(sweepPath('LIVE ')).toBe(SWEEP);
    expect(scheduledJobs(env).map(j => j.path)).toContain('/api/v1/articles/notifications/dispatch');
  });

  it('posts with the cron secret and treats 503 community_unconfigured as skipped', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(unconfigured), { status: 503 });
    };
    const [sweep] = scheduledJobs(env).filter(j => j.path.startsWith(SWEEP));
    expect(await runJob(env, sweep, fetchImpl)).toEqual({ level: 'ok', summary: `${SWEEP}?dry_run=1 → skipped (community_unconfigured)` });
    expect(calls[0].url).toBe(`https://zuey.test${SWEEP}?dry_run=1`);
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer cron-secret');
  });

  it('still fails on other errors, and on unconfigured jobs that did not opt into skipping', async () => {
    const [sweep] = scheduledJobs(env).filter(j => j.path.startsWith(SWEEP));
    expect(await failure(runJob(env, sweep, respond(503, { success: false, error: { code: 'database_unavailable', message: 'x' } })))).toContain('503');
    expect(await failure(runJob(env, sweep, respond(500, { success: false, error: { code: 'community_unconfigured', message: 'x' } })))).toContain('500');
    expect(await failure(runJob(env, { path: '/api/v1/referrals/jobs/run' }, respond(503, unconfigured)))).toContain('503');
    expect(await failure(runJob(env, sweep, async () => new Response('<html>bad gateway</html>', { status: 503 })))).toContain('503');
  });

  it('does not fail the whole run when only the community sweep is unconfigured', async () => {
    const fetchImpl: FetchLike = async url => (url.includes(SWEEP) ? new Response(JSON.stringify(unconfigured), { status: 503 }) : new Response('{"success":true,"data":{}}'));
    const log = console.log;
    console.log = () => {};
    try {
      expect(await failure(runAll(env, fetchImpl))).toBeNull();
    } finally {
      console.log = log;
    }
    expect(await failure(runAll({ SITE_URL: env.SITE_URL }, fetchImpl))).toContain('CRON_SECRET');
  });

  describe('community sweep results', () => {
    const [sweep] = scheduledJobs({ ...env, COMMUNITY_SWEEP_MODE: 'live' }).filter(j => j.path.startsWith(SWEEP));
    const result = (over: Record<string, unknown>) => ({
      success: true,
      data: {
        dry_run: false, checked: 3, removed: 0, revoked: 0, exempt_admins: 1, actions: [], errors: [], next_cursor: null, complete: true, ...over,
      },
    });
    const removeAction = { id: 'cm_1', user_id: 'usr_1', chat: 'vi', telegram_user_id: '501', action: 'remove', reason: 'entitlement_lapsed' };
    const telegramDown = { id: 'cm_2', code: 'telegram_unreachable', message: 'Telegram banChatMember could not be reached' };

    it('logs a compact summary with counts, action ids, reasons, error codes and the cursor', async () => {
      const actions = Array.from({ length: 60 }, (_, i) => ({ ...removeAction, id: `cm_${String(i).padStart(3, '0')}` }));
      const outcome = await runJob(env, sweep, respond(200, result({ removed: 60, actions, next_cursor: 'cm_059', complete: false })));
      expect(outcome.level).toBe('ok');
      expect(outcome.summary).toContain('dry_run=false checked=3 removed=60 revoked=0 exempt_admins=1 errors=0');
      // Every action survives (no 500-character cut), and per-member detail is limited to ids and reasons.
      expect(outcome.summary).toContain('cm_000:remove:entitlement_lapsed');
      expect(outcome.summary).toContain('cm_059:remove:entitlement_lapsed');
      expect(outcome.summary).toContain('next_cursor=cm_059 complete=false');
      expect(outcome.summary).not.toContain('usr_1');
      expect(outcome.summary).not.toContain('501');
    });

    it('fails the run when the sweep reports errors and changed nothing', async () => {
      const message = await failure(runJob(env, sweep, respond(200, result({ errors: [telegramDown] }))));
      expect(message).toContain('errors=1 [cm_2:telegram_unreachable]');
      expect(message).not.toContain('could not be reached');
    });

    it('fails when Telegram rate limits the sweep and nothing changed', async () => {
      const limited = { id: 'cm_3', code: 'telegram_rate_limited', message: 'Telegram banChatMember is rate limited' };
      expect(await failure(runJob(env, sweep, respond(200, result({ errors: [limited] }))))).toContain('errors=1 [cm_3:telegram_rate_limited]');
    });

    it('only warns for one stuck membership Telegram refuses, even when nothing was removed', async () => {
      const refused = { id: 'cm_4', code: 'telegram_error', message: 'Telegram banChatMember failed: Bad Request: can\'t remove chat owner' };
      const outcome = await runJob(env, sweep, respond(200, result({ errors: [refused] })));
      expect(outcome.level).toBe('warn');
      expect(outcome.summary).toContain('errors=1 [cm_4:telegram_error]');
    });

    it('only warns for a membership without a configured group in a dry run with no actions', async () => {
      const missingGroup = { id: 'cm_5', code: 'community_unconfigured', message: 'No configured group or Telegram user for membership cm_5' };
      const outcome = await runJob(env, sweep, respond(200, result({ dry_run: true, errors: [missingGroup] })));
      expect(outcome.level).toBe('warn');
      expect(outcome.summary).toContain('dry_run=true');
      expect(outcome.summary).toContain('errors=1');
    });

    it('treats planned actions as progress in a dry run', async () => {
      const outcome = await runJob(env, sweep, respond(200, result({ dry_run: true, actions: [removeAction], errors: [telegramDown] })));
      expect(outcome.level).toBe('warn');
    });

    it('warns with the error count when some memberships failed but others were processed', async () => {
      const outcome = await runJob(env, sweep, respond(200, result({ removed: 1, actions: [removeAction], errors: [telegramDown] })));
      expect(outcome.level).toBe('warn');
      expect(outcome.summary).toContain('errors=1');
      const warned: string[] = [];
      const [warn, log] = [console.warn, console.log];
      console.warn = (msg: string) => { warned.push(msg); };
      console.log = () => {};
      try {
        const fetchImpl: FetchLike = async url => (url.includes(SWEEP)
          ? new Response(JSON.stringify(result({ revoked: 1, errors: [telegramDown] })))
          : new Response('{"success":true,"data":{}}'));
        expect(await failure(runAll({ ...env, COMMUNITY_SWEEP_MODE: 'live' }, fetchImpl))).toBeNull();
      } finally {
        console.warn = warn;
        console.log = log;
      }
      expect(warned.length).toBe(1);
      expect(warned[0]).toContain('errors=1');
    });

    it('fails on a response without a data object', async () => {
      expect(await failure(runJob(env, sweep, respond(200, { success: true })))).toContain('unexpected sweep response');
    });
  });
});
