import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createApiKey } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { membersRuntime } from '../src/lib/members/runtime';
import { createMemberSession } from '../src/lib/members/session';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { resolveLocale } from '../src/lib/i18n/locales';
import { clearMemoryCache, experienceRuntime } from '../src/lib/experience/runtime';
import { countEventsByDay } from '../src/lib/experience/activity-days';
import { sanitizeEvent } from '../src/lib/experience/github-activity';
import { conditionFromCode } from '../src/lib/experience/weather';
import { experienceMcpModule } from '../src/lib/experience/mcp';
import { experienceOpenApi } from '../src/lib/experience/openapi';
import { MCP_FEATURE_MODULES } from '../src/lib/mcp/registry';
import { OPENAPI_FRAGMENTS } from '../src/lib/openapi/registry';
import type { McpContext } from '../src/lib/mcp/types';
import { AppError } from '../src/lib/http';
import { HOME_STRINGS, profileContentLocale } from '../src/components/home/home-i18n';
import { framePosition, parseMascotManifest } from '../src/components/home/mascot-manifest';
import { addDismissed, nextNoticeChange, parseDismissed, pickNotice } from '../src/components/home/notice-queue';
import { parseActivity, parseArticleHits, parseCalendar, parseCommunity, parseNotices, parseWeather } from '../src/components/home/api-client';
import type { PublicNotice } from '../src/lib/experience/notices';
import { GET as noticesListApi, POST as noticesCreateApi } from '../src/pages/api/v1/notices/index';
import { GET as noticesActiveApi } from '../src/pages/api/v1/notices/active';
import { POST as noticeExpireApi } from '../src/pages/api/v1/notices/[id]/expire';
import { GET as githubActivityApi } from '../src/pages/api/v1/github/activity';
import { GET as githubCalendarApi } from '../src/pages/api/v1/github/calendar';
import { parseContributionCalendar } from '../src/lib/experience/github-calendar';
import { GET as weatherApi } from '../src/pages/api/v1/weather/index';
import { GET as communityStatusApi } from '../src/pages/api/v1/community/index';
import { POST as communityInviteApi } from '../src/pages/api/v1/community/invite';
import { POST as communitySweepApi } from '../src/pages/api/v1/community/sweep';
import { POST as telegramWebhookApi } from '../src/pages/api/v1/community/telegram-webhook';

const ORIGIN = 'https://zuey.test';
const T0 = Date.parse('2026-10-05T03:00:00.000Z');
const HOUR = 60 * 60 * 1000;

type TestDb = ReturnType<typeof createTestD1>;
let d1: TestDb;
let now: number;
let fetchLog: { url: string; init?: RequestInit }[];
let routes: ((url: string, init?: RequestInit) => Response | Promise<Response> | null)[];
const originalFetch = experienceRuntime.fetch;
const originalNow = membersRuntime.now;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const baseEnv = (extra: Partial<RuntimeEnv> = {}): RuntimeEnv => ({ DB: d1, PUBLIC_SITE_URL: ORIGIN, ADMIN_EMAILS: 'boss@example.com', ...extra });

interface CtxOpts { env?: RuntimeEnv; method?: string; path?: string; body?: unknown; headers?: Record<string, string>; params?: Record<string, string> }

