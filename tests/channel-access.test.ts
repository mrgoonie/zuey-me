import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createApiKey } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { signLinkToken, verifyLinkToken } from '../src/lib/channel-access/link-token';
import { subjectRef } from '../src/lib/channel-access/check';
import {
  CLEAR_LINK_TOKEN_COOKIE, CONNECT_LOGIN_REDIRECT, LINK_TOKEN_COOKIE, LINK_TOKEN_COOKIE_OPTIONS, connectEntry, keepLinkTokenCookie,
} from '../src/lib/channel-access/connect-flow';
import { invalidateSenders } from '../src/lib/channel-access/invalidate';
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
import { deleteAccount, findOrCreateVerifiedUser, getUserById } from '../src/lib/members/users';
import { experienceRuntime } from '../src/lib/experience/runtime';
import { POST as mcpApi } from '../src/pages/api/mcp';
import { POST as checkApi } from '../src/pages/api/v1/channel-access/check';
import { POST as linkApi } from '../src/pages/api/v1/channel-access/link';
import { GET as myChannelsApi } from '../src/pages/api/v1/me/channels/index';
import { DELETE as unlinkApi } from '../src/pages/api/v1/me/channels/[provider]/[externalId]';
import { POST as communitySweepApi } from '../src/pages/api/v1/community/sweep';

