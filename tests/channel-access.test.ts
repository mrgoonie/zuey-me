import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createApiKey } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { subjectRef } from '../src/lib/channel-access/check';
import { LIFECYCLE_RETRY_DELAYS_MS, deweeIdentityRuntime, missingDeweeIdentityEnv, reportMemberLifecycle } from '../src/lib/channel-access/dewee-identity';
import { isSensitivePath } from '../src/lib/analytics/pii';
import { applyBillingPayment } from '../src/lib/members/billing';
import { channelAccessOpenApi } from '../src/lib/channel-access/openapi';
import { channelAccessMcpModule } from '../src/lib/channel-access/mcp';
import { MCP_FEATURE_MODULES } from '../src/lib/mcp/registry';
import { OPENAPI_FRAGMENTS } from '../src/lib/openapi/registry';
import { TOOL_ACCESS } from '../src/lib/oauth/tool-access';
import { createUserKey } from '../src/lib/members/api-keys';
import { PLANS } from '../src/lib/members/plans';
import { membersRuntime } from '../src/lib/members/runtime';
import { createMemberSession } from '../src/lib/members/session';
import { recomputeSubscription } from '../src/lib/members/subscriptions';
import { deleteAccount, exportAccount, findOrCreateVerifiedUser, getUserById } from '../src/lib/members/users';
import { experienceRuntime } from '../src/lib/experience/runtime';
import { POST as mcpApi } from '../src/pages/api/mcp';
import { POST as checkApi } from '../src/pages/api/v1/channel-access/check';
import { GET as myChannelsApi } from '../src/pages/api/v1/me/channels/index';
import { DELETE as unlinkApi } from '../src/pages/api/v1/me/channels/[bindingId]';
import { GET as deweeConnectPage } from '../src/pages/dewee/connect';
import { POST as communitySweepApi } from '../src/pages/api/v1/community/sweep';