function ctx(opts: CtxOpts): APIContext {
  const headers = new Headers(opts.headers ?? {});
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json');
  const request = new Request(`${ORIGIN}${opts.path ?? '/api/test'}`, {
    method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  // Handlers only read request/params/locals; a full APIContext is not constructible in tests.
  const partial = { request, params: opts.params ?? {}, url: new URL(request.url), locals: { runtime: { env: opts.env ?? baseEnv() } } };
  return partial as unknown as APIContext;
}

interface Envelope { status: number; data: unknown; code: string | null; extra: Record<string, unknown> }

async function read(res: Response): Promise<Envelope> {
  const body: unknown = await res.json();
  if (!isRecord(body)) throw new Error('non-object body');
  const error = isRecord(body.error) ? body.error : null;
  return { status: res.status, data: body.data, code: error ? String(error.code) : null, extra: error ?? {} };
}

function field(v: unknown, ...path: string[]): unknown {
  let cur: unknown = v;
  for (const key of path) cur = isRecord(cur) ? cur[key] : undefined;
  return cur;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

async function memberCookie(email: string): Promise<{ cookie: string; userId: string }> {
  const { user } = await findOrCreateVerifiedUser(d1, { email });
  const { token } = await createMemberSession(d1, user.id);
  return { cookie: `zuey_member=${token}`, userId: user.id };
}

function browser(cookie: string): Record<string, string> {
  return { cookie, Origin: ORIGIN };
}

async function grantPlan(userId: string, plan: string, endMs: number): Promise<void> {
  const ts = new Date(now).toISOString();
  await d1.prepare(
    "INSERT INTO subscriptions (id, user_id, plan, status, current_period_end, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?) ON CONFLICT (user_id, plan) DO UPDATE SET current_period_end = excluded.current_period_end"
  ).bind(`sub_${userId}_${plan}`, userId, plan, new Date(endMs).toISOString(), ts, ts).run();
}

beforeEach(() => {
  d1 = createTestD1();
  now = T0;
  membersRuntime.now = () => now;
  fetchLog = [];
  routes = [];
  clearMemoryCache();
  experienceRuntime.fetch = async (url, init) => {
    fetchLog.push({ url, init });
    for (const route of routes) {
      const res = await route(url, init);
      if (res) return res;
    }
    return json({ error: 'unexpected request' }, 500);
  };
});

afterEach(() => {
  experienceRuntime.fetch = originalFetch;
  membersRuntime.now = originalNow;
});

describe('locale resolution', () => {
  it('prefers ?lang, then the cookie, then Accept-Language, then Vietnamese', () => {
    const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
    expect(resolveLocale(req(`${ORIGIN}/?lang=ja`, { cookie: 'zuey_locale=ko', 'accept-language': 'zh-CN' }))).toBe('ja');
    expect(resolveLocale(req(`${ORIGIN}/?lang=xx`, { cookie: 'zuey_locale=ko', 'accept-language': 'zh-CN' }))).toBe('ko');
    expect(resolveLocale(req(`${ORIGIN}/`, { 'accept-language': 'fr-FR,zh-CN;q=0.8' }))).toBe('zh');
    expect(resolveLocale(req(`${ORIGIN}/`))).toBe('vi');
  });

  it('falls back to English profile content for zh/ko/ja and ships UI strings for every locale', () => {
    expect(profileContentLocale('vi')).toBe('vi');
    expect(profileContentLocale('en')).toBe('en');
    expect(profileContentLocale('zh')).toBe('en');
    expect(profileContentLocale('ko')).toBe('en');
    expect(profileContentLocale('ja')).toBe('en');
    for (const strings of Object.values(HOME_STRINGS)) {
      expect(strings.activity.title.length).toBeGreaterThan(0);
      expect(strings.palette.items.mcp.length).toBeGreaterThan(0);
      expect(Object.keys(strings.offer.plans)).toEqual(['knowledges', 'ai', 'combo', 'community']);
    }
  });
});

describe('Duy notices', () => {
  const create = (headers: Record<string, string>, body: unknown) =>
    noticesCreateApi(ctx({ method: 'POST', path: '/api/v1/notices', headers, body }));
  const active = (headers: Record<string, string> = {}, lang = 'vi') =>
    noticesActiveApi(ctx({ path: `/api/v1/notices/active?lang=${lang}`, headers }));

  it('only admins can create, list and expire notices', async () => {
    const body = { text: { vi: 'Xin chào' }, ttl_hours: 2 };
    expect((await read(await create({}, body))).code).toBe('unauthorized');
    const member = await memberCookie('reader@example.com');
    expect((await read(await create(browser(member.cookie), body))).code).toBe('forbidden');
    expect((await read(await noticesListApi(ctx({ path: '/api/v1/notices', headers: browser(member.cookie) })))).status).toBe(403);

    const admin = await memberCookie('boss@example.com');
    const created = await read(await create(browser(admin.cookie), body));
    expect(created.status).toBe(201);
    expect(field(created.data, 'created_by')).toBe('boss@example.com');

    const { key } = await createApiKey('ops', 'admin', d1);
    const viaKey = await read(await create({ Authorization: `Bearer ${key}` }, { text: 'Bản tin', locale: 'vi', ttl_hours: 1 }));
    expect(viaKey.status).toBe(201);

    const id = String(field(created.data, 'id'));
    const denied = await read(await noticeExpireApi(ctx({ method: 'POST', params: { id }, headers: browser(member.cookie) })));
    expect(denied.status).toBe(403);
    const expired = await read(await noticeExpireApi(ctx({ method: 'POST', params: { id }, headers: browser(admin.cookie) })));
    expect(field(expired.data, 'status')).toBe('expired');
  });

  it('rejects cross-site admin writes and invalid input', async () => {
    const admin = await memberCookie('boss@example.com');
    const csrf = await read(await create({ cookie: admin.cookie, Origin: 'https://evil.example' }, { text: { vi: 'x' }, ttl_hours: 1 }));
    expect(csrf.status).toBe(403);
    const bad = async (body: unknown) => (await read(await create(browser(admin.cookie), body))).extra.field;
    expect(await bad({ text: {}, ttl_hours: 1 })).toBe('text');
    expect(await bad({ text: { fr: 'Bonjour' }, ttl_hours: 1 })).toBe('text');
    expect(await bad({ text: { vi: 'x'.repeat(501) }, ttl_hours: 1 })).toBe('text.vi');
    expect(await bad({ text: { vi: 'x' }, expression: 'angry', ttl_hours: 1 })).toBe('expression');
    expect(await bad({ text: { vi: 'x' }, target: 'plan', ttl_hours: 1 })).toBe('plan');
    expect(await bad({ text: { vi: 'x' }, target: 'all', plan: 'combo', ttl_hours: 1 })).toBe('plan');
    expect(await bad({ text: { vi: 'x' } })).toBe('expires_at');
    expect(await bad({ text: { vi: 'x' }, expires_at: new Date(now - HOUR).toISOString() })).toBe('expires_at');
    expect(await bad({ text: { vi: 'x' }, ttl_hours: 24 * 31 })).toBe('expires_at');
  });

  it('targets all / members / one plan and resolves the locale with a fallback', async () => {
    const admin = await memberCookie('boss@example.com');
    const send = async (body: Record<string, unknown>) => String(field((await read(await create(browser(admin.cookie), { ttl_hours: 4, ...body }))).data, 'id'));
    const all = await send({ text: { en: 'Hello everyone', vi: 'Chào mọi người' }, expression: 'wave' });
    const members = await send({ text: { vi: 'Chỉ thành viên' }, target: 'members' });
    const community = await send({ text: { en: 'Community only' }, target: 'plan', plan: 'community' });

    const ids = async (headers: Record<string, string> = {}, lang = 'vi') => list(field((await read(await active(headers, lang))).data, 'notices')).map(n => field(n, 'id'));
    expect(await ids()).toEqual([all]);

    const reader = await memberCookie('reader@example.com');
    expect((await ids(browser(reader.cookie))).sort()).toEqual([all, members].sort());

    await grantPlan(reader.userId, 'community', now + 30 * 24 * HOUR);
    expect((await ids(browser(reader.cookie))).sort()).toEqual([all, members, community].sort());

    const ja = await read(await active({}, 'ja'));
    const first = list(field(ja.data, 'notices'))[0];
    expect(field(first, 'text')).toBe('Hello everyone');
    expect(field(first, 'locale')).toBe('en');
    expect(field(first, 'expression')).toBe('wave');
    const vi = list(field((await read(await active({}, 'vi'))).data, 'notices'))[0];
    expect(field(vi, 'text')).toBe('Chào mọi người');
  });

  it('respects the start/expiry window (TTL) and never returns expired notices', async () => {
    const admin = await memberCookie('boss@example.com');
    const later = new Date(now + 2 * HOUR).toISOString();
    await read(await create(browser(admin.cookie), { text: { vi: 'Sắp tới' }, starts_at: later, ttl_hours: 1 }));
    await read(await create(browser(admin.cookie), { text: { vi: 'Ngắn' }, ttl_hours: 1 }));
    const texts = async () => list(field((await read(await active())).data, 'notices')).map(n => field(n, 'text'));
    expect(await texts()).toEqual(['Ngắn']);
    now += 2.5 * HOUR;
    expect(await texts()).toEqual(['Sắp tới']);
    now += 1 * HOUR;
    expect(await texts()).toEqual([]);
    const all = await read(await noticesListApi(ctx({ path: '/api/v1/notices?include_expired=1', headers: browser(admin.cookie) })));
    expect(list(field(all.data, 'notices')).map(n => field(n, 'status'))).toEqual(['expired', 'expired']);
  });

  it('exposes notice_send / notice_list / notice_expire over MCP for admins only', async () => {
    const mcpCtx = (headers: Record<string, string>): McpContext => ({
      request: new Request(`${ORIGIN}/api/mcp`, { method: 'POST', headers }),
      env: baseEnv(),
      d1,
      async requireAdmin() { /* unused by this module */ },
      async isAdmin() { return false; },
    });
    const denied = await experienceMcpModule.call('notice_send', { text: { vi: 'x' }, ttl_hours: 1 }, mcpCtx({})).then(() => null, (e: unknown) => e);
    expect(denied).toBeInstanceOf(AppError);
    const { key } = await createApiKey('ops', 'admin', d1);
    const admin = mcpCtx({ Authorization: `Bearer ${key}` });
    const sent = await experienceMcpModule.call('notice_send', { text: { en: 'From MCP' }, expression: 'happy', ttl_hours: 1 }, admin);
    const id = String(field(sent, 'id'));
    expect(list(field(await experienceMcpModule.call('notice_list', {}, admin), 'notices')).map(n => field(n, 'id'))).toContain(id);
    expect(field(await experienceMcpModule.call('notice_expire', { id }, admin), 'status')).toBe('expired');
    expect(MCP_FEATURE_MODULES).toContain(experienceMcpModule);
    expect(OPENAPI_FRAGMENTS).toContain(experienceOpenApi);
    for (const path of ['/api/v1/notices', '/api/v1/notices/active', '/api/v1/github/activity', '/api/v1/github/calendar', '/api/v1/weather', '/api/v1/community/invite', '/api/v1/community/sweep']) {
      expect(Object.keys(experienceOpenApi.paths)).toContain(path);
    }
  });
});

function ghEvent(i: number, createdAt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: String(i), type: 'PushEvent', repo: { name: 'mrgoonie/zuey' }, created_at: createdAt,
    payload: { ref: 'refs/heads/main', size: 2 }, actor: { login: 'mrgoonie', avatar_url: 'https://x' }, ...extra,
  };
}

function ghPage(start: number, count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, k) => ghEvent(start + k, new Date(T0 - (start + k) * HOUR).toISOString()));
}

