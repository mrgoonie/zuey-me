import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createApiKey } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { channelAccessMcpModule } from '../src/lib/channel-access/mcp';
import { channelAccessOpenApi } from '../src/lib/channel-access/openapi';
import { createUserKey } from '../src/lib/members/api-keys';
import { membersRuntime } from '../src/lib/members/runtime';
import { createMemberSession } from '../src/lib/members/session';
import { findOrCreateVerifiedUser, listActivity } from '../src/lib/members/users';
import { TOOL_ACCESS } from '../src/lib/oauth/tool-access';
import { POST as mcpApi } from '../src/pages/api/mcp';
import { DELETE as adminUnlinkApi, GET as adminGetApi } from '../src/pages/api/v1/admin/channel-identities/[provider]/[externalId]';

const ORIGIN = 'https://zuey.test';
const T0 = Date.parse('2026-10-11T03:00:00.000Z');
const ROUTE = '/api/v1/admin/channel-identities/telegram/777001';

type TestDb = ReturnType<typeof createTestD1>;
let d1: TestDb;
let fetchLog: { url: string; init?: RequestInit }[];
const originalFetch = membersRuntime.fetch;
const originalNow = membersRuntime.now;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field(v: unknown, ...keys: string[]): unknown {
  let cur: unknown = v;
  for (const k of keys) cur = isRecord(cur) ? cur[k] : undefined;
  return cur;
}

const pushEnv = (extra: Partial<RuntimeEnv> = {}): RuntimeEnv => ({
  DB: d1, PUBLIC_SITE_URL: ORIGIN, ADMIN_EMAILS: 'boss@example.com',
  DEWEE_GATEWAY_URL: 'https://dewee.test', DEWEE_GATEWAY_TOKEN: 'gw-token', DEWEE_CHANNEL_INSTANCE_ID: 'zuey-ai', ...extra,
});

interface CtxOpts { env?: RuntimeEnv; method: string; headers?: Record<string, string>; rawBody?: string; params?: Record<string, string> }