const ORIGIN = 'https://zuey.test';
const T0 = Date.parse('2026-10-11T03:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SERVICE_KEY = 'svc_'.padEnd(48, 'k');
const LINK_SECRET = 'link-secret-'.padEnd(48, 's');
const CRON_SECRET = 'cron-secret-value';
const MIGRATION = fs.readFileSync(path.join(import.meta.dir, '..', 'migrations', '0021_channel_identities.sql'), 'utf8');

type TestDb = ReturnType<typeof createTestD1>;
let d1: TestDb;
let now: number;
let fetchLog: { url: string; init?: RequestInit }[];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
const originalFetch = membersRuntime.fetch;
const originalNow = membersRuntime.now;
const originalExperienceFetch = experienceRuntime.fetch;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field(v: unknown, ...keys: string[]): unknown {
  let cur: unknown = v;
  for (const k of keys) cur = isRecord(cur) ? cur[k] : undefined;
  return cur;
}

const baseEnv = (extra: Partial<RuntimeEnv> = {}): RuntimeEnv => ({
  DB: d1, PUBLIC_SITE_URL: ORIGIN, ADMIN_EMAILS: 'boss@example.com',
  CHANNEL_ACCESS_SERVICE_KEY: SERVICE_KEY, CHANNEL_LINK_TOKEN_SECRET: LINK_SECRET, ...extra,
});

const pushEnv = (extra: Partial<RuntimeEnv> = {}): RuntimeEnv => baseEnv({
  DEWEE_GATEWAY_URL: 'https://dewee.test/', DEWEE_GATEWAY_TOKEN: 'gw-token', DEWEE_CHANNEL_INSTANCE_ID: 'zuey-ai', ...extra,
});

interface CtxOpts { env?: RuntimeEnv; method?: string; path?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; params?: Record<string, string> }

function ctx(opts: CtxOpts): APIContext {
  const headers = new Headers(opts.headers ?? {});
  if (opts.body !== undefined || opts.rawBody !== undefined) headers.set('Content-Type', 'application/json');
  const request = new Request(`${ORIGIN}${opts.path ?? '/api/test'}`, {
    method: opts.method ?? 'GET', headers, body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  // Handlers only read request/params/locals; a full APIContext is not constructible in tests.
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

async function linkDirect(userId: string, senderId: string): Promise<void> {
  await d1.prepare("INSERT INTO channel_identities (provider, external_id, user_id, linked_at, source) VALUES ('telegram', ?, ?, ?, 'link_token')")
    .bind(senderId, userId, new Date(now).toISOString()).run();
}

let nonceSeq = 0;
function tokenPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  nonceSeq += 1;
  return {
    v: 1, channel_type: 'telegram', channel_instance: 'zuey-ai', sender_id: '777001', sender_username: 'alice', tenant: 'master',
    exp: Math.floor(now / 1000) + 900, nonce: `nonce-${nonceSeq}-abcdefgh`, ...extra,
  };
}

const checkBody = (extra: Record<string, unknown> = {}) => ({ version: 1, channel_type: 'telegram', channel_instance: 'zuey-ai', sender_id: '777001', sender_username: 'alice', chat_type: 'direct', ...extra });

async function check(headers: Record<string, string>, body: unknown = checkBody(), env = baseEnv()): Promise<Envelope> {
  return read(await checkApi(ctx({ env, method: 'POST', path: '/api/v1/channel-access/check', headers, body })));
}

async function mcpCall(headers: Record<string, string>, name: string, args: Record<string, unknown>, env = baseEnv()): Promise<{ status: number; result: unknown; error: unknown }> {
  const res = await mcpApi(ctx({ env, method: 'POST', path: '/api/mcp', headers, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } }));
  const body: unknown = await res.json();
  const text = field(body, 'result', 'content');
  const first = Array.isArray(text) ? text[0] : undefined;
  const parsed: unknown = typeof field(first, 'text') === 'string' ? JSON.parse(String(field(first, 'text'))) : null;
  return { status: res.status, result: parsed, error: field(body, 'error') };
}

async function linkRaw(cookie: string, token: unknown, env = baseEnv()): Promise<Response> {
  return linkApi(ctx({ env, method: 'POST', path: '/api/v1/channel-access/link', headers: browser(cookie), body: { token } }));
}

async function link(cookie: string, token: unknown, env = baseEnv()): Promise<Envelope> {
  return read(await linkRaw(cookie, token, env));
}

beforeEach(() => {
  d1 = createTestD1();
  now = T0;
  membersRuntime.now = () => now;
  fetchLog = [];
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
});

describe('agent_chat entitlement', () => {
  it('is granted by every plan that includes Zuey AI and not by Knowledges', () => {
    const granting = PLANS.filter(p => p.entitlements.includes('agent_chat')).map(p => p.id);
    expect(granting).toEqual(['ai', 'combo', 'community']);
  });

  it('registers the tool, its catalogue visibility and the OpenAPI fragment', () => {
    expect(MCP_FEATURE_MODULES).toContain(channelAccessMcpModule);
    expect(OPENAPI_FRAGMENTS).toContain(channelAccessOpenApi);
    expect(TOOL_ACCESS.channel_access_check).toEqual({ kind: 'admin' });
    expect(Object.keys(channelAccessOpenApi.paths)).toContain('/api/v1/channel-access/check');
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
    expect(field(ok.data, 'decision')).toBe('link_required');
  });

  it('answers 503 when the key is missing or too weak to be safe', async () => {
    expect((await check(bearer(SERVICE_KEY), checkBody(), baseEnv({ CHANNEL_ACCESS_SERVICE_KEY: undefined }))).code).toBe('channel_access_unconfigured');
    expect((await check(bearer('short'), checkBody(), baseEnv({ CHANNEL_ACCESS_SERVICE_KEY: 'short' }))).code).toBe('channel_access_unconfigured');
  });

  it('rejects missing, wrong, admin and member keys on the MCP tool too', async () => {
    const reader = await member('reader@example.com');
    const { secret: userKey } = await createUserKey(d1, reader.userId, { name: 'k', scopes: ['account:read'], expires_in_days: 30 });
    const { key: adminKey } = await createApiKey('ops', 'admin', d1);
    for (const headers of [{}, bearer('nope'), bearer(adminKey), bearer(userKey)]) {
      const res = await mcpCall(headers, 'channel_access_check', checkBody());
      expect(res.status).toBe(401);
      expect(field(res.error, 'code')).toBe(-32001);
    }
    const ok = await mcpCall(bearer(SERVICE_KEY), 'channel_access_check', checkBody());
    expect(ok.status).toBe(200);
    expect(field(ok.result, 'decision')).toBe('link_required');
  });

  it('grants nothing else: the service key is not an admin credential', async () => {
    const res = await mcpCall(bearer(SERVICE_KEY), 'members_list', {});
    expect([401, 403]).toContain(res.status);
  });

  it('acknowledges MCP notifications on /api/mcp without a body', async () => {
    const res = await mcpApi(ctx({ method: 'POST', path: '/api/mcp', body: { jsonrpc: '2.0', method: 'notifications/initialized' } }));
    expect(res.status).toBe(202);
  });

  it('validates the contract input', async () => {
    expect((await check(bearer(SERVICE_KEY), checkBody({ version: 2 }))).code).toBe('unsupported_version');
    expect((await check(bearer(SERVICE_KEY), checkBody({ channel_type: 'sms' }))).code).toBe('unsupported_channel');
    expect((await check(bearer(SERVICE_KEY), checkBody({ sender_id: '' }))).code).toBe('invalid_field');
    expect((await check(bearer(SERVICE_KEY), checkBody({ sender_id: 'a b' }))).code).toBe('invalid_field');
    expect((await check(bearer(SERVICE_KEY), checkBody({ chat_type: 'channel' }))).code).toBe('invalid_field');
    const raw = await read(await checkApi(ctx({ method: 'POST', headers: bearer(SERVICE_KEY), rawBody: 'not json' })));
    expect(raw.code).toBe('invalid_json');
    // Numeric sender ids are accepted as their decimal string.
    expect((await check(bearer(SERVICE_KEY), checkBody({ sender_id: 777001 }))).status).toBe(200);
  });
});

describe('channel access decisions', () => {
  it('link_required for an unlinked sender, with a /connect link only for a well-formed token', async () => {
    const token = await signLinkToken(tokenPayload(), LINK_SECRET);
    const withToken = await check(bearer(SERVICE_KEY), checkBody({ link_token: token }));
    expect(field(withToken.data, 'decision')).toBe('link_required');
    expect(field(withToken.data, 'link_url')).toBe(`${ORIGIN}/connect?token=${token}`);
    expect(field(withToken.data, 'ttl_seconds')).toBe(30);
    expect(field(withToken.data, 'subject_ref')).toBeUndefined();
    const junk = await check(bearer(SERVICE_KEY), checkBody({ link_token: 'javascript:alert(1)' }));
    expect(field(junk.data, 'link_url')).toBeUndefined();
  });

  it('never hands a link token out in a group chat, where another member could redeem it', async () => {
    const token = await signLinkToken(tokenPayload(), LINK_SECRET);
    const rest = await check(bearer(SERVICE_KEY), checkBody({ chat_type: 'group', chat_id: '-100123', link_token: token }));
    expect(rest.status).toBe(200);
    expect(field(rest.data, 'decision')).toBe('link_required');
    expect(field(rest.data, 'link_url')).toBeUndefined();
    expect(String(field(rest.data, 'reply'))).toContain('direct message');
    expect(JSON.stringify(rest.data)).not.toContain(token);
    expect(JSON.stringify(rest.data)).not.toContain('/connect');

    const viaMcp = await mcpCall(bearer(SERVICE_KEY), 'channel_access_check', checkBody({ chat_type: 'group', link_token: token }));
    expect(field(viaMcp.result, 'decision')).toBe('link_required');
    expect(JSON.stringify(viaMcp.result)).not.toContain(token);
    expect(field(viaMcp.result, 'link_url')).toBeUndefined();

    // Linked senders get the same allow/deny in groups as in direct chats.
    const alice = await member('alice@example.com');
    await linkDirect(alice.userId, '777001');
    await grantPlan(alice.userId, 'ai', now + DAY);
    expect(field((await check(bearer(SERVICE_KEY), checkBody({ chat_type: 'group', link_token: token }))).data, 'decision')).toBe('allow');
  });

  it('allow for a linked member with an active agent plan; deny with the pricing link once it expires', async () => {
    const alice = await member('alice@example.com');
    await linkDirect(alice.userId, '777001');
    await grantPlan(alice.userId, 'ai', now + 2 * DAY);
    const allowed = await check(bearer(SERVICE_KEY));
    expect(field(allowed.data, 'decision')).toBe('allow');
    expect(field(allowed.data, 'ttl_seconds')).toBe(300);
    const ref = String(field(allowed.data, 'subject_ref'));
    expect(ref).toBe(await subjectRef(alice.userId));
    expect(ref).not.toContain('alice');
    expect(ref).not.toContain(alice.userId);

    now += 3 * DAY;
    const denied = await check(bearer(SERVICE_KEY));
    expect(field(denied.data, 'decision')).toBe('deny');
    expect(field(denied.data, 'link_url')).toBe(`${ORIGIN}/pricing`);
    expect(field(denied.data, 'ttl_seconds')).toBe(30);
    expect(field(denied.data, 'subject_ref')).toBe(ref);
    expect(String(field(denied.data, 'reply'))).toContain('/pricing');
  });

  it('denies a Knowledges-only member and allows combo, community and admins', async () => {
    const reader = await member('reader@example.com');
    await linkDirect(reader.userId, '1');
    await grantPlan(reader.userId, 'knowledges', now + DAY);
    expect(field((await check(bearer(SERVICE_KEY), checkBody({ sender_id: '1' }))).data, 'decision')).toBe('deny');
    await grantPlan(reader.userId, 'combo', now + DAY);
    expect(field((await check(bearer(SERVICE_KEY), checkBody({ sender_id: '1' }))).data, 'decision')).toBe('allow');

    const fan = await member('fan@example.com');
    await linkDirect(fan.userId, '2');
    await grantPlan(fan.userId, 'community', now + DAY);
    expect(field((await check(bearer(SERVICE_KEY), checkBody({ sender_id: '2' }))).data, 'decision')).toBe('allow');

    const boss = await member('boss@example.com');
    await linkDirect(boss.userId, '3');
    expect(field((await check(bearer(SERVICE_KEY), checkBody({ sender_id: '3' }))).data, 'decision')).toBe('allow');
  });

  it('keeps an auto-renewing card plan open through the renewal grace period, then denies', async () => {
    const carol = await member('carol@example.com');
    await linkDirect(carol.userId, '777001');
    const periodEnd = new Date(now + HOUR).toISOString();
    const ts = new Date(now).toISOString();
    await d1.prepare(
      "INSERT INTO card_subscriptions (id, provider, provider_subscription_id, user_id, plan, status, current_period_end, cancel_at_period_end, created_at, updated_at) VALUES ('cs_1', 'dodo', 'sub_1', ?, 'ai', 'active', ?, 0, ?, ?)"
    ).bind(carol.userId, periodEnd, ts, ts).run();
    await recomputeSubscription(d1, carol.userId, 'ai');
    now += 5 * HOUR; // past the provider billing date, inside the 24-hour grace
    expect(field((await check(bearer(SERVICE_KEY))).data, 'decision')).toBe('allow');
    now += DAY; // grace over and no renewal webhook
    expect(field((await check(bearer(SERVICE_KEY))).data, 'decision')).toBe('deny');
  });

  it('treats a link to a deleted account as not linked', async () => {
    const gone = await member('gone@example.com');
    await linkDirect(gone.userId, '777001');
    await grantPlan(gone.userId, 'ai', now + DAY);
    const user = await getUserById(d1, gone.userId);
    if (!user) throw new Error('missing user');
    await deleteAccount(d1, user, baseEnv());
    expect(field((await check(bearer(SERVICE_KEY))).data, 'decision')).toBe('link_required');
  });
});

describe('link tokens', () => {
  it('verifies the documented format and rejects tampered, expired, malformed and foreign tokens', async () => {
    const good = await signLinkToken(tokenPayload(), LINK_SECRET);
    const ok = await verifyLinkToken(good, LINK_SECRET, now);
    expect(ok.ok && ok.payload.sender_id).toBe('777001');

    const [payloadPart, sig] = good.split('.');
    // Retarget the payload at sender B but keep A's signature.
    const forged = Buffer.from(JSON.stringify(tokenPayload({ sender_id: '999' }))).toString('base64url');
    expect(await verifyLinkToken(`${forged}.${sig}`, LINK_SECRET, now)).toEqual({ ok: false, error: 'bad_signature' });
    const flipped = `${payloadPart}.${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BA' : 'AA'}`;
    expect((await verifyLinkToken(flipped, LINK_SECRET, now)).ok).toBe(false);
    expect(await verifyLinkToken(good, 'another-secret-of-sufficient-length-000000', now)).toEqual({ ok: false, error: 'bad_signature' });
    expect(await verifyLinkToken(await signLinkToken(tokenPayload({ exp: Math.floor(now / 1000) - 1 }), LINK_SECRET), LINK_SECRET, now)).toEqual({ ok: false, error: 'expired' });
    expect(await verifyLinkToken(await signLinkToken(tokenPayload({ exp: Math.floor(now / 1000) + 3 * 86400 }), LINK_SECRET), LINK_SECRET, now)).toEqual({ ok: false, error: 'malformed' });
    expect(await verifyLinkToken(await signLinkToken(tokenPayload({ channel_type: 'sms' }), LINK_SECRET), LINK_SECRET, now)).toEqual({ ok: false, error: 'unsupported_channel' });
    expect(await verifyLinkToken(await signLinkToken(tokenPayload({ v: 2 }), LINK_SECRET), LINK_SECRET, now)).toEqual({ ok: false, error: 'unsupported_version' });
    expect(await verifyLinkToken(await signLinkToken(tokenPayload({ nonce: 'x' }), LINK_SECRET), LINK_SECRET, now)).toEqual({ ok: false, error: 'malformed' });
    expect(await verifyLinkToken(await signLinkToken(tokenPayload({ sender_id: '' }), LINK_SECRET), LINK_SECRET, now)).toEqual({ ok: false, error: 'malformed' });
    for (const bad of ['', 'abc', 'a.b.c', `${payloadPart}.`, 'x'.repeat(3000), 42, null]) {
      expect((await verifyLinkToken(bad, LINK_SECRET, now)).ok).toBe(false);
    }
  });

  it('links the token sender to the signed-in member, once, and the gate then allows', async () => {
    const alice = await member('alice@example.com');
    await grantPlan(alice.userId, 'combo', now + DAY);
    const token = await signLinkToken(tokenPayload(), LINK_SECRET);
    const first = await link(alice.cookie, token);
    expect(first.status).toBe(200);
    expect(field(first.data, 'external_id')).toBe('777001');
    expect(field(first.data, 'already_linked')).toBe(false);
    expect(field(first.data, 'entitled')).toBe(true);
    // The token linked exactly its own sender: another sender stays unlinked.
    expect(field((await check(bearer(SERVICE_KEY))).data, 'decision')).toBe('allow');
    expect(field((await check(bearer(SERVICE_KEY), checkBody({ sender_id: '999' }))).data, 'decision')).toBe('link_required');

    const replay = await link(alice.cookie, token);
    expect(replay.status).toBe(409);
    expect(replay.code).toBe('link_token_used');

    // A fresh token for the same sender and member is an idempotent success.
    const again = await link(alice.cookie, await signLinkToken(tokenPayload(), LINK_SECRET));
    expect(field(again.data, 'already_linked')).toBe(true);
    const rows = await d1.prepare("SELECT COUNT(*) AS n FROM channel_identities WHERE provider = 'telegram' AND external_id = '777001'").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('clears the /connect token cookie once the token is spent, and keeps it on configuration errors', async () => {
    const alice = await member('alice@example.com');
    const token = await signLinkToken(tokenPayload(), LINK_SECRET);
    const ok = await linkRaw(alice.cookie, token);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toBe(CLEAR_LINK_TOKEN_COOKIE);
    const used = await linkRaw(alice.cookie, token);
    expect(used.status).toBe(409);
    expect(used.headers.get('set-cookie')).toBe(CLEAR_LINK_TOKEN_COOKIE);
    expect((await linkRaw(alice.cookie, 'garbage')).headers.get('set-cookie')).toBe(CLEAR_LINK_TOKEN_COOKIE);
    const unconfigured = await linkRaw(alice.cookie, await signLinkToken(tokenPayload(), LINK_SECRET), baseEnv({ CHANNEL_LINK_TOKEN_SECRET: undefined }));
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.headers.get('set-cookie')).toBeNull();
    expect(CLEAR_LINK_TOKEN_COOKIE).toBe(`${LINK_TOKEN_COOKIE}=; Path=/connect; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  });

  it('commits the nonce and the link together, so a refused link never burns the token', async () => {
    const alice = await member('alice@example.com');
    const mallory = await member('mallory@example.com');
    const token = await signLinkToken(tokenPayload(), LINK_SECRET);
    // Another member holds the sender: refused, and neither the nonce nor a second link is written.
    await linkDirect(mallory.userId, '777001');
    expect((await link(alice.cookie, token)).code).toBe('channel_linked_elsewhere');
    const nonces = await d1.prepare('SELECT COUNT(*) AS n FROM channel_link_nonces').first<{ n: number }>();
    expect(nonces?.n).toBe(0);

    // A failing identity insert inside the batch rolls the nonce back too.
    await d1.prepare("DELETE FROM channel_identities WHERE external_id = '777001'").run();
    await expect(d1.batch([
      d1.prepare("INSERT INTO channel_link_nonces (nonce, provider, external_id, user_id, used_at, expires_at) VALUES ('n1', 'telegram', '1', ?, 'x', 'y')").bind(alice.userId),
      d1.prepare("INSERT INTO channel_identities (provider, external_id, user_id, linked_at, source) VALUES ('telegram', '1', ?, 'x', 'bogus_source')").bind(alice.userId),
    ])).rejects.toThrow();
    expect((await d1.prepare('SELECT COUNT(*) AS n FROM channel_link_nonces').first<{ n: number }>())?.n).toBe(0);

    // Once the sender is free, the same token still works.
    expect((await link(alice.cookie, token)).status).toBe(200);
  });

  it('treats a verified admin identity as entitled when linking', async () => {
    const boss = await member('boss@example.com');
    expect(field((await link(boss.cookie, await signLinkToken(tokenPayload(), LINK_SECRET))).data, 'entitled')).toBe(true);
    const reader = await member('reader@example.com');
    expect(field((await link(reader.cookie, await signLinkToken(tokenPayload({ sender_id: '555' }), LINK_SECRET))).data, 'entitled')).toBe(false);
  });

  it('refuses tokens minted for another dewee channel instance once the instance is configured', async () => {
    const alice = await member('alice@example.com');
    const foreign = await signLinkToken(tokenPayload({ channel_instance: 'other-bot' }), LINK_SECRET);
    const pinned = baseEnv({ DEWEE_CHANNEL_INSTANCE_ID: 'zuey-ai' });
    const refused = await link(alice.cookie, foreign, pinned);
    expect(refused.status).toBe(400);
    expect(refused.code).toBe('invalid_link_token');
    expect((await link(alice.cookie, await signLinkToken(tokenPayload(), LINK_SECRET), pinned)).status).toBe(200);
    // Without a configured instance any instance is accepted (single-bot setups).
    expect((await link(alice.cookie, await signLinkToken(tokenPayload({ channel_instance: 'other-bot', sender_id: '556' }), LINK_SECRET))).status).toBe(200);
  });

  it('never maps one Telegram id to two members', async () => {
    const alice = await member('alice@example.com');
    const mallory = await member('mallory@example.com');
    expect((await link(alice.cookie, await signLinkToken(tokenPayload(), LINK_SECRET))).status).toBe(200);
    const stolen = await link(mallory.cookie, await signLinkToken(tokenPayload(), LINK_SECRET));
    expect(stolen.status).toBe(409);
    expect(stolen.code).toBe('channel_linked_elsewhere');
    const owner = await d1.prepare("SELECT user_id FROM channel_identities WHERE external_id = '777001'").first<{ user_id: string }>();
    expect(owner?.user_id).toBe(alice.userId);
  });

  it('rejects bad tokens, reports a missing plan and requires a browser session', async () => {
    const bob = await member('bob@example.com');
    expect((await link(bob.cookie, 'garbage')).code).toBe('invalid_link_token');
    expect((await link(bob.cookie, await signLinkToken(tokenPayload({ exp: Math.floor(now / 1000) - 5 }), LINK_SECRET))).code).toBe('link_token_expired');
    expect((await link(bob.cookie, await signLinkToken(tokenPayload(), 'wrong-secret-wrong-secret-wrong-secret!!'))).code).toBe('invalid_link_token');
    expect((await link(bob.cookie, await signLinkToken(tokenPayload(), LINK_SECRET), baseEnv({ CHANNEL_LINK_TOKEN_SECRET: undefined }))).code).toBe('channel_link_unconfigured');

    const linked = await link(bob.cookie, await signLinkToken(tokenPayload(), LINK_SECRET));
    expect(field(linked.data, 'entitled')).toBe(false);
    expect(field((await check(bearer(SERVICE_KEY))).data, 'decision')).toBe('deny');

    const { secret } = await createUserKey(d1, bob.userId, { name: 'k', scopes: ['account:read', 'account:write'], expires_in_days: 30 });
    const viaKey = await read(await linkApi(ctx({ method: 'POST', headers: bearer(secret), body: { token: await signLinkToken(tokenPayload(), LINK_SECRET) } })));
    expect(viaKey.code).toBe('session_required');
    const crossSite = await read(await linkApi(ctx({ method: 'POST', headers: { cookie: bob.cookie, Origin: 'https://evil.example' }, body: { token: 'x' } })));
    expect([401, 403]).toContain(crossSite.status);
  });

  it('lists and unlinks the member own chat accounts and pushes an invalidation', async () => {
    const alice = await member('alice@example.com');
    const other = await member('other@example.com');
    await link(alice.cookie, await signLinkToken(tokenPayload(), LINK_SECRET), pushEnv());
    const listed = await read(await myChannelsApi(ctx({ headers: browser(alice.cookie) })));
    expect(listed.data).toEqual([{ provider: 'telegram', external_id: '777001', linked_at: new Date(now).toISOString(), source: 'link_token' }]);

    const foreign = await read(await unlinkApi(ctx({ env: pushEnv(), method: 'DELETE', headers: browser(other.cookie), params: { provider: 'telegram', externalId: '777001' } })));
    expect(foreign.status).toBe(404);
    fetchLog = [];
    const removed = await read(await unlinkApi(ctx({ env: pushEnv(), method: 'DELETE', headers: browser(alice.cookie), params: { provider: 'telegram', externalId: '777001' } })));
    expect(field(removed.data, 'unlinked')).toBe(true);
    expect(fetchLog.map(f => f.url)).toEqual(['https://dewee.test/v1/channels/instances/zuey-ai/access/invalidate']);
    expect(field((await check(bearer(SERVICE_KEY))).data, 'decision')).toBe('link_required');
  });
});

describe('/connect token handling', () => {
  it('parks a query token in the HttpOnly cookie and reloads the bare /connect', () => {
    const token = 'eyJ2IjoxfQ.c2ln';
    expect(connectEntry(new URL(`${ORIGIN}/connect?token=${token}`), null)).toEqual({ kind: 'park', token });
    // A new link replaces an older parked token; an empty or oversized one clears it.
    expect(connectEntry(new URL(`${ORIGIN}/connect?token=${token}`), 'older')).toEqual({ kind: 'park', token });
    expect(connectEntry(new URL(`${ORIGIN}/connect?token=`), 'older')).toEqual({ kind: 'park', token: null });
    expect(connectEntry(new URL(`${ORIGIN}/connect?token=${'a'.repeat(3000)}`), null)).toEqual({ kind: 'park', token: null });
    expect(connectEntry(new URL(`${ORIGIN}/connect`), token)).toEqual({ kind: 'continue', token });
    expect(connectEntry(new URL(`${ORIGIN}/connect`), null)).toEqual({ kind: 'continue', token: null });
    expect(LINK_TOKEN_COOKIE_OPTIONS).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/connect', maxAge: 1800 });
  });

  it('signs in through next=/connect, so no URL that analytics records carries the token', () => {
    expect(CONNECT_LOGIN_REDIRECT).toBe('/login?next=%2Fconnect');
    const page = fs.readFileSync(path.join(import.meta.dir, '..', 'src', 'pages', 'connect.astro'), 'utf8');
    expect(page).toContain('connectEntry(Astro.url');
    expect(page).toContain('Astro.redirect(CONNECT_PATH, 302)');
    expect(page).toContain('Astro.redirect(CONNECT_LOGIN_REDIRECT, 302)');
    expect(page).not.toContain('searchParams.get');
    expect(page).not.toContain('next=');
  });

  it('keeps the cookie only while the token can still link', () => {
    expect(keepLinkTokenCookie('ready', null)).toBe(true);
    for (const state of ['linked_to_you', 'linked_elsewhere', 'used'] as const) expect(keepLinkTokenCookie(state, null)).toBe(false);
    for (const code of ['invalid_link_token', 'link_token_expired', 'unsupported_channel', 'link_token_used']) expect(keepLinkTokenCookie('error', code)).toBe(false);
    for (const code of ['channel_link_unconfigured', 'database_unavailable', 'missing_token']) expect(keepLinkTokenCookie('error', code)).toBe(true);
  });
});

describe('community backfill migration', () => {
  async function seedMembership(id: string, userId: string, telegramId: string | null, status: string): Promise<void> {
    const ts = new Date(now).toISOString();
    await d1.prepare(
      "INSERT INTO community_memberships (id, user_id, chat, invite_link, invite_expires_at, telegram_user_id, status, created_at, updated_at, joined_at) VALUES (?, ?, 'vi', ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, userId, `https://t.me/+${id}`, ts, telegramId, status, ts, ts, status === 'joined' ? ts : null).run();
  }

  it('links joined Telegram ids that belong to exactly one live member and skips ambiguous ones', async () => {
    const a = await member('a@example.com');
    const b = await member('b@example.com');
    const c = await member('c@example.com');
    const d = await member('d@example.com');
    const e = await member('e@example.com');
    await seedMembership('m1', a.userId, '100', 'joined'); // clean
    await seedMembership('m2', a.userId, '100', 'left'); // same user, other row: still unambiguous
    await seedMembership('m3', b.userId, '200', 'joined'); // shared with c
    await seedMembership('m4', c.userId, '200', 'removed');
    await seedMembership('m5', c.userId, '300', 'left'); // never joined
    await seedMembership('m6', d.userId, '400', 'joined'); // deleted below
    await seedMembership('m7', e.userId, null, 'invited');
    await seedMembership('m8', e.userId, '500', 'joined'); // already linked to someone else
    await linkDirect(a.userId, '500');
    const user = await getUserById(d1, d.userId);
    if (!user) throw new Error('missing user');
    await deleteAccount(d1, user, baseEnv());

    d1.raw.run(MIGRATION);
    d1.raw.run(MIGRATION); // safe to run twice

    const rows = await d1.prepare('SELECT external_id, user_id, source FROM channel_identities ORDER BY external_id').all<{ external_id: string; user_id: string; source: string }>();
    expect(rows.results).toEqual([
      { external_id: '100', user_id: a.userId, source: 'community_backfill' },
      { external_id: '500', user_id: a.userId, source: 'link_token' },
    ]);
  });
});

describe('access change push to dewee', () => {
  async function paidOrder(userId: string, plan: string, paidAt: number): Promise<void> {
    const ts = new Date(paidAt).toISOString();
    await d1.prepare(
      "INSERT INTO billing_orders (id, code, user_id, plan, months, amount_usd_cents, usd_vnd_rate, amount_vnd, status, expires_at, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 900, 26000, 234000, 'paid', ?, ?, ?, ?)"
    ).bind(`ord_${userId}_${plan}_${paidAt}`, `ZM-${userId}-${plan}-${paidAt}`, userId, plan, ts, ts, ts, ts).run();
  }

  it('invalidates every linked sender when an agent plan turns active or expires', async () => {
    const alice = await member('alice@example.com');
    await linkDirect(alice.userId, '777001');
    await linkDirect(alice.userId, '777002');
    await paidOrder(alice.userId, 'ai', now);
    await recomputeSubscription(d1, alice.userId, 'ai', { env: pushEnv() });
    expect(fetchLog.length).toBe(2);
    const [call] = fetchLog;
    expect(call.url).toBe('https://dewee.test/v1/channels/instances/zuey-ai/access/invalidate');
    expect(new Headers(call.init?.headers).get('authorization')).toBe('Bearer gw-token');
    expect(new Headers(call.init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(call.init?.body))).toEqual({ sender_id: '777001' });

    // No status change (re-run): no push.
    fetchLog = [];
    await recomputeSubscription(d1, alice.userId, 'ai', { env: pushEnv() });
    expect(fetchLog.length).toBe(0);

    // Revocation (e.g. a reversed payment) ends access now: a change again. Plain clock expiry needs no push,
    // because dewee re-checks live once its short cache expires.
    await d1.prepare("UPDATE billing_orders SET status = 'needs_attention' WHERE user_id = ?").bind(alice.userId).run();
    await recomputeSubscription(d1, alice.userId, 'ai', { env: pushEnv() });
    expect(fetchLog.length).toBe(2);
  });

  it('is skipped without env, for plans without agent_chat, and never breaks billing when dewee fails', async () => {
    const alice = await member('alice@example.com');
    await linkDirect(alice.userId, '777001');
    await paidOrder(alice.userId, 'knowledges', now);
    await recomputeSubscription(d1, alice.userId, 'knowledges', { env: pushEnv() });
    await paidOrder(alice.userId, 'ai', now);
    await recomputeSubscription(d1, alice.userId, 'ai', { env: baseEnv() });
    expect(fetchLog.length).toBe(0);

    const bob = await member('bob@example.com');
    await linkDirect(bob.userId, '888');
    await paidOrder(bob.userId, 'combo', now);
    fetchImpl = async () => { throw new Error('network down'); };
    const view = await recomputeSubscription(d1, bob.userId, 'combo', { env: pushEnv() });
    expect(view?.status).toBe('active');
    expect(fetchLog.length).toBe(1);

    const carol = await member('carol@example.com');
    await linkDirect(carol.userId, '999');
    await paidOrder(carol.userId, 'community', now);
    fetchImpl = async () => new Response('nope', { status: 500 });
    expect((await recomputeSubscription(d1, carol.userId, 'community', { env: pushEnv() }))?.status).toBe('active');
  });

  it('sends pushes for several senders in parallel', async () => {
    let inFlight = 0;
    let peak = 0;
    fetchImpl = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight -= 1;
      return new Response('{}', { status: 200 });
    };
    expect(await invalidateSenders(pushEnv(), ['1', '2', '3'])).toEqual({ sent: 3, failed: 0 });
    expect(peak).toBe(3);
    for (const call of fetchLog) expect(call.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('lets the SePay webhook answer without waiting for the dewee push', async () => {
    const alice = await member('alice@example.com');
    await linkDirect(alice.userId, '777001');
    const ts = new Date(now).toISOString();
    await d1.prepare(
      "INSERT INTO billing_orders (id, code, user_id, plan, months, amount_usd_cents, usd_vnd_rate, amount_vnd, status, expires_at, created_at, updated_at) VALUES ('ord_x', 'ZMWAIT1', ?, 'ai', 1, 900, 26000, 234000, 'pending', ?, ?, ?)"
    ).bind(alice.userId, new Date(now + DAY).toISOString(), ts, ts).run();
    let release: () => void = () => undefined;
    const hanging = new Promise<void>(r => { release = r; });
    fetchImpl = async url => {
      if (url.includes('/access/invalidate')) await hanging;
      return new Response('{}', { status: 200 });
    };
    const deferred: Promise<unknown>[] = [];
    const result = await applyBillingPayment(d1, pushEnv(), {
      eventId: 'evt-wait-1', amount: 234000, orderCode: 'ZMWAIT1', paymentRef: 'FT1', rawType: 'transfer_in',
    }, p => { deferred.push(p); });
    // The payment is applied and answered while the push is still pending.
    expect(result.outcome).toBe('paid');
    expect(deferred.length).toBe(1);
    release();
    await Promise.all(deferred);
    expect(fetchLog.filter(f => f.url.includes('/access/invalidate')).length).toBe(1);
  });

  it('threads the runtime waitUntil from both payment webhooks', () => {
    for (const file of ['sepay.ts', 'dodo.ts']) {
      const src = fs.readFileSync(path.join(import.meta.dir, '..', 'src', 'pages', 'api', 'webhooks', file), 'utf8');
      expect(src).toContain('runtimeWaitUntil(locals.runtime)');
    }
  });

  it('hands the push to waitUntil when the runtime provides it', async () => {
    const alice = await member('alice@example.com');
    await linkDirect(alice.userId, '777001');
    await paidOrder(alice.userId, 'ai', now);
    const deferred: Promise<unknown>[] = [];
    await recomputeSubscription(d1, alice.userId, 'ai', { env: pushEnv(), waitUntil: p => { deferred.push(p); } });
    expect(deferred.length).toBe(1);
    await Promise.all(deferred);
    expect(fetchLog.length).toBe(1);
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
    const src = fs.readFileSync(path.join(import.meta.dir, '..', 'workers', 'scheduler', 'src', 'index.ts'), 'utf8');
    expect(src).not.toContain('/api/v1/community/sweep');
  });
});