describe('public GitHub activity', () => {
  const call = async () => read(await githubActivityApi(ctx({ path: '/api/v1/github/activity' })));

  it('fetches up to 3 pages, sanitizes, sorts and caches for 15 minutes', async () => {
    routes.push(url => {
      const page = Number(new URL(url).searchParams.get('page'));
      if (!url.startsWith('https://api.github.com/users/mrgoonie/events/public')) return null;
      if (page === 1) return json(ghPage(0, 100), 200, { etag: 'W/"abc"' });
      if (page === 2) return json(ghPage(100, 100));
      return json(ghPage(200, 50));
    });
    const first = await call();
    expect(first.status).toBe(200);
    expect(field(first.data, 'source')).toBe('live');
    const events = list(field(first.data, 'snapshot', 'events'));
    expect(events.length).toBe(250);
    expect(field(events[0], 'created_at')).toBe(new Date(T0).toISOString());
    expect(field(events[0], 'commits')).toBe(2);
    expect(field(events[0], 'ref')).toBe('main');
    expect(JSON.stringify(events[0])).not.toContain('actor');
    expect(fetchLog.length).toBe(3);
    expect(fetchLog[0].init?.headers && JSON.stringify(fetchLog[0].init.headers)).not.toContain('Authorization');

    now += 10 * 60 * 1000;
    expect(field((await call()).data, 'source')).toBe('cache');
    expect(fetchLog.length).toBe(3);

    // After 15 minutes the newest page is revalidated with its ETag; 304 keeps the snapshot.
    now += 6 * 60 * 1000;
    routes.unshift((url, init) => (url.includes('page=1') && JSON.stringify(init?.headers).includes('W/\\"abc\\"') ? new Response(null, { status: 304 }) : null));
    const revalidated = await call();
    expect(field(revalidated.data, 'source')).toBe('revalidated');
    expect(list(field(revalidated.data, 'snapshot', 'events')).length).toBe(250);
    expect(fetchLog.length).toBe(4);
  });

  it('reports rate limits with retry time, then serves stale data with an error once cached', async () => {
    const resetAt = Math.floor(now / 1000) + 600;
    routes.push(() => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) }));
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(limited.code).toBe('github_rate_limited');
    expect(limited.extra.retry_after_seconds).toBe(600);
    // The block is remembered: no new upstream call until the window resets.
    const before = fetchLog.length;
    expect((await call()).status).toBe(429);
    expect(fetchLog.length).toBe(before);

    now += 11 * 60 * 1000;
    routes.unshift(url => (url.includes('page=1') ? json(ghPage(0, 3)) : null));
    expect(field((await call()).data, 'source')).toBe('live');

    now += 16 * 60 * 1000;
    routes.unshift(() => { throw new TypeError('network down'); });
    const stale = await call();
    expect(stale.status).toBe(200);
    expect(field(stale.data, 'source')).toBe('stale');
    expect(field(stale.data, 'error', 'code')).toBe('github_unavailable');
    expect(list(field(stale.data, 'snapshot', 'events')).length).toBe(3);
  });

  it('answers 503 when GitHub is down and nothing is cached', async () => {
    routes.push(() => json({ message: 'boom' }, 500));
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.code).toBe('github_unavailable');
  });

  it('drops malformed events and counts a continuous per-day window', () => {
    expect(sanitizeEvent({ id: '1', type: 'PushEvent' })).toBeNull();
    expect(sanitizeEvent(ghEvent(1, 'not-a-date'))).toBeNull();
    expect(sanitizeEvent(ghEvent(1, '2026-10-01T00:00:00Z', { repo: { name: '../../evil' } }))).toBeNull();
    const pr = sanitizeEvent(ghEvent(2, '2026-10-01T00:00:00Z', {
      type: 'PullRequestEvent',
      payload: { action: 'opened', pull_request: { number: 7, title: 'Add mascot', html_url: 'https://github.com/mrgoonie/zuey/pull/7' } },
    }));
    expect(field(pr, 'url')).toBe('https://github.com/mrgoonie/zuey/pull/7');
    expect(field(pr, 'number')).toBe(7);
    const days = countEventsByDay(
      [{ created_at: '2026-10-01T18:00:00Z' }, { created_at: '2026-10-03T01:00:00Z' }, { created_at: '2026-10-03T02:00:00Z' }],
      'Asia/Saigon', '2026-10-04T00:00:00Z',
    );
    // 18:00Z on Oct 1 is Oct 2 in Saigon (UTC+7).
    expect(days).toEqual([{ date: '2026-10-02', count: 1 }, { date: '2026-10-03', count: 2 }, { date: '2026-10-04', count: 0 }]);
  });
});