function ctx(opts: CtxOpts): APIContext {
  const headers = new Headers(opts.headers ?? {});
  headers.set('Content-Type', 'application/json');
  const request = new Request(`${ORIGIN}${ROUTE}`, { method: opts.method, headers, body: opts.rawBody });
  // Handlers only read request/params/locals; a full APIContext is not constructible in tests.
  const partial = {
    request, url: new URL(request.url), params: opts.params ?? { provider: 'telegram', externalId: '777001' },
    locals: { runtime: { env: opts.env ?? pushEnv() } },
  };
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

async function linkDirect(userId: string, senderId: string, source = 'community_backfill'): Promise<void> {
  await d1.prepare("INSERT INTO channel_identities (provider, external_id, user_id, linked_at, source) VALUES ('telegram', ?, ?, ?, ?)")
    .bind(senderId, userId, new Date(T0).toISOString(), source).run();
}

async function linkedTo(senderId: string): Promise<string | null> {
  const row = await d1.prepare("SELECT user_id FROM channel_identities WHERE provider = 'telegram' AND external_id = ?").bind(senderId).first<{ user_id: string }>();
  return row?.user_id ?? null;
}

async function auditRows(): Promise<{ admin: string; action: string; target: string; reason: string }[]> {
  const { results } = await d1.prepare('SELECT admin, action, target, reason FROM admin_access_audit ORDER BY id')
    .all<{ admin: string; action: string; target: string; reason: string }>();
  return results ?? [];
}

async function mcpCall(headers: Record<string, string>, name: string, args: Record<string, unknown>, env = pushEnv()): Promise<{ status: number; result: unknown; error: unknown }> {
  const headersWithType = new Headers(headers);
  headersWithType.set('Content-Type', 'application/json');
  const request = new Request(`${ORIGIN}/api/mcp`, {
    method: 'POST', headers: headersWithType, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const partial = { request, url: new URL(request.url), params: {}, locals: { runtime: { env } } };
  const res = await mcpApi(partial as unknown as APIContext);
  const body: unknown = await res.json();
  const content = field(body, 'result', 'content');
  const first = Array.isArray(content) ? content[0] : undefined;
  const text = field(first, 'text');
  return { status: res.status, result: typeof text === 'string' ? JSON.parse(text) : null, error: field(body, 'error') };
}

beforeEach(() => {
  d1 = createTestD1();
  membersRuntime.now = () => T0;
  fetchLog = [];
  membersRuntime.fetch = async (url, init) => {
    fetchLog.push({ url, init });
    return new Response('{}', { status: 200 });
  };
});

afterEach(() => {
  membersRuntime.fetch = originalFetch;
  membersRuntime.now = originalNow;
});

describe('admin channel identity registration', () => {
  it('registers both tools as admin-only and documents the REST path', () => {
    const names = channelAccessMcpModule.tools.map(t => t.name);
    expect(names).toContain('channel_identity_get');
    expect(names).toContain('channel_identity_unlink');
    expect(TOOL_ACCESS.channel_identity_get).toEqual({ kind: 'admin' });
    expect(TOOL_ACCESS.channel_identity_unlink).toEqual({ kind: 'admin' });
    const pathItem = channelAccessOpenApi.paths['/api/v1/admin/channel-identities/{provider}/{external_id}'];
    expect(Object.keys(pathItem ?? {}).sort()).toEqual(['delete', 'get']);
    expect(channelAccessOpenApi.schemas.AdminChannelIdentity).toBeDefined();
  });
});

describe('admin channel identity REST', () => {
  it('shows which member holds a sender id', async () => {
    const alice = await member('alice@example.com');
    const boss = await member('boss@example.com');
    await linkDirect(alice.userId, '777001');
    const res = await read(await adminGetApi(ctx({ method: 'GET', headers: browser(boss.cookie) })));
    expect(res.status).toBe(200);
    expect(field(res.data, 'user_id')).toBe(alice.userId);
    expect(field(res.data, 'source')).toBe('community_backfill');
    expect(field(res.data, 'member', 'email')).toBe('alice@example.com');
    expect((await read(await adminGetApi(ctx({ method: 'GET', headers: browser(boss.cookie), params: { provider: 'telegram', externalId: '999' } })))).code).toBe('not_found');
  });

  it('lets an admin unlink any member, logs channel.unlinked with the admin as actor and pushes to dewee', async () => {
    const alice = await member('alice@example.com');
    const boss = await member('boss@example.com');
    await linkDirect(alice.userId, '777001');
    await linkDirect(alice.userId, '777002');

    const res = await read(await adminUnlinkApi(ctx({ method: 'DELETE', headers: browser(boss.cookie), rawBody: JSON.stringify({ reason: '  wrong backfill row ' }) })));
    expect(res.status).toBe(200);
    expect(field(res.data, 'unlinked')).toBe(true);
    expect(field(res.data, 'identity', 'member', 'id')).toBe(alice.userId);
    expect(await linkedTo('777001')).toBeNull();
    expect(await linkedTo('777002')).toBe(alice.userId);

    const activity = await listActivity(d1, alice.userId);
    expect(activity.map(a => a.action)).toEqual(['channel.unlinked']);
    expect(activity[0].detail).toEqual({ provider: 'telegram', external_id: '777001', by: 'admin' });
    expect(await auditRows()).toEqual([{ admin: 'boss@example.com', action: 'channel.unlink', target: `channel_identity:telegram:777001:user=${alice.userId}`, reason: 'wrong backfill row' }]);

    expect(fetchLog.length).toBe(1);
    expect(fetchLog[0].url).toBe('https://dewee.test/v1/channels/instances/zuey-ai/access/invalidate');
    expect(JSON.parse(String(fetchLog[0].init?.body))).toEqual({ sender_id: '777001' });

    // Already unlinked: nothing to do, nothing logged or pushed again.
    expect((await read(await adminUnlinkApi(ctx({ method: 'DELETE', headers: browser(boss.cookie) })))).code).toBe('not_found');
    expect(fetchLog.length).toBe(1);
  });

  it('frees the sender id so the real owner can link it', async () => {
    const alice = await member('alice@example.com');
    const owner = await member('owner@example.com');
    const { key: adminKey } = await createApiKey('ops', 'admin', d1);
    await linkDirect(alice.userId, '777001', 'link_token');
    const res = await read(await adminUnlinkApi(ctx({ method: 'DELETE', headers: bearer(adminKey) })));
    expect(res.status).toBe(200);
    expect((await listActivity(d1, alice.userId))[0].detail).toEqual({ provider: 'telegram', external_id: '777001', by: 'admin' });
    expect((await auditRows()).map(r => [r.admin, r.reason])).toEqual([['admin_api_key', '']]);
    await linkDirect(owner.userId, '777001', 'link_token');
    expect(await linkedTo('777001')).toBe(owner.userId);
  });

  it('refuses non-admins, read-only keys and member keys, leaving the link in place', async () => {
    const alice = await member('alice@example.com');
    await linkDirect(alice.userId, '777001');
    const { key: readKey } = await createApiKey('viewer', 'read', d1);
    const { secret: userKey } = await createUserKey(d1, alice.userId, { name: 'k', scopes: ['account:read', 'account:write'], expires_in_days: 30 });

    expect((await read(await adminUnlinkApi(ctx({ method: 'DELETE' })))).status).toBe(401);
    for (const headers of [browser(alice.cookie), bearer(readKey), bearer(userKey)]) {
      expect((await read(await adminUnlinkApi(ctx({ method: 'DELETE', headers })))).status).toBe(403);
      expect((await read(await adminGetApi(ctx({ method: 'GET', headers })))).status).toBe(403);
    }
    expect(await linkedTo('777001')).toBe(alice.userId);
    expect(await listActivity(d1, alice.userId)).toEqual([]);
    expect(await auditRows()).toEqual([]);
    expect(fetchLog.length).toBe(0);
  });

  it('decodes percent-encoded sender ids in the path and rejects malformed encoding', async () => {
    const alice = await member('alice@example.com');
    const boss = await member('boss@example.com');
    const h = browser(boss.cookie);
    await linkDirect(alice.userId, '777:002');
    const encoded = { provider: 'telegram', externalId: '777%3A002' };
    const got = await read(await adminGetApi(ctx({ method: 'GET', headers: h, params: encoded })));
    expect(got.status).toBe(200);
    expect(field(got.data, 'external_id')).toBe('777:002');
    expect((await read(await adminUnlinkApi(ctx({ method: 'DELETE', headers: h, params: encoded })))).status).toBe(200);
    expect(await linkedTo('777:002')).toBeNull();
    for (const externalId of ['777%E0%A4%A', '%']) {
      const res = await read(await adminGetApi(ctx({ method: 'GET', headers: h, params: { provider: 'telegram', externalId } })));
      expect([res.status, res.code]).toEqual([400, 'invalid_field']);
    }
  });

  it('never shows the member the admin, the reason or the admin user agent', async () => {
    const alice = await member('alice@example.com');
    const boss = await member('boss@example.com');
    await linkDirect(alice.userId, '777001');
    const headers = { ...browser(boss.cookie), 'User-Agent': 'AdminBrowser/9.9' };
    expect((await read(await adminUnlinkApi(ctx({ method: 'DELETE', headers, rawBody: JSON.stringify({ reason: 'private note' }) })))).status).toBe(200);
    const [entry] = await listActivity(d1, alice.userId);
    expect(entry.user_agent).toBeNull();
    expect(JSON.stringify(entry)).not.toMatch(/boss@example\.com|private note|AdminBrowser/);
  });

  it('validates the path and body, and answers 503 without the database', async () => {
    const boss = await member('boss@example.com');
    const h = browser(boss.cookie);
    expect((await read(await adminUnlinkApi(ctx({ method: 'DELETE', headers: h, params: { provider: 'sms', externalId: '1' } })))).code).toBe('unsupported_channel');
    expect((await read(await adminUnlinkApi(ctx({ method: 'DELETE', headers: h, params: { provider: 'telegram', externalId: 'a b' } })))).code).toBe('invalid_field');
    expect((await read(await adminUnlinkApi(ctx({ method: 'DELETE', headers: h, rawBody: 'nope' })))).code).toBe('invalid_json');
    expect((await read(await adminUnlinkApi(ctx({ method: 'DELETE', headers: h, rawBody: JSON.stringify({ reason: 'x'.repeat(501) }) })))).code).toBe('invalid_field');
    expect((await read(await adminGetApi(ctx({ method: 'GET', env: pushEnv({ DB: undefined }) })))).code).toBe('database_unavailable');
  });

  it('still unlinks when dewee pushes are not configured', async () => {
    const alice = await member('alice@example.com');
    const boss = await member('boss@example.com');
    await linkDirect(alice.userId, '777001');
    const env = pushEnv({ DEWEE_GATEWAY_URL: undefined });
    expect((await read(await adminUnlinkApi(ctx({ method: 'DELETE', env, headers: browser(boss.cookie) })))).status).toBe(200);
    expect(await linkedTo('777001')).toBeNull();
    expect(fetchLog.length).toBe(0);
  });
});

describe('admin channel identity MCP tools', () => {
  it('looks up and unlinks with an admin key, recording activity and the dewee push', async () => {
    const alice = await member('alice@example.com');
    await linkDirect(alice.userId, '777001');
    const { key: adminKey } = await createApiKey('ops', 'admin', d1);

    const got = await mcpCall(bearer(adminKey), 'channel_identity_get', { provider: 'telegram', external_id: '777001' });
    expect(field(got.result, 'member', 'email')).toBe('alice@example.com');

    const done = await mcpCall(bearer(adminKey), 'channel_identity_unlink', { provider: 'telegram', external_id: '777001', reason: 'support request' });
    expect(field(done.result, 'unlinked')).toBe(true);
    expect(await linkedTo('777001')).toBeNull();
    const [entry] = await listActivity(d1, alice.userId);
    expect(entry.action).toBe('channel.unlinked');
    expect(entry.detail).toEqual({ provider: 'telegram', external_id: '777001', by: 'admin' });
    expect((await auditRows()).map(r => [r.admin, r.reason])).toEqual([['admin_api_key', 'support request']]);
    expect(fetchLog.map(f => JSON.parse(String(f.init?.body)))).toEqual([{ sender_id: '777001' }]);
  });

  it('refuses read-only keys, member keys and anonymous callers', async () => {
    const alice = await member('alice@example.com');
    await linkDirect(alice.userId, '777001');
    const { key: readKey } = await createApiKey('viewer', 'read', d1);
    const { secret: userKey } = await createUserKey(d1, alice.userId, { name: 'k', scopes: ['account:read'], expires_in_days: 30 });
    for (const headers of [{}, bearer(readKey), bearer(userKey)]) {
      for (const tool of ['channel_identity_get', 'channel_identity_unlink']) {
        const res = await mcpCall(headers, tool, { provider: 'telegram', external_id: '777001' });
        expect(res.result).toBeNull();
        expect(res.error).toBeDefined();
      }
    }
    expect(await linkedTo('777001')).toBe(alice.userId);
    expect(fetchLog.length).toBe(0);
  });
});