const ROOT = path.join(import.meta.dir, '..');
const ORIGIN = 'https://zuey.test';
const GATEWAY = 'https://dewee.test';
const CONNECT_BASE = 'https://connect.dewee.test';
const APP_ID = '0199a572-a064-7118-8f4a-0b28d615d0e1';
const T0 = Date.parse('2026-10-11T03:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SERVICE_KEY = 'svc_'.padEnd(48, 'k');
const ASSERTION_SECRET = 'assertion-secret-'.padEnd(48, 's');
const CRON_SECRET = 'cron-secret-value';
const BINDING_ID = '0199a572-a064-7118-8f4a-0b28d615d0e2';

type TestDb = ReturnType<typeof createTestD1>;
let d1: TestDb;
let now: number;
let fetchLog: { url: string; init?: RequestInit }[];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
const originalFetch = membersRuntime.fetch;
const originalNow = membersRuntime.now;
const originalExperienceFetch = experienceRuntime.fetch;
const originalSleep = deweeIdentityRuntime.sleep;
let sleeps: number[];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field(v: unknown, ...keys: string[]): unknown {
  let cur: unknown = v;
  for (const k of keys) cur = isRecord(cur) ? cur[k] : undefined;
  return cur;
}

const baseEnv = (extra: Partial<RuntimeEnv> = {}): RuntimeEnv => ({
  DB: d1, PUBLIC_SITE_URL: ORIGIN, ADMIN_EMAILS: 'boss@example.com', CHANNEL_ACCESS_SERVICE_KEY: SERVICE_KEY, ...extra,
});

/** Dewee Connect configured (hosted linking). */
const identityEnv = (extra: Partial<RuntimeEnv> = {}): RuntimeEnv => baseEnv({
  DEWEE_GATEWAY_URL: GATEWAY, DEWEE_APPLICATION_ID: APP_ID, DEWEE_IDENTITY_ISSUER: ORIGIN, DEWEE_ASSERTION_SECRET: ASSERTION_SECRET,
  DEWEE_CONNECT_BASE_URL: CONNECT_BASE, ...extra,
});

interface CtxOpts { env?: RuntimeEnv; method?: string; path?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; params?: Record<string, string> }

function ctx(opts: CtxOpts): APIContext {
  const headers = new Headers(opts.headers ?? {});
  if (opts.body !== undefined || opts.rawBody !== undefined) headers.set('Content-Type', 'application/json');
  const request = new Request(`${ORIGIN}${opts.path ?? '/api/test'}`, {
    method: opts.method ?? 'GET', headers, body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  // Handlers only read request/params/locals/url; a full APIContext is not constructible in tests.
  const partial = { request, params: opts.params ?? {}, url: new URL(request.url), locals: { runtime: { env: opts.env ?? baseEnv() } } };
  return partial as unknown as APIContext;
}

interface Envelope { status: number; data: unknown; code: string | null }

async function read(res: Response): Promise<Envelope> {
  const body: unknown = await res.json();
  if (!isRecord(body)) throw new Error('non-object body');
  const error = isRecord(body.error) ? body.error : null;
  return { status: res.status, data: body.data, code: error ? String(error.code) : null };
}

async function member(email: string): Promise<{ cookie: string; userId: string }> {
  const { user } = await findOrCreateVerifiedUser(d1, { email });
  const { token } = await createMemberSession(d1, user.id);
  return { cookie: `zuey_member=${token}`, userId: user.id };
}

const browser = (cookie: string): Record<string, string> => ({ cookie, Origin: ORIGIN });
const bearer = (key: string): Record<string, string> => ({ Authorization: `Bearer ${key}` });

async function grantPlan(userId: string, plan: string, endMs: number): Promise<void> {
  const ts = new Date(now).toISOString();
  await d1.prepare(
    "INSERT INTO subscriptions (id, user_id, plan, status, current_period_end, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?) ON CONFLICT (user_id, plan) DO UPDATE SET current_period_end = excluded.current_period_end"
  ).bind(`sub_${userId}_${plan}`, userId, plan, new Date(endMs).toISOString(), ts, ts).run();
}

/** A hosted-mode (contract version 2) request for a sender Dewee linked to `subject`. */
const v2Body = (subject: string | null, extra: Record<string, unknown> = {}) => ({
  version: 2, channel_type: 'telegram', channel_instance: 'zuey-ai', sender_id: '777001', sender_username: 'alice', chat_type: 'direct',
  principal_id: '0199a572-a064-7118-8f4a-0b28d615d0aa', authn_level: 'verified', ...(subject === null ? {} : { external_subject: subject }), ...extra,
});

async function check(headers: Record<string, string>, body: unknown = v2Body(null), env = baseEnv()): Promise<Envelope> {
  return read(await checkApi(ctx({ env, method: 'POST', path: '/api/v1/channel-access/check', headers, body })));
}

const decisionFor = async (body: unknown): Promise<unknown> => field((await check(bearer(SERVICE_KEY), body)).data, 'decision');

async function mcpCall(headers: Record<string, string>, name: string, args: Record<string, unknown>, env = baseEnv()): Promise<{ status: number; result: unknown; error: unknown }> {
  const res = await mcpApi(ctx({ env, method: 'POST', path: '/api/mcp', headers, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } }));
  const body: unknown = await res.json();
  const text = field(body, 'result', 'content');
  const first = Array.isArray(text) ? text[0] : undefined;
  const parsed: unknown = typeof field(first, 'text') === 'string' ? JSON.parse(String(field(first, 'text'))) : null;
  return { status: res.status, result: parsed, error: field(body, 'error') };
}

/** Header and claims of a compact JWS (signature not checked: the SDK owns signing). */
function decodeJws(jws: string): { header: unknown; claims: unknown } {
  const [h, p] = jws.split('.');
  const part = (s: string): unknown => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  return { header: part(h), claims: part(p) };
}

function assertionOf(call: { init?: RequestInit }): { header: unknown; claims: unknown } {
  const auth = new Headers(call.init?.headers).get('authorization') ?? '';
  expect(auth.startsWith('Dewee-Assertion ')).toBe(true);
  return decodeJws(auth.slice('Dewee-Assertion '.length));
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const lifecycleCalls = () => fetchLog.filter(f => f.url === `${GATEWAY}/v1/identity/principals/lifecycle`);

/** Answers like a Dewee gateway with hosted linking on. `lifecycleStatuses` answers successive lifecycle calls (0 = network failure). */
function fakeDewee(opts: { lifecycleStatus?: number; lifecycleStatuses?: number[]; bindings?: unknown[]; unlinkStatus?: number; exchangeStatus?: number; listStatus?: number } = {}): void {
  const queue = [...(opts.lifecycleStatuses ?? [])];
  fetchImpl = async (url, init) => {
    if (url === `${GATEWAY}/v1/identity/principals/lifecycle`) {
      const status = queue.shift() ?? opts.lifecycleStatus ?? 200;
      if (status === 0) throw new Error('network down');
      if (status !== 200) return json({ error: { code: status === 404 ? 'NOT_FOUND' : 'INTERNAL', message: 'x' } }, status);
      return json({ principal_id: 'p1', event: 'scopes_changed', status: 'active', grant_version: 2, sessions_revoked: 0, bindings_revoked: 0 });
    }
    if (url === `${GATEWAY}/v1/identity/sessions/exchange`) {
      if (opts.exchangeStatus) return json({ error: { code: opts.exchangeStatus === 404 ? 'NOT_FOUND' : 'INTERNAL', message: 'x' } }, opts.exchangeStatus);
      return json({
        session_token: 'dis_session_token', token_type: 'Bearer', header: 'X-Dewee-Identity-Session', session_id: '0199a572-a064-7118-8f4a-0b28d615d0f0',
        principal_id: '0199a572-a064-7118-8f4a-0b28d615d0f1', application_id: APP_ID, agent_id: 'agent-1',
        expires_at: new Date(now + 60_000).toISOString(), test_mode: false,
      }, 201);
    }
    if (url === `${GATEWAY}/v1/identity/me/bindings` && (init?.method ?? 'GET') === 'GET') {
      return opts.listStatus ? json({ error: { code: 'NOT_FOUND', message: 'x' } }, opts.listStatus) : json({ bindings: opts.bindings ?? [] });
    }
    if (url.startsWith(`${GATEWAY}/v1/identity/me/bindings/`) && init?.method === 'DELETE') {
      const status = opts.unlinkStatus ?? 200;
      return status === 200 ? json({ binding_id: BINDING_ID, status: 'revoked', grant_version: 3 }) : json({ error: { code: 'NOT_FOUND', message: 'x' } }, status);
    }
    return json({ error: { code: 'NOT_FOUND', message: 'unexpected' } }, 404);
  };
}

beforeEach(() => {
  d1 = createTestD1();
  now = T0;
  membersRuntime.now = () => now;
  fetchLog = [];
  sleeps = [];
  deweeIdentityRuntime.sleep = async ms => { sleeps.push(ms); };
  fetchImpl = async () => new Response('{}', { status: 200 });
  membersRuntime.fetch = async (url, init) => {
    fetchLog.push({ url, init });
    return fetchImpl(url, init);
  };
});

afterEach(() => {
  membersRuntime.fetch = originalFetch;
  membersRuntime.now = originalNow;
  experienceRuntime.fetch = originalExperienceFetch;
  deweeIdentityRuntime.sleep = originalSleep;
});

describe('agent_chat entitlement', () => {
  it('is granted by every plan that includes Zuey AI and not by Knowledges', () => {
    const granting = PLANS.filter(p => p.entitlements.includes('agent_chat')).map(p => p.id);
    expect(granting).toEqual(['ai', 'combo', 'community']);
  });

  it('registers only the verifier tool, its catalogue visibility and the OpenAPI fragment', () => {
    expect(MCP_FEATURE_MODULES).toContain(channelAccessMcpModule);
    expect(OPENAPI_FRAGMENTS).toContain(channelAccessOpenApi);
    expect(TOOL_ACCESS.channel_access_check).toEqual({ kind: 'admin' });
    expect(channelAccessMcpModule.tools.map(t => t.name)).toEqual(['channel_access_check']);
    expect(Object.keys(channelAccessOpenApi.paths).sort()).toEqual(['/api/v1/channel-access/check', '/api/v1/me/channels', '/api/v1/me/channels/{binding_id}']);
  });
});

describe('channel access verifier authentication', () => {
  it('accepts only the dedicated service key', async () => {
    const reader = await member('reader@example.com');
    const { secret: userKey } = await createUserKey(d1, reader.userId, { name: 'k', scopes: ['account:read', 'chat:write'], expires_in_days: 30 });
    const { key: adminKey } = await createApiKey('ops', 'admin', d1);

    expect((await check({})).code).toBe('unauthorized');
    expect((await check(bearer('wrong'))).code).toBe('invalid_service_key');
    expect((await check(bearer(adminKey))).code).toBe('invalid_service_key');
    expect((await check(bearer(userKey))).code).toBe('invalid_service_key');
    expect((await check(browser(reader.cookie))).code).toBe('unauthorized');
    expect((await check({ 'X-API-Key': SERVICE_KEY })).status).toBe(200);
    const ok = await check(bearer(SERVICE_KEY));
    expect(ok.status).toBe(200);
    expect(field(ok.data, 'decision')).toBe('deny');
  });

  it('answers 503 when the key is missing or too weak to be safe', async () => {
    expect((await check(bearer(SERVICE_KEY), v2Body(null), baseEnv({ CHANNEL_ACCESS_SERVICE_KEY: undefined }))).code).toBe('channel_access_unconfigured');
    expect((await check(bearer('short'), v2Body(null), baseEnv({ CHANNEL_ACCESS_SERVICE_KEY: 'short' }))).code).toBe('channel_access_unconfigured');
  });

  it('rejects missing, wrong, admin and member keys on the MCP tool too', async () => {
    const reader = await member('reader@example.com');
    const { secret: userKey } = await createUserKey(d1, reader.userId, { name: 'k', scopes: ['account:read'], expires_in_days: 30 });
    const { key: adminKey } = await createApiKey('ops', 'admin', d1);
    for (const headers of [{}, bearer('nope'), bearer(adminKey), bearer(userKey)]) {
      const res = await mcpCall(headers, 'channel_access_check', v2Body(reader.userId));
      expect(res.status).toBe(401);
      expect(field(res.error, 'code')).toBe(-32001);
    }
    const ok = await mcpCall(bearer(SERVICE_KEY), 'channel_access_check', v2Body(reader.userId));
    expect(ok.status).toBe(200);
    expect(field(ok.result, 'decision')).toBe('deny');
  });

  it('grants nothing else: the service key is not an admin credential', async () => {
    const res = await mcpCall(bearer(SERVICE_KEY), 'members_list', {});
    expect([401, 403]).toContain(res.status);
    const gone = await mcpCall(bearer(SERVICE_KEY), 'channel_identity_unlink', { provider: 'telegram', external_id: '1' });
    expect(gone.result).toBeNull();
  });

  it('acknowledges MCP notifications on /api/mcp without a body', async () => {
    const res = await mcpApi(ctx({ method: 'POST', path: '/api/mcp', body: { jsonrpc: '2.0', method: 'notifications/initialized' } }));
    expect(res.status).toBe(202);
  });

  it('validates the contract input', async () => {
    const bad = async (extra: Record<string, unknown>) => (await check(bearer(SERVICE_KEY), v2Body('u', extra))).code;
    expect(await bad({ version: 3 })).toBe('unsupported_version');
    expect(await bad({ channel_type: 'SMS!' })).toBe('unsupported_channel');
    expect(await bad({ sender_id: '' })).toBe('invalid_field');
    expect(await bad({ sender_id: 'a b' })).toBe('invalid_field');
    expect(await bad({ chat_type: 'channel' })).toBe('invalid_field');
    expect(await bad({ authn_level: 'root' })).toBe('invalid_field');
    expect(await bad({ external_subject: 'x'.repeat(256) })).toBe('invalid_field');
    const raw = await read(await checkApi(ctx({ method: 'POST', headers: bearer(SERVICE_KEY), rawBody: 'not json' })));
    expect(raw.code).toBe('invalid_json');
    // Numeric sender ids are accepted as their decimal string; any dewee channel type is accepted.
    expect((await check(bearer(SERVICE_KEY), v2Body(null, { sender_id: 777001, channel_type: 'zalo_personal' }))).status).toBe(200);
  });
});

describe('channel access decisions (hosted mode, keyed by external_subject)', () => {
  it('isolates members: A entitled is allowed, B without a plan is denied, each by their own subject', async () => {
    const a = await member('alice@example.com');
    const b = await member('bob@example.com');
    await grantPlan(a.userId, 'ai', now + 2 * DAY);
    await grantPlan(b.userId, 'knowledges', now + 2 * DAY);

    // Same chat sender id for both: only external_subject decides.
    const allowA = await check(bearer(SERVICE_KEY), v2Body(a.userId));
    expect(field(allowA.data, 'decision')).toBe('allow');
    expect(field(allowA.data, 'ttl_seconds')).toBe(300);
    const refA = String(field(allowA.data, 'subject_ref'));
    expect(refA).toBe(await subjectRef(a.userId));
    expect(refA).not.toContain(a.userId);

    const denyB = await check(bearer(SERVICE_KEY), v2Body(b.userId));
    expect(field(denyB.data, 'decision')).toBe('deny');
    expect(field(denyB.data, 'link_url')).toBe(`${ORIGIN}/pricing`);
    expect(field(denyB.data, 'ttl_seconds')).toBe(30);
    expect(field(denyB.data, 'subject_ref')).toBe(await subjectRef(b.userId));
    expect(field(denyB.data, 'subject_ref')).not.toBe(refA);
  });

  it('denies a request without external_subject and never maps the sender id to a member', async () => {
    const a = await member('alice@example.com');
    await grantPlan(a.userId, 'ai', now + DAY);
    // Even a sender id equal to an entitled member's id is not a subject.
    for (const body of [v2Body(null), v2Body(null, { sender_id: a.userId }), v2Body('', { sender_id: a.userId }), v2Body(null, { chat_type: 'group', authn_level: 'channel' })]) {
      const res = await check(bearer(SERVICE_KEY), body);
      expect(field(res.data, 'decision')).toBe('deny');
      expect(field(res.data, 'subject_ref')).toBeUndefined();
      expect(field(res.data, 'link_url')).toBeUndefined();
    }
    // Version 1 (partner linking) is never allowed, even if it carries a subject.
    expect(await decisionFor({ ...v2Body(a.userId), version: 1 })).toBe('deny');
    // The MCP tool decides the same way.
    expect(field((await mcpCall(bearer(SERVICE_KEY), 'channel_access_check', v2Body(null, { sender_id: a.userId }))).result, 'decision')).toBe('deny');
    expect(field((await mcpCall(bearer(SERVICE_KEY), 'channel_access_check', v2Body(a.userId))).result, 'decision')).toBe('allow');
  });

  it('denies unknown and deleted members', async () => {
    expect(await decisionFor(v2Body('usr_does_not_exist'))).toBe('deny');
    const gone = await member('gone@example.com');
    await grantPlan(gone.userId, 'ai', now + DAY);
    expect(await decisionFor(v2Body(gone.userId))).toBe('allow');
    const user = await getUserById(d1, gone.userId);
    if (!user) throw new Error('missing user');
    await deleteAccount(d1, user, baseEnv());
    expect(await decisionFor(v2Body(gone.userId))).toBe('deny');
  });

  it('allows combo, community and admins, also when checked from a group', async () => {
    const reader = await member('reader@example.com');
    await grantPlan(reader.userId, 'knowledges', now + DAY);
    expect(await decisionFor(v2Body(reader.userId))).toBe('deny');
    await grantPlan(reader.userId, 'combo', now + DAY);
    expect(await decisionFor(v2Body(reader.userId))).toBe('allow');

    const fan = await member('fan@example.com');
    await grantPlan(fan.userId, 'community', now + DAY);
    expect(await decisionFor(v2Body(fan.userId, { chat_type: 'group', authn_level: 'channel' }))).toBe('allow');

    const boss = await member('boss@example.com');
    expect(await decisionFor(v2Body(boss.userId))).toBe('allow');
  });

  it('denies once the plan expires, and keeps an auto-renewing card plan open through the grace period', async () => {
    const alice = await member('alice@example.com');
    await grantPlan(alice.userId, 'ai', now + 2 * DAY);
    expect(await decisionFor(v2Body(alice.userId))).toBe('allow');
    now += 3 * DAY;
    expect(await decisionFor(v2Body(alice.userId))).toBe('deny');

    const carol = await member('carol@example.com');
    const periodEnd = new Date(now + HOUR).toISOString();
    const ts = new Date(now).toISOString();
    await d1.prepare(
      "INSERT INTO card_subscriptions (id, provider, provider_subscription_id, user_id, plan, status, current_period_end, cancel_at_period_end, created_at, updated_at) VALUES ('cs_1', 'dodo', 'sub_1', ?, 'ai', 'active', ?, 0, ?, ?)"
    ).bind(carol.userId, periodEnd, ts, ts).run();
    await recomputeSubscription(d1, carol.userId, 'ai', { provider: 'dodo' });
    now += 5 * HOUR; // past the provider billing date, inside the 24-hour grace
    expect(await decisionFor(v2Body(carol.userId))).toBe('allow');
    now += DAY; // grace over and no renewal webhook
    expect(await decisionFor(v2Body(carol.userId))).toBe('deny');
  });
});

describe('Dewee lifecycle on access changes', () => {
  async function paidOrder(userId: string, plan: string, paidAt: number): Promise<void> {
    const ts = new Date(paidAt).toISOString();
    await d1.prepare(
      "INSERT INTO billing_orders (id, code, user_id, plan, months, amount_usd_cents, usd_vnd_rate, amount_vnd, status, expires_at, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 900, 26000, 234000, 'paid', ?, ?, ?, ?)"
    ).bind(`ord_${userId}_${plan}_${paidAt}`, `ZM-${userId}-${plan}-${paidAt}`, userId, plan, ts, ts, ts, ts).run();
  }

  it('reports scopes_changed with the member as subject when a plan turns active or is revoked (downgrade)', async () => {
    fakeDewee();
    const alice = await member('alice@example.com');
    const bob = await member('bob@example.com');
    await paidOrder(alice.userId, 'ai', now);
    await recomputeSubscription(d1, alice.userId, 'ai', { provider: 'sepay', env: identityEnv() });
    expect(lifecycleCalls().length).toBe(1);
    const up = assertionOf(lifecycleCalls()[0]);
    expect(field(up.header, 'typ')).toBe('dewee-lifecycle+jwt');
    expect(field(up.claims, 'sub')).toBe(alice.userId);
    expect(field(up.claims, 'iss')).toBe(ORIGIN);
    expect(field(up.claims, 'aud')).toBe(`dewee:${APP_ID}`);
    expect(field(up.claims, 'event')).toBe('scopes_changed');
    expect(field(up.claims, 'scopes')).toEqual(['ai_chat', 'agent_chat']);
    expect(lifecycleCalls()[0].init?.body).toBeUndefined();

    // No status change (re-run): no call.
    fetchLog = [];
    await recomputeSubscription(d1, alice.userId, 'ai', { provider: 'sepay', env: identityEnv() });
    expect(lifecycleCalls().length).toBe(0);

    // Downgrade: the payment is reversed, access ends now, and Dewee hears the reduced scope list for Alice only.
    await d1.prepare("UPDATE billing_orders SET status = 'needs_attention' WHERE user_id = ?").bind(alice.userId).run();
    await recomputeSubscription(d1, alice.userId, 'ai', { provider: 'sepay', env: identityEnv() });
    expect(lifecycleCalls().length).toBe(1);
    const down = assertionOf(lifecycleCalls()[0]);
    expect(field(down.claims, 'sub')).toBe(alice.userId);
    expect(field(down.claims, 'sub')).not.toBe(bob.userId);
    expect(field(down.claims, 'event')).toBe('scopes_changed');
    expect(field(down.claims, 'scopes')).toEqual([]);
  });

  it('is skipped without identity config and never breaks billing when Dewee fails or never saw the member', async () => {
    const alice = await member('alice@example.com');
    await paidOrder(alice.userId, 'ai', now);
    await recomputeSubscription(d1, alice.userId, 'ai', { provider: 'sepay', env: baseEnv({ DEWEE_GATEWAY_URL: GATEWAY }) });
    expect(fetchLog.length).toBe(0);

    // Never linked: Dewee has no principal (404), which is a no-op.
    fakeDewee({ lifecycleStatus: 404 });
    expect(await reportMemberLifecycle(identityEnv(), alice.userId, 'scopes_changed', [])).toEqual({ status: 'not_linked' });
    const bob = await member('bob@example.com');
    await paidOrder(bob.userId, 'combo', now);
    expect((await recomputeSubscription(d1, bob.userId, 'combo', { provider: 'sepay', env: identityEnv() }))?.status).toBe('active');

    fakeDewee({ lifecycleStatus: 500 });
    const carol = await member('carol@example.com');
    await paidOrder(carol.userId, 'community', now);
    expect((await recomputeSubscription(d1, carol.userId, 'community', { provider: 'sepay', env: identityEnv() }))?.status).toBe('active');
    expect((await reportMemberLifecycle(identityEnv(), carol.userId, 'scopes_changed', [])).status).toBe('failed');

    fetchImpl = async () => { throw new Error('network down'); };
    const dave = await member('dave@example.com');
    await paidOrder(dave.userId, 'ai', now);
    expect((await recomputeSubscription(d1, dave.userId, 'ai', { provider: 'sepay', env: identityEnv() }))?.status).toBe('active');
  });

  it('retries a transient lifecycle failure with backoff, at most three attempts, and never a client error', async () => {
    const alice = await member('alice@example.com');
    // 503, then a network failure, then success.
    fakeDewee({ lifecycleStatuses: [503, 0, 200] });
    expect((await reportMemberLifecycle(identityEnv(), alice.userId, 'scopes_changed', ['agent_chat'])).status).toBe('applied');
    expect(lifecycleCalls().length).toBe(3);
    expect(sleeps).toEqual([...LIFECYCLE_RETRY_DELAYS_MS]);

    // 429 three times: gives up after three attempts.
    fetchLog = []; sleeps = [];
    fakeDewee({ lifecycleStatuses: [429, 500, 502] });
    expect(await reportMemberLifecycle(identityEnv(), alice.userId, 'delete')).toEqual({ status: 'failed', error: 'INTERNAL (502)' });
    expect(lifecycleCalls().length).toBe(3);

    // A 400 is not transient: one attempt only.
    fetchLog = []; sleeps = [];
    fakeDewee({ lifecycleStatuses: [400] });
    expect((await reportMemberLifecycle(identityEnv(), alice.userId, 'delete')).status).toBe('failed');
    expect([lifecycleCalls().length, sleeps.length]).toEqual([1, 0]);
  });

  it('never retries SDK-local errors that also carry status 0', async () => {
    // INVALID_ARGUMENT: the SDK refuses the subject before any request.
    fakeDewee();
    expect(await reportMemberLifecycle(identityEnv(), 'not@a-subject', 'delete')).toEqual({ status: 'failed', error: 'INVALID_ARGUMENT (0)' });
    expect([lifecycleCalls().length, sleeps.length]).toEqual([0, 0]);

    // INVALID_RESPONSE: Dewee answered 200 without a JSON object; asking again would get the same answer.
    const alice = await member('alice@example.com');
    fetchImpl = async () => new Response('not json', { status: 200 });
    const outcome = await reportMemberLifecycle(identityEnv(), alice.userId, 'delete');
    expect(outcome).toEqual({ status: 'failed', error: 'INVALID_RESPONSE (200)' });
    expect([lifecycleCalls().length, sleeps.length]).toEqual([1, 0]);
  });

  it('logs a NOT_FOUND lifecycle answer with the event name instead of dropping it silently', async () => {
    const alice = await member('alice@example.com');
    fakeDewee({ lifecycleStatus: 404 });
    const logged: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      expect(await reportMemberLifecycle(identityEnv(), alice.userId, 'delete')).toEqual({ status: 'not_linked' });
    } finally {
      console.info = originalInfo;
    }
    expect(lifecycleCalls().length).toBe(1);
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain('lifecycle delete');
    expect(logged[0]).toContain('NOT_FOUND');
    expect(logged[0]).not.toContain(alice.userId);
  });

  it('lets the SePay webhook answer without waiting for Dewee, through waitUntil', async () => {
    const alice = await member('alice@example.com');
    const ts = new Date(now).toISOString();
    await d1.prepare(
      "INSERT INTO billing_orders (id, code, user_id, plan, months, amount_usd_cents, usd_vnd_rate, amount_vnd, status, expires_at, created_at, updated_at) VALUES ('ord_x', 'ZMWAIT1', ?, 'ai', 1, 900, 26000, 234000, 'pending', ?, ?, ?)"
    ).bind(alice.userId, new Date(now + DAY).toISOString(), ts, ts).run();
    let release: () => void = () => undefined;
    const hanging = new Promise<void>(r => { release = r; });
    fetchImpl = async url => {
      if (url.endsWith('/v1/identity/principals/lifecycle')) await hanging;
      return json({ principal_id: 'p', event: 'scopes_changed', status: 'active', grant_version: 1 });
    };
    const deferred: Promise<unknown>[] = [];
    const result = await applyBillingPayment(d1, identityEnv(), {
      eventId: 'evt-wait-1', amount: 234000, orderCode: 'ZMWAIT1', paymentRef: 'FT1', rawType: 'transfer_in',
    }, p => { deferred.push(p); });
    expect(result.outcome).toBe('paid');
    expect(deferred.length).toBe(1);
    release();
    await Promise.all(deferred);
    expect(lifecycleCalls().length).toBe(1);
  });

  it('threads the runtime waitUntil from both payment webhooks and account deletion', () => {
    for (const file of [path.join('webhooks', 'sepay.ts'), path.join('webhooks', 'dodo.ts'), path.join('v1', 'me', 'index.ts')]) {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'api', file), 'utf8');
      expect(src).toContain('runtimeWaitUntil(locals.runtime)');
    }
  });

  it('deletes the account without waiting for Dewee, reporting delete through waitUntil', async () => {
    const alice = await member('alice@example.com');
    const user = await getUserById(d1, alice.userId);
    if (!user) throw new Error('missing user');
    let release: () => void = () => undefined;
    const hanging = new Promise<void>(r => { release = r; });
    fetchImpl = async url => {
      if (url.endsWith('/v1/identity/principals/lifecycle')) await hanging;
      return json({ principal_id: 'p', event: 'delete', status: 'deleted', grant_version: 1 });
    };
    const deferred: Promise<unknown>[] = [];
    await deleteAccount(d1, user, identityEnv(), p => { deferred.push(p); });
    // The account is gone while the Dewee call is still pending.
    expect(await getUserById(d1, alice.userId)).toBeNull();
    expect(deferred.length).toBe(1);
    release();
    await Promise.all(deferred);
    expect(lifecycleCalls().length).toBe(1);
    expect(field(assertionOf(lifecycleCalls()[0]).claims, 'event')).toBe('delete');
  });

  it('reports delete with the member as subject when the account is deleted, and exports no chat ids', async () => {
    fakeDewee();
    const alice = await member('alice@example.com');
    const user = await getUserById(d1, alice.userId);
    if (!user) throw new Error('missing user');
    expect(Object.keys(await exportAccount(d1, user))).not.toContain('channel_identities');
    await deleteAccount(d1, user, identityEnv());
    expect(lifecycleCalls().length).toBe(1);
    const del = assertionOf(lifecycleCalls()[0]);
    expect([field(del.claims, 'sub'), field(del.claims, 'event')]).toEqual([alice.userId, 'delete']);

    // Deletion still succeeds when Dewee is down.
    fakeDewee({ lifecycleStatus: 500 });
    const bob = await member('bob@example.com');
    const bobUser = await getUserById(d1, bob.userId);
    if (!bobUser) throw new Error('missing user');
    await deleteAccount(d1, bobUser, identityEnv());
    expect(await getUserById(d1, bob.userId)).toBeNull();
  });
});