interface FixtureDay { date: string; level: number; count: number | null }

/** Mirrors github.com/users/<u>/contributions: cells, detached <tool-tip>s and the yearly heading. */
function ghCalendarHtml(days: FixtureDay[], heading: string | null = '1,234'): string {
  const id = (i: number) => `contribution-day-component-${i % 7}-${Math.floor(i / 7)}`;
  const cells = days.map((d, i) =>
    `<td tabindex="0" data-ix="${Math.floor(i / 7)}" aria-selected="false" aria-describedby="contribution-graph-legend-level-${d.level}" style="width: 10px" data-date="${d.date}" id="${id(i)}" data-level="${d.level}" role="gridcell" data-view-component="true" class="ContributionCalendar-day"></td>`);
  const tips = days.flatMap((d, i) => (d.count === null ? [] : [
    `<tool-tip id="tooltip-${i}" for="${id(i)}" popover="manual" data-direction="n" data-type="label" data-view-component="true" class="sr-only position-absolute">${d.count === 0 ? 'No contributions' : `${d.count.toLocaleString('en-US')} contribution${d.count === 1 ? '' : 's'}`} on ${d.date}.</tool-tip>`,
  ]));
  const h2 = heading === null ? '' : `<h2 id="js-contribution-activity-description" class="f4 text-normal mb-2">\n      ${heading}\n      contributions\n        in the last year\n    </h2>`;
  return `<div class="js-yearly-contributions">${h2}<table class="ContributionCalendar-grid js-calendar-graph-table"><tbody><tr style="height: 10px"><td class="ContributionCalendar-label"><span class="sr-only">Sunday</span></td>${cells.join('\n')}</tr></tbody></table>\n${tips.join('\n')}</div>`;
}

function calendarDays(n: number, endDate = '2026-10-05'): FixtureDay[] {
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => {
    const date = new Date(end - (n - 1 - i) * 24 * HOUR).toISOString().slice(0, 10);
    return { date, level: i % 5, count: i % 5 === 0 ? 0 : i % 5 * 3 };
  });
}

describe('GitHub contribution calendar', () => {
  const call = async () => githubCalendarApi(ctx({ path: '/api/v1/github/calendar' }));
  const SOURCE = 'https://github.com/users/mrgoonie/contributions';

  it('parses cells, tool-tip counts and the yearly total from GitHub HTML', () => {
    const html = [
      '<h2 id="js-contribution-activity-description" class="f4 text-normal mb-2">',
      '      1,234', '      contributions', '        in the last year', '    </h2>',
      // Attribute order differs between cells; a later cell comes first in the markup.
      '<td data-level="4" id="c-2" data-date="2026-10-03" class="ContributionCalendar-day" role="gridcell"></td>',
      '<td tabindex="-1" data-date="2026-10-01" id="c-0" data-level="0" class="ContributionCalendar-day"></td>',
      "<td data-date='2026-10-02' id='c-1' data-level='1'></td>",
      '<td data-date="2026-10-04" id="c-3" data-level="2"></td>',
      '<td data-date="not-a-date" id="c-9" data-level="3"></td>',
      '<tool-tip id="t0" for="c-0" popover="manual" class="sr-only">No contributions on October 1st.</tool-tip>',
      '<tool-tip id="t1" for="c-1" popover="manual">1 contribution on October 2nd.</tool-tip>',
      '<tool-tip id="t2" for="c-2" popover="manual">1,024 contributions on October 3rd.</tool-tip>',
    ].join('\n');
    const parsed = parseContributionCalendar(html);
    expect(parsed.total).toBe(1234);
    expect(parsed.days).toEqual([
      { date: '2026-10-01', count: 0, level: 0 },
      { date: '2026-10-02', count: 1, level: 1 },
      { date: '2026-10-03', count: 1024, level: 4 },
      // No tool-tip for this cell: level only.
      { date: '2026-10-04', count: null, level: 2 },
    ]);
  });

  it('sums counts without a heading, falls back to level-only and keeps the last 53 weeks', () => {
    const days = calendarDays(10);
    const summed = parseContributionCalendar(ghCalendarHtml(days, null));
    expect(summed.total).toBe(days.reduce((s, d) => s + (d.count ?? 0), 0));

    const levelOnly = parseContributionCalendar(ghCalendarHtml(days.map(d => ({ ...d, count: null })), null));
    expect(levelOnly.total).toBeNull();
    expect(levelOnly.days.map(d => Number(d.level))).toEqual(days.map(d => d.level));
    expect(levelOnly.days.every(d => d.count === null)).toBe(true);

    const year = parseContributionCalendar(ghCalendarHtml(calendarDays(400)));
    expect(year.days.length).toBe(371);
    expect(year.days[370].date).toBe('2026-10-05');
    expect(year.days[0].date < year.days[1].date).toBe(true);
    expect(parseContributionCalendar('<html>nothing here</html>')).toEqual({ total: null, days: [] });
  });

  it('serves the calendar with cache headers and caches it for 6 hours', async () => {
    routes.push(url => (url === SOURCE ? new Response(ghCalendarHtml(calendarDays(371), '2,345'), { headers: { 'Content-Type': 'text/html' } }) : null));
    const res = await call();
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600, stale-while-revalidate=21600');
    const first = await read(res);
    expect(first.status).toBe(200);
    expect(field(first.data, 'user')).toBe('mrgoonie');
    expect(field(first.data, 'total')).toBe(2345);
    expect(list(field(first.data, 'days')).length).toBe(371);
    expect(list(field(first.data, 'days'))[370]).toEqual({ date: '2026-10-05', count: 0, level: 0 });
    expect(field(first.data, 'error')).toBeUndefined();
    expect(fetchLog.length).toBe(1);

    now += 5 * HOUR;
    expect(field((await read(await call())).data, 'total')).toBe(2345);
    expect(fetchLog.length).toBe(1);

    // Past 6 hours GitHub is down: the last good calendar is served with an error.
    now += 2 * HOUR;
    routes.unshift(() => new Response('boom', { status: 500 }));
    const staleRes = await call();
    expect(staleRes.headers.get('Cache-Control')).toBe('public, max-age=60');
    const stale = await read(staleRes);
    expect(stale.status).toBe(200);
    expect(field(stale.data, 'error', 'code')).toBe('github_unavailable');
    expect(list(field(stale.data, 'days')).length).toBe(371);
    expect(fetchLog.length).toBe(2);
  });

  it('reports rate limits and outages when nothing is cached, and remembers the block', async () => {
    routes.push(() => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }));
    const limited = await read(await call());
    expect(limited.status).toBe(429);
    expect(limited.code).toBe('github_rate_limited');
    expect(limited.extra.retry_after_seconds).toBe(120);
    const before = fetchLog.length;
    expect((await read(await call())).status).toBe(429);
    expect(fetchLog.length).toBe(before);

    now += 3 * 60 * 1000;
    routes.unshift(() => new Response('<html>no calendar</html>', { status: 200 }));
    const empty = await call();
    expect(empty.headers.get('Cache-Control')).toBe('no-store');
    const down = await read(empty);
    expect(down.status).toBe(503);
    expect(down.code).toBe('github_unavailable');
  });
});