describe('my linked chat accounts (Dewee me/bindings)', () => {
  const list = (headers: Record<string, string>, env = identityEnv()) => myChannelsApi(ctx({ env, path: '/api/v1/me/channels', headers }));
  const unlink = (headers: Record<string, string>, bindingId: string, env = identityEnv()) =>
    unlinkApi(ctx({ env, method: 'DELETE', path: `/api/v1/me/channels/${bindingId}`, headers, params: { bindingId } }));

  it('lists the member own bindings through a short server-side session, showing only the sender hint', async () => {
    fakeDewee({
      bindings: [
        { id: BINDING_ID, channel_type: 'telegram', sender_hint: '…7001', status: 'linked', linked_at: '2026-10-10T00:00:00Z', sender_id: '777001' },
        { id: '0199a572-a064-7118-8f4a-0b28d615d0e3', channel_type: 'zalo', sender_hint: '…42', status: 'revoked' },
      ],
    });
    const alice = await member('alice@example.com');
    const res = await read(await list(browser(alice.cookie)));
    expect(res.status).toBe(200);
    // The hint is passed through exactly as Dewee masked it.
    expect(res.data).toEqual([{ id: BINDING_ID, channel_type: 'telegram', sender_hint: '…7001', linked_at: '2026-10-10T00:00:00Z' }]);
    expect(JSON.stringify(res.data)).not.toContain('777001');

    const [exchange, get] = fetchLog;
    expect(exchange.url).toBe(`${GATEWAY}/v1/identity/sessions/exchange`);
    const session = assertionOf(exchange);
    expect([field(session.header, 'typ'), field(session.claims, 'sub')]).toEqual(['dewee-session+jwt', alice.userId]);
    expect(JSON.parse(String(exchange.init?.body))).toEqual({ agent_id: 'zuey-ai', ttl_seconds: 60 });
    expect(get.url).toBe(`${GATEWAY}/v1/identity/me/bindings`);
    expect(new Headers(get.init?.headers).get('x-dewee-identity-session')).toBe('dis_session_token');
    expect(new Headers(get.init?.headers).get('authorization')).toBeNull();
  });

  it('unlinks a binding by id for the signed-in member only', async () => {
    fakeDewee();
    const alice = await member('alice@example.com');
    const ok = await read(await unlink(browser(alice.cookie), BINDING_ID));
    expect([ok.status, field(ok.data, 'unlinked')]).toEqual([200, true]);
    const del = fetchLog.find(f => f.init?.method === 'DELETE');
    expect(del?.url).toBe(`${GATEWAY}/v1/identity/me/bindings/${BINDING_ID}`);
    expect(field(assertionOf(fetchLog[0]).claims, 'sub')).toBe(alice.userId);

    expect((await read(await unlink(browser(alice.cookie), 'not-a-uuid'))).code).toBe('invalid_field');
    fakeDewee({ unlinkStatus: 404 });
    expect((await read(await unlink(browser(alice.cookie), BINDING_ID))).code).toBe('not_found');

    const { secret: key } = await createUserKey(d1, alice.userId, { name: 'k', scopes: ['account:read'], expires_in_days: 30 });
    expect((await unlink(bearer(key), BINDING_ID)).status).toBe(403);
    expect((await unlink({ cookie: alice.cookie, Origin: 'https://evil.example' }, BINDING_ID)).status).toBe(403);
    expect((await unlink({}, BINDING_ID)).status).toBe(401);
  });

  it('answers 503 when Dewee linking is not configured and 502 when Dewee fails', async () => {
    const alice = await member('alice@example.com');
    const unconfigured = await read(await list(browser(alice.cookie), baseEnv()));
    expect([unconfigured.status, unconfigured.code]).toEqual([503, 'dewee_identity_unconfigured']);
    expect(fetchLog.length).toBe(0);
    fetchImpl = async () => json({ error: { code: 'INTERNAL', message: 'x' } }, 500);
    const failed = await read(await list(browser(alice.cookie)));
    expect([failed.status, failed.code]).toEqual([502, 'dewee_identity_unavailable']);
  });

  it('is reachable only from the browser session, never with a personal API key', async () => {
    fakeDewee();
    const alice = await member('alice@example.com');
    const { secret: key } = await createUserKey(d1, alice.userId, { name: 'k', scopes: ['account:read'], expires_in_days: 30 });
    const refused = await read(await list(bearer(key)));
    expect(refused.status).toBe(403);
    expect((await list({})).status).toBe(401);
    // No Dewee principal is created for a refused caller.
    expect(fetchLog.length).toBe(0);
  });

  it('refuses a request the browser marks as cross-site, such as a top-level navigation from another site', async () => {
    fakeDewee();
    const alice = await member('alice@example.com');
    for (const site of ['cross-site', 'same-site']) {
      const refused = await read(await list({ cookie: alice.cookie, 'Sec-Fetch-Site': site }));
      expect([refused.status, refused.code]).toEqual([403, 'cross_site_request']);
    }
    expect(fetchLog.length).toBe(0);
    // The account page's own fetch, a typed URL, and clients that send no Sec-Fetch-Site still work.
    expect((await list({ cookie: alice.cookie, 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
    expect((await list({ cookie: alice.cookie, 'Sec-Fetch-Site': 'none' })).status).toBe(200);
    expect((await list({ cookie: alice.cookie })).status).toBe(200);
  });

  it('throttles list and unlink to 6 per member per minute before calling Dewee', async () => {
    fakeDewee();
    const alice = await member('alice@example.com');
    const bob = await member('bob@example.com');
    for (let i = 0; i < 5; i += 1) expect((await list(browser(alice.cookie))).status).toBe(200);
    expect((await unlink(browser(alice.cookie), BINDING_ID)).status).toBe(200);
    const exchangesBefore = fetchLog.filter(f => f.url.endsWith('/sessions/exchange')).length;
    const limited = await read(await list(browser(alice.cookie)));
    expect([limited.status, limited.code]).toEqual([429, 'rate_limited']);
    expect((await read(await unlink(browser(alice.cookie), BINDING_ID))).code).toBe('rate_limited');
    expect(fetchLog.filter(f => f.url.endsWith('/sessions/exchange')).length).toBe(exchangesBefore);
    // Another member has their own budget, and the window resets after a minute.
    expect((await list(browser(bob.cookie))).status).toBe(200);
    now += 60_000;
    expect((await list(browser(alice.cookie))).status).toBe(200);
  });

  it('reports a Dewee that does not serve linking for this application as 503, not as a missing binding', async () => {
    const alice = await member('alice@example.com');
    // Session exchange NOT_FOUND: unknown application or agent, or exchange disabled.
    fakeDewee({ exchangeStatus: 404 });
    const exchange = await read(await list(browser(alice.cookie)));
    expect([exchange.status, exchange.code]).toEqual([503, 'dewee_identity_unavailable']);
    const exchangeUnlink = await read(await unlink(browser(alice.cookie), BINDING_ID));
    expect([exchangeUnlink.status, exchangeUnlink.code]).toEqual([503, 'dewee_identity_unavailable']);
    // The list route answering 404 is the same configuration problem; only an unlink may miss a binding.
    fakeDewee({ listStatus: 404 });
    const listed = await read(await list(browser(alice.cookie)));
    expect([listed.status, listed.code]).toEqual([503, 'dewee_identity_unavailable']);
    fakeDewee({ unlinkStatus: 404 });
    const missing = await read(await unlink(browser(alice.cookie), BINDING_ID));
    expect([missing.status, missing.code]).toEqual([404, 'not_found']);
  });
});

describe('Dewee identity configuration', () => {
  it('accepts https, or http on loopback only, without credentials, query or fragment', () => {
    const missing = (extra: Partial<RuntimeEnv>) => missingDeweeIdentityEnv(identityEnv(extra));
    expect(missing({})).toEqual([]);
    expect(missing({ DEWEE_CONNECT_BASE_URL: undefined })).toEqual([]);
    expect(missing({ DEWEE_GATEWAY_URL: 'http://localhost:8080', DEWEE_CONNECT_BASE_URL: 'http://127.0.0.1:3000' })).toEqual([]);
    expect(missing({ DEWEE_CONNECT_BASE_URL: 'http://[::1]:3000' })).toEqual([]);
    for (const bad of ['http://connect.dewee.test', 'https://user:pw@connect.dewee.test', 'https://connect.dewee.test?x=1', 'https://connect.dewee.test/#f', 'connect.dewee.test', 'ftp://connect.dewee.test', 'https://']) {
      expect(missing({ DEWEE_CONNECT_BASE_URL: bad })).toEqual(['DEWEE_CONNECT_BASE_URL']);
      expect(missing({ DEWEE_GATEWAY_URL: bad })).toEqual(['DEWEE_GATEWAY_URL']);
    }
  });
});

describe('/dewee/connect handoff', () => {
  const RETURN_TO = `${CONNECT_BASE}/connect/return`;
  const TXN = 'txn_0123456789abcdefABCDEF';
  const open = (headers: Record<string, string>, query: string, env = identityEnv()) =>
    deweeConnectPage(ctx({ env, path: `/dewee/connect${query}`, headers }));
  const query = (txn = TXN, returnTo = RETURN_TO) => `?dewee_txn=${encodeURIComponent(txn)}&return_to=${encodeURIComponent(returnTo)}`;

  it('sends a signed-out visitor to sign in and back to the same handoff', async () => {
    const res = await open({}, query());
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith('/login?next=')).toBe(true);
    expect(decodeURIComponent(location.slice('/login?next='.length))).toBe(`/dewee/connect${query()}`);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(isSensitivePath('/dewee/connect')).toBe(true);
    expect(isSensitivePath('/login')).toBe(true);
  });

  it('posts a handoff assertion for the signed-in member, bound to dewee_txn, back to Dewee only', async () => {
    const alice = await member('alice@example.com');
    const res = await open({ cookie: alice.cookie }, query());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    // The auto-posting form can never be framed (clickjacking the handoff).
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain(`action="${RETURN_TO}"`);
    const assertion = /name="assertion" value="([^"]+)"/.exec(html)?.[1] ?? '';
    const { header, claims } = decodeJws(assertion);
    expect(field(header, 'typ')).toBe('dewee-handoff+jwt');
    expect([field(claims, 'sub'), field(claims, 'nonce'), field(claims, 'aud')]).toEqual([alice.userId, TXN, `dewee:${APP_ID}`]);
    expect(fetchLog.length).toBe(0);
  });

  it('refuses a foreign return_to or a malformed dewee_txn before signing anything', async () => {
    const alice = await member('alice@example.com');
    for (const q of [query(TXN, 'https://evil.example/connect/return'), query(TXN, `${RETURN_TO}?x=1`), query('short'), '']) {
      const res = await open({ cookie: alice.cookie }, q);
      const body = await res.text();
      expect(res.status).toBe(400);
      expect(body).toContain('invalid_connect_request');
      expect(body).not.toContain('assertion');
    }
  });

  it('answers 503 when Dewee linking is not configured', async () => {
    const alice = await member('alice@example.com');
    const res = await read(await open({ cookie: alice.cookie }, query(), baseEnv({ DEWEE_GATEWAY_URL: GATEWAY })));
    expect([res.status, res.code]).toEqual([503, 'dewee_identity_unconfigured']);
  });

  it('answers 503 naming the variable, not 400, when a Dewee URL is misconfigured', async () => {
    const alice = await member('alice@example.com');
    const badEnv = identityEnv({ DEWEE_CONNECT_BASE_URL: 'http://connect.dewee.test' });
    const res = await open({ cookie: alice.cookie }, query(TXN, 'http://connect.dewee.test/connect/return'), badEnv);
    expect(res.status).toBe(503);
    const body: unknown = await res.json();
    expect(field(body, 'error', 'code')).toBe('dewee_identity_unconfigured');
    expect(JSON.stringify(body)).toContain('DEWEE_CONNECT_BASE_URL');
    const badGateway = await read(await open({ cookie: alice.cookie }, query(), identityEnv({ DEWEE_GATEWAY_URL: 'https://dewee.test?x=1' })));
    expect([badGateway.status, badGateway.code]).toEqual([503, 'dewee_identity_unconfigured']);
  });
});

describe('no linking state or gateway operator token left in zuey.me', () => {
  function filesUnder(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? filesUnder(p) : [p];
    });
  }

  it('never references DEWEE_GATEWAY_TOKEN under src/lib/channel-access/ or any connect route', () => {
    const files = [...filesUnder(path.join(ROOT, 'src', 'lib', 'channel-access')), ...filesUnder(path.join(ROOT, 'src', 'pages', 'dewee'))];
    expect(files.length).toBeGreaterThan(4);
    for (const f of files) expect({ file: path.relative(ROOT, f), token: fs.readFileSync(f, 'utf8').includes('DEWEE_GATEWAY_TOKEN') }).toEqual({ file: path.relative(ROOT, f), token: false });
    // The old /connect pages and token redemption are gone.
    for (const gone of ['connect.astro', path.join('connect', 'link.ts'), path.join('connect', 'cancel.ts'), path.join('api', 'v1', 'channel-access', 'link.ts')]) {
      expect(fs.existsSync(path.join(ROOT, 'src', 'pages', gone))).toBe(false);
    }
  });

  it('drops the sender mapping and nonce tables, with the deploy-order note in the migration', async () => {
    const tables = await d1.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('channel_identities', 'channel_link_nonces')").all<{ name: string }>();
    expect(tables.results).toEqual([]);
    const sql = fs.readFileSync(path.join(ROOT, 'migrations', '0033_drop_channel_link_tables.sql'), 'utf8');
    expect(sql).toContain('DEPLOY ORDER');
    expect(sql).toContain('hosted mode first');
    expect(sql).toContain('Back up before applying');
  });
});