describe('weather proxy', () => {
  const call = async (query: string) => read(await weatherApi(ctx({ path: `/api/v1/weather${query}` })));

  beforeEach(() => {
    routes.push(url => {
      if (url.startsWith('https://geocoding-api.open-meteo.com/')) {
        const name = new URL(url).searchParams.get('name');
        return json(name === 'Nowhere' ? { generationtime_ms: 1 } : { results: [{ name: 'Hà Nội', latitude: 21.0245, longitude: 105.84117, country: 'Vietnam', admin1: 'Hanoi' }] });
      }
      if (url.startsWith('https://api.open-meteo.com/v1/forecast')) {
        return json({ current: { time: '2026-10-05T10:00', temperature_2m: 27.4, weather_code: 63, is_day: 1, wind_speed_10m: 9.1 } });
      }
      return null;
    });
  });

  it('validates the query', async () => {
    expect((await call('')).code).toBe('invalid_query');
    expect((await call('?lat=10')).code).toBe('invalid_coordinates');
    expect((await call('?lat=95&lon=10')).code).toBe('invalid_coordinates');
    expect((await call('?lat=1e3&lon=10')).code).toBe('invalid_coordinates');
    expect((await call('?city=x')).code).toBe('invalid_city');
    expect((await call('?city=%3Cscript%3E')).code).toBe('invalid_city');
    expect(fetchLog.length).toBe(0);
  });

  it('rounds coordinates to one decimal before calling Open-Meteo and caches the result', async () => {
    const res = await call('?lat=21.02851&lon=105.80421');
    expect(res.status).toBe(200);
    expect(field(res.data, 'condition')).toBe('rain');
    expect(field(res.data, 'latitude')).toBe(21);
    expect(field(res.data, 'longitude')).toBe(105.8);
    expect(fetchLog[0].url).toContain('latitude=21&longitude=105.8&');
    expect(fetchLog[0].url).not.toContain('21.028');
    await call('?lat=21.04&lon=105.79');
    expect(fetchLog.length).toBe(1);
  });

  it('resolves a city, reports unknown cities and upstream failures', async () => {
    const city = await call('?city=Ha%20Noi&lang=vi');
    expect(field(city.data, 'place', 'name')).toBe('Hà Nội');
    expect(field(city.data, 'latitude')).toBe(21);
    expect((await call('?city=Nowhere')).code).toBe('city_not_found');
    routes.unshift(url => (url.includes('latitude=48.9') ? json({ reason: 'down' }, 503) : null));
    const down = await call('?lat=48.86&lon=2.35');
    expect(down.status).toBe(502);
    expect(down.code).toBe('weather_unavailable');
  });

  it('maps WMO codes to scenes', () => {
    expect([0, 2, 45, 61, 73, 95, 81].map(conditionFromCode)).toEqual(['clear', 'clouds', 'fog', 'rain', 'snow', 'storm', 'rain']);
  });
});

describe('Telegram community', () => {
  const tgEnv = (extra: Partial<RuntimeEnv> = {}) => baseEnv({
    TELEGRAM_BOT_TOKEN: '123:secret-token', TELEGRAM_GROUP_EN_ID: '-1001', TELEGRAM_GROUP_VI_ID: '-1002', TELEGRAM_WEBHOOK_SECRET: 'hook-secret', ...extra,
  });
  const telegramCalls = () => fetchLog.filter(f => f.url.startsWith('https://api.telegram.org/')).map(f => {
    const method = f.url.split('/').pop() ?? '';
    const body: unknown = typeof f.init?.body === 'string' ? JSON.parse(f.init.body) : null;
    return { method, body };
  });
  const invite = (env: RuntimeEnv, headers: Record<string, string>, chat = 'vi') =>
    communityInviteApi(ctx({ env, method: 'POST', path: '/api/v1/community/invite', headers, body: { chat } }));

  beforeEach(() => {
    let n = 0;
    routes.push((url, init) => {
      if (!url.startsWith('https://api.telegram.org/bot123:secret-token/')) return null;
      const method = url.split('/').pop();
      if (method === 'createChatInviteLink') {
        n += 1;
        const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        return json({ ok: true, result: { invite_link: `https://t.me/+invite${n}`, member_limit: field(body, 'member_limit') } });
      }
      return json({ ok: true, result: true });
    });
  });

  it('gates invites on the community entitlement and reports missing configuration honestly', async () => {
    expect((await read(await invite(tgEnv(), {}))).code).toBe('unauthorized');
    const reader = await memberCookie('reader@example.com');
    await grantPlan(reader.userId, 'combo', now + 10 * 24 * HOUR);
    const denied = await read(await invite(tgEnv(), browser(reader.cookie)));
    expect(denied.status).toBe(403);
    expect(denied.code).toBe('entitlement_required');

    await grantPlan(reader.userId, 'community', now + 10 * 24 * HOUR);
    const unconfigured = await read(await invite(baseEnv(), browser(reader.cookie)));
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.code).toBe('community_unconfigured');
    expect(JSON.stringify(unconfigured.extra)).toContain('TELEGRAM_BOT_TOKEN');
    const status = await read(await communityStatusApi(ctx({ env: baseEnv(), headers: browser(reader.cookie) })));
    expect(field(status.data, 'configured')).toBe(false);
    expect(field(status.data, 'entitled')).toBe(true);
    expect(field(status.data, 'signed_in')).toBe(true);
    const anonymous = await read(await communityStatusApi(ctx({ env: baseEnv() })));
    expect(field(anonymous.data, 'signed_in')).toBe(false);
    expect(field(anonymous.data, 'entitled')).toBe(false);
    expect(telegramCalls().length).toBe(0);
  });

  it('issues a single-use one-hour link, links the joiner and removes them after the plan lapses', async () => {
    const reader = await memberCookie('reader@example.com');
    await grantPlan(reader.userId, 'community', now + 2 * 24 * HOUR);
    const first = await read(await invite(tgEnv(), browser(reader.cookie)));
    expect(first.status).toBe(201);
    expect(field(first.data, 'invite_link')).toBe('https://t.me/+invite1');
    const [create] = telegramCalls();
    expect(create.method).toBe('createChatInviteLink');
    expect(field(create.body, 'member_limit')).toBe(1);
    expect(field(create.body, 'chat_id')).toBe('-1002');
    expect(field(create.body, 'expire_date')).toBe(Math.floor(now / 1000) + 3600);

    // Asking again while the link is unused returns the same link.
    expect(field((await read(await invite(tgEnv(), browser(reader.cookie)))).data, 'invite_link')).toBe('https://t.me/+invite1');
    expect(telegramCalls().length).toBe(1);

    const hook = (secret: string, update: unknown) => telegramWebhookApi(ctx({
      env: tgEnv(), method: 'POST', path: '/api/v1/community/telegram-webhook', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: update,
    }));
    const joinUpdate = { update_id: 1, chat_member: { chat: { id: -1002 }, new_chat_member: { status: 'member', user: { id: 777 } }, invite_link: { invite_link: 'https://t.me/+invite1' } } };
    expect((await read(await hook('wrong', joinUpdate))).code).toBe('invalid_webhook_secret');
    expect(field((await read(await hook('hook-secret', joinUpdate))).data, 'outcome')).toBe('joined');
    expect((await read(await invite(tgEnv(), browser(reader.cookie)))).code).toBe('already_joined');

    const admin = await memberCookie('boss@example.com');
    const sweep = async () => read(await communitySweepApi(ctx({ env: tgEnv(), method: 'POST', headers: browser(admin.cookie) })));
    expect((await read(await communitySweepApi(ctx({ env: tgEnv(), method: 'POST', headers: browser(reader.cookie) })))).status).toBe(403);
    expect(field((await sweep()).data, 'removed')).toBe(0);

    now += 3 * 24 * HOUR;
    const lapsed = await sweep();
    expect(field(lapsed.data, 'removed')).toBe(1);
    const calls = telegramCalls().slice(-2);
    expect(calls.map(c => c.method)).toEqual(['banChatMember', 'unbanChatMember']);
    expect(field(calls[1].body, 'only_if_banned')).toBe(true);
    expect(field(calls[1].body, 'user_id')).toBe(777);
    const status = await read(await communityStatusApi(ctx({ env: tgEnv(), headers: browser(reader.cookie) })));
    expect(field(list(field(status.data, 'memberships'))[0], 'status')).toBe('removed');
    expect(field((await sweep()).data, 'removed')).toBe(0);
  });

  it('revokes unused links of lapsed members and removes a lapsed joiner immediately', async () => {
    const reader = await memberCookie('reader@example.com');
    await grantPlan(reader.userId, 'community', now + HOUR / 2);
    await read(await invite(tgEnv(), browser(reader.cookie), 'en'));
    await read(await invite(tgEnv(), browser(reader.cookie), 'vi'));
    now += 40 * 60 * 1000;
    const admin = await memberCookie('boss@example.com');
    const result = await read(await communitySweepApi(ctx({ env: tgEnv(), method: 'POST', headers: browser(admin.cookie) })));
    expect(field(result.data, 'revoked')).toBe(2);
    expect(telegramCalls().filter(c => c.method === 'revokeChatInviteLink').length).toBe(2);
    // A late join through an already-revoked link is ignored.
    const late = await read(await telegramWebhookApi(ctx({
      env: tgEnv(), method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook-secret' },
      body: { chat_member: { chat: { id: -1001 }, new_chat_member: { status: 'member', user: { id: 9 } }, invite_link: { invite_link: 'https://t.me/+invite1' } } },
    })));
    expect(field(late.data, 'outcome')).toBe('ignored');
  });

  it('never leaks the bot token in errors', async () => {
    routes.unshift(url => (url.includes('createChatInviteLink') ? json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 400) : null));
    const reader = await memberCookie('reader@example.com');
    await grantPlan(reader.userId, 'community', now + 24 * HOUR);
    const res = await read(await invite(tgEnv(), browser(reader.cookie)));
    expect(res.code).toBe('telegram_error');
    expect(JSON.stringify(res)).not.toContain('secret-token');
  });
});