describe('community sweep caller auth', () => {
  const tgEnv = (extra: Partial<RuntimeEnv> = {}) => baseEnv({
    TELEGRAM_BOT_TOKEN: '123:secret-token', TELEGRAM_GROUP_EN_ID: '-1001', TELEGRAM_GROUP_VI_ID: '-1002', TELEGRAM_WEBHOOK_SECRET: 'hook', CRON_SECRET, ...extra,
  });

  it('accepts the scheduler CRON_SECRET and still lets admins run it', async () => {
    experienceRuntime.fetch = async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    const sweep = (headers: Record<string, string>, env = tgEnv()) => communitySweepApi(ctx({ env, method: 'POST', path: '/api/v1/community/sweep', headers, body: {} }));
    expect((await read(await sweep(bearer(CRON_SECRET)))).status).toBe(200);
    expect((await read(await sweep(bearer('wrong')))).status).toBe(401);
    expect((await read(await sweep({}))).code).toBe('unauthorized');
    expect((await read(await sweep(bearer(CRON_SECRET), tgEnv({ CRON_SECRET: undefined })))).status).toBe(401);
    const reader = await member('reader@example.com');
    expect((await read(await sweep(browser(reader.cookie)))).status).toBe(403);
    const admin = await member('boss@example.com');
    expect((await read(await sweep(browser(admin.cookie)))).status).toBe(200);
  });

  it('is not scheduled until the sweep is safe to run unattended', () => {
    const src = fs.readFileSync(path.join(ROOT, 'workers', 'scheduler', 'src', 'index.ts'), 'utf8');
    expect(src).not.toContain('/api/v1/community/sweep');
  });
});