describe('homepage client helpers', () => {
  const notice = (id: string, startOffsetH: number, endOffsetH: number): PublicNotice => ({
    id, text: `notice ${id}`, locale: 'en', expression: null,
    starts_at: new Date(T0 + startOffsetH * HOUR).toISOString(),
    expires_at: new Date(T0 + endOffsetH * HOUR).toISOString(),
  });

  it('parses the shipped mascot manifest and maps expressions to animations', async () => {
    const raw: unknown = JSON.parse(await Bun.file(new URL('../public/mascot/manifest.json', import.meta.url)).text());
    const m = parseMascotManifest(raw);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.imageWebp).toBe('/mascot/zuey-mascot.webp');
    expect(m.cell).toBe(256);
    expect(m.walkFacing).toBe('right');
    for (const state of ['idle', 'walking', 'wave', 'talking', 'thinking', 'happy', 'surprised']) {
      expect(m.animations[m.expressions[state]]).toBeDefined();
    }
    expect(framePosition({ name: 'x', x: 768, y: 512, w: 256, h: 256, durationMs: 100 }, m)).toBe(`100% ${(512 / 768) * 100}%`);
    expect(parseMascotManifest({ image: {} })).toBeNull();
    expect(parseMascotManifest(null)).toBeNull();
  });

  it('shows only live, undismissed notices and never replays dismissed ones', () => {
    const notices = [notice('past', -3, -1), notice('future', 2, 4), notice('live-a', -1, 2), notice('live-b', -1, 5)];
    expect(pickNotice(notices, [], T0)?.id).toBe('live-a');
    const dismissed = addDismissed([], notices[2], T0);
    expect(pickNotice(notices, dismissed, T0)?.id).toBe('live-b');
    expect(addDismissed(dismissed, notices[2], T0)).toHaveLength(1);
    // Dismissal entries are pruned once the notice itself has expired.
    expect(parseDismissed(dismissed, T0 + 3 * HOUR)).toHaveLength(0);
    expect(parseDismissed([{ id: 1 }, 'x', { id: 'ok', expires_at: 'nope' }], T0)).toHaveLength(0);
    expect(nextNoticeChange(notices, T0)).toBe(2 * HOUR + 50);
    expect(nextNoticeChange([notices[0]], T0)).toBeNull();
    expect(pickNotice(notices, [], T0 + 4.5 * HOUR)?.id).toBe('live-b');
  });

  it('validates untrusted API payloads on the client', () => {
    expect(parseWeather({ condition: 'tornado', latitude: 1, longitude: 2, weather_code: 0 })).toBeNull();
    const w = parseWeather({ condition: 'rain', latitude: 10.8, longitude: 106.7, weather_code: 61, is_day: false, temperature_c: 27.4, place: { name: 'Hồ Chí Minh' } });
    expect(w?.is_day).toBe(false);
    expect(w?.place?.name).toBe('Hồ Chí Minh');

    const activity = parseActivity({
      source: 'stale',
      error: { code: 'github_rate_limited', message: 'x', retry_after_seconds: 120 },
      snapshot: {
        user: 'mrgoonie', fetched_at: new Date(T0).toISOString(), pages_fetched: 1, partial: false,
        events: [
          { id: '1', type: 'PushEvent', repo: 'mrgoonie/zuey', url: 'https://github.com/mrgoonie/zuey', created_at: new Date(T0).toISOString() },
          { id: '2', type: 'PushEvent', repo: 'evil/x', url: 'javascript:alert(1)', created_at: new Date(T0).toISOString() },
        ],
      },
    });
    expect(activity?.snapshot.events.map(e => e.id)).toEqual(['1']);
    expect(activity?.error?.retry_after_seconds).toBe(120);

    const cal = parseCalendar({
      user: 'mrgoonie', total: 42, fetched_at: new Date(T0).toISOString(),
      error: { code: 'github_rate_limited', message: 'x', retry_after_seconds: 60 },
      days: [
        { date: '2026-10-02', count: 3, level: 2 },
        { date: '2026-10-01', count: null, level: 0 },
        { date: '2026-10-03', count: 1, level: 7 },
        { date: '<b>', count: 1, level: 1 },
        'junk',
      ],
    });
    expect(cal?.days).toEqual([{ date: '2026-10-01', count: null, level: 0 }, { date: '2026-10-02', count: 3, level: 2 }]);
    expect(cal?.total).toBe(42);
    expect(cal?.error?.code).toBe('github_rate_limited');
    expect(parseCalendar({ user: 'x', days: [] })).toBeNull();
    expect(parseCalendar({ user: 'x', total: null, fetched_at: 'now', days: [] })?.error).toBeUndefined();

    expect(parseNotices({ notices: [notice('a', -1, 1), { id: 'bad' }] })?.map(n => n.id)).toEqual(['a']);

    const community = parseCommunity({
      signed_in: true, configured: true, entitled: true,
      chats: [{ chat: 'en', available: true }, { chat: 'fr', available: true }],
      memberships: [{ id: 'm', chat: 'vi', status: 'invited', invite_link: 'https://evil.example/x', invite_expires_at: new Date(T0).toISOString() }],
    });
    expect(community?.chats).toEqual([{ chat: 'en', available: true }]);
    expect(community?.memberships[0].invite_link).toBeNull();

    expect(parseArticleHits([{ slug: 'hello-world', title: 'Hello', tags: ['ai', 3] }, { slug: '../x', title: 'Bad' }])).toEqual([
      { slug: 'hello-world', title: 'Hello', excerpt: '', tags: ['ai'], locale: null },
    ]);
    expect(parseArticleHits({ items: [{ slug: 'a', title: 'A' }] })).toHaveLength(1);
    expect(parseArticleHits('nope')).toBeNull();
  });
});
