import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createApiKey, createSession } from '../src/db/store';
import type { RuntimeEnv, ServiceBindingLike } from '../src/env';
import { createUserKey } from '../src/lib/members/api-keys';
import type { UserKeyScope } from '../src/lib/members/api-keys';
import { createMemberSession } from '../src/lib/members/session';
import { resolveStudioAccess } from '../src/lib/members/studio-access';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { allMcpTools } from '../src/lib/mcp/dispatch';
import { OPENAPI_FRAGMENTS } from '../src/lib/openapi/registry';
import { TOOL_ACCESS } from '../src/lib/oauth/tool-access';
import {
  OWNER_STATUS_TEXT_MAX, PRESENCE_INTERNAL_HEADER, PRESENCE_INTERNAL_LABEL, PRESENCE_INTERNAL_MAX_SKEW_MS, type OwnerStatusState,
} from '../src/lib/presence/contract';
import { isAllowedPresenceHttpTarget, parseOwnerStatusUpdate, presenceOwnerTransport } from '../src/lib/presence/presence-owner-client';
import { signPresenceInternal, verifyPresenceInternal } from '../src/lib/presence/internal-auth';
import { isOwnerStatusState, sanitizeOwnerStatusText } from '../src/lib/presence/presence-owner-status-guards';
import { hmacBase64Url } from '../src/lib/presence/ticket';
import { GET, PUT } from '../src/pages/api/v1/presence/owner';
import { POST as legacyMcpApi } from '../src/pages/api/mcp';
import { POST as mcpApi } from '../src/pages/mcp';

const ORIGIN = 'https://zuey.me';
const SECRET = 'test-presence-secret-0123456789';
const STATE: OwnerStatusState = {
  mode: 'auto',
  text: null,
  updatedAt: '2026-10-20T03:00:00.000Z',
  connected: false,
  public: { status: 'offline', onSite: false, since: '2026-10-20T03:00:00.000Z' },
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

interface WorkerCall { url: string; method: string; header: string | null; body: unknown }

/** In-memory stand-in for the presence Worker's `/internal/owner` (service binding Fetcher). */
class FakeWorker implements ServiceBindingLike {
  calls: WorkerCall[] = [];
  state: OwnerStatusState = { ...STATE };
  fail: 'throw' | 'status' | 'garbage' | null = null;

  async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const body: unknown = request.method === 'PUT' ? await request.json() : null;
    this.calls.push({ url: request.url, method: request.method, header: request.headers.get(PRESENCE_INTERNAL_HEADER), body });
    if (this.fail === 'throw') throw new Error('Worker down');
    if (this.fail === 'status') return new Response('oops', { status: 500 });
    if (this.fail === 'garbage') return Response.json({ mode: 'sleeping' });
    if (!(await verifyPresenceInternal(SECRET, request.headers.get(PRESENCE_INTERNAL_HEADER), request.method, new URL(request.url).pathname))) {
      return new Response('Not found', { status: 404 });
    }
    if (request.method === 'PUT' && isRecord(body) && (body.mode === 'auto' || body.mode === 'away' || body.mode === 'busy' || body.mode === 'offline' || body.mode === 'invisible')) {
      const text = typeof body.text === 'string' ? body.text : null;
      const hidden = body.mode === 'offline' || body.mode === 'invisible';
      const status = body.mode === 'away' || body.mode === 'busy' ? body.mode : 'offline';
      this.state = {
        ...this.state, mode: body.mode, text,
        public: { status, onSite: false, since: this.state.updatedAt, ...(text && !hidden ? { text } : {}) },
      };
    }
    return Response.json(this.state);
  }
}

const originalFetch = globalThis.fetch;

/** Replaces the global fetch (the HTTP transport) for one test; the Worker binding stays a FakeWorker. */
function stubFetch(handler: (input: Request | string, init?: RequestInit) => Promise<Response>): void {
  const fake = (input: RequestInfo | URL, init?: RequestInit) => handler(input instanceof URL ? input.href : input, init);
  Object.assign(globalThis, { fetch: fake });
}

function restoreFetch(): void {
  Object.assign(globalThis, { fetch: originalFetch });
}

let d1: ReturnType<typeof createTestD1>;
let worker: FakeWorker;
let envOverrides: Partial<RuntimeEnv>;
let ownerId: string;

function env(): RuntimeEnv {
  return {
    DB: d1, PUBLIC_SITE_URL: ORIGIN, ADMIN_EMAILS: 'boss@example.com', MEMBER_HASH_SALT: 'salt',
    PRESENCE_TICKET_SECRET: SECRET, PRESENCE_OWNER_MEMBER_IDS: `usr_someone_else, ${ownerId}`, PRESENCE: worker, ...envOverrides,
  };
}

async function member(email: string): Promise<{ userId: string; headers: Record<string, string> }> {
  const { user } = await findOrCreateVerifiedUser(d1, { email });
  const { token } = await createMemberSession(d1, user.id);
  return { userId: user.id, headers: { cookie: `zuey_member=${token}`, Origin: ORIGIN } };
}

async function userKey(userId: string, scopes: UserKeyScope[]): Promise<Record<string, string>> {
  const { secret } = await createUserKey(d1, userId, { name: 'k', scopes, expires_in_days: 30 });
  return { Authorization: `Bearer ${secret}` };
}

interface Result { status: number; code: string | null; data: Record<string, unknown>; res: Response }

async function call(method: 'GET' | 'PUT', headers: Record<string, string> = {}, body?: unknown): Promise<Result> {
  const init: RequestInit = { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const request = new Request(`${ORIGIN}/api/v1/presence/owner`, init);
  // Handlers only read request/locals; a full APIContext is not constructible in tests.
  const ctx = { request, locals: { runtime: { env: env() } } } as unknown as APIContext;
  const res = await (method === 'GET' ? GET(ctx) : PUT(ctx));
  const json: unknown = await res.clone().json();
  const error = isRecord(json) && isRecord(json.error) ? json.error : null;
  return {
    status: res.status,
    code: error && typeof error.code === 'string' ? error.code : null,
    data: isRecord(json) && isRecord(json.data) ? json.data : {},
    res,
  };
}

beforeEach(async () => {
  d1 = createTestD1();
  worker = new FakeWorker();
  envOverrides = {};
  ownerId = '';
  ownerId = (await member('duy@example.com')).userId;
});

afterEach(() => {
  envOverrides = {};
  restoreFetch();
});

async function ownerSession(): Promise<Record<string, string>> {
  const { token } = await createMemberSession(d1, ownerId);
  return { cookie: `zuey_member=${token}`, Origin: ORIGIN };
}

describe('owner identity (auth matrix)', () => {
  it('lets the owner session read and set the status, with no-store', async () => {
    const headers = await ownerSession();
    const read = await call('GET', headers);
    expect(read.status).toBe(200);
    expect(read.res.headers.get('Cache-Control')).toBe('no-store');
    expect(read.data.mode).toBe('auto');

    const set = await call('PUT', headers, { mode: 'busy', text: '  Recording\na\u0007 podcast  ' });
    expect(set.status).toBe(200);
    expect(set.data.mode).toBe('busy');
    expect(set.data.text).toBe('Recording a podcast');
    expect(worker.calls.at(-1)?.body).toEqual({ mode: 'busy', text: 'Recording a podcast' });
  });

  it('rejects anonymous callers and forged credentials with 401', async () => {
    expect((await call('GET')).status).toBe(401);
    expect((await call('GET')).code).toBe('unauthorized');
    expect((await call('PUT', {}, { mode: 'away' })).status).toBe(401);
    expect((await call('GET', { cookie: 'zuey_member=zm_forged_token_value', Origin: ORIGIN })).status).toBe(401);
    expect((await call('GET', { cookie: 'zuey_session=zuey_sess_forged' })).status).toBe(401);
    const badKey = await call('GET', { Authorization: 'Bearer zk_not_a_real_key' });
    expect(badKey.status).toBe(401);
    expect(worker.calls).toHaveLength(0);
  });

  it('refuses members, non-owner admins, Studio sessions and Studio keys with 403 not_owner', async () => {
    const lan = await member('lan@example.com');
    const boss = await member('boss@example.com'); // verified ADMIN_EMAILS admin, not an owner
    const studio = await createSession('owner@zuey.me', d1);
    const adminKey = (await createApiKey('ops', 'admin', d1)).key;
    const readKey = (await createApiKey('viewer', 'read', d1)).key;

    for (const headers of [lan.headers, boss.headers, { cookie: `zuey_session=${studio}` }, { Authorization: `Bearer ${adminKey}` }]) {
      const r = await call('GET', headers);
      expect(r.status).toBe(403);
      expect(r.code).toBe('not_owner');
    }
    const bossPut = await call('PUT', boss.headers, { mode: 'away' });
    expect([bossPut.status, bossPut.code]).toEqual([403, 'not_owner']);
    // A read-only key can never mutate.
    const readPut = await call('PUT', { Authorization: `Bearer ${readKey}` }, { mode: 'away' });
    expect(readPut.status).toBe(403);
    expect(worker.calls).toHaveLength(0);
  });

  it('treats an owner who is also an admin as the owner because of the member id, not the role', async () => {
    envOverrides = { ADMIN_EMAILS: 'duy@example.com' };
    expect((await call('GET', await ownerSession())).status).toBe(200);
    envOverrides = { PRESENCE_OWNER_MEMBER_IDS: '' , ADMIN_EMAILS: 'duy@example.com' };
    expect((await call('GET', await ownerSession())).code).toBe('not_owner');
  });

  it('accepts owner keys only within their scopes; read-only keys cannot set', async () => {
    const readOnly = await userKey(ownerId, ['account:read']);
    expect((await call('GET', readOnly)).status).toBe(200);
    const denied = await call('PUT', readOnly, { mode: 'away' });
    expect([denied.status, denied.code]).toEqual([403, 'insufficient_scope']);

    const writer = await userKey(ownerId, ['account:read', 'account:write']);
    expect((await call('PUT', writer, { mode: 'away' })).status).toBe(200);
    const noAccount = await userKey(ownerId, ['articles:read']);
    expect((await call('GET', noAccount)).code).toBe('insufficient_scope');

    const lan = await member('lan@example.com');
    expect((await call('PUT', await userKey(lan.userId, ['account:write']), { mode: 'away' })).code).toBe('not_owner');
  });

  it('rejects cross-site cookie writes', async () => {
    const headers = { ...(await ownerSession()), Origin: 'https://evil.example' };
    const r = await call('PUT', headers, { mode: 'away' });
    expect(r.status).toBe(403);
    expect(worker.calls).toHaveLength(0);
  });

  it('flags the owner for Studio only when the admin is also the owner', async () => {
    const page = (cookie: string) => new Request(`${ORIGIN}/studio`, { headers: { cookie } });
    envOverrides = { ADMIN_EMAILS: 'duy@example.com,boss@example.com' };
    const owner = await ownerSession();
    expect((await resolveStudioAccess(page(owner.cookie), env())).presenceOwner).toBe(true);
    const boss = await member('boss@example.com');
    const bossAccess = await resolveStudioAccess(page(boss.headers.cookie), env());
    expect(bossAccess.authenticated).toBe(true);
    expect(bossAccess.presenceOwner).toBe(false);
  });
});

describe('owner status validation', () => {
  it('answers 400 for bad bodies before calling the Worker', async () => {
    const headers = await ownerSession();
    expect((await call('PUT', headers, { mode: 'sleeping' })).code).toBe('invalid_mode');
    expect((await call('PUT', headers, {})).code).toBe('invalid_mode');
    expect((await call('PUT', headers, { mode: 'away', text: 42 })).code).toBe('invalid_text');
    expect((await call('PUT', headers, { mode: 'away', text: 'x'.repeat(OWNER_STATUS_TEXT_MAX + 1) })).code).toBe('text_too_long');
    expect((await call('PUT', headers, '[1,2]')).code).toBe('invalid_json');
    expect((await call('PUT', headers, 'not json')).status).toBe(400);
    expect(worker.calls).toHaveLength(0);
  });

  it('sanitizes text and treats empty or null text as clearing it', () => {
    expect(sanitizeOwnerStatusText('\u202Eev\u0000il\ttext\r\n')).toBe('evil text');
    expect(sanitizeOwnerStatusText('a\r\nb')).toBe('a b');
    expect(parseOwnerStatusUpdate({ mode: 'away', text: '   ' })).toEqual({ mode: 'away' });
    expect(parseOwnerStatusUpdate({ mode: 'invisible', text: null })).toEqual({ mode: 'invisible' });
    expect(parseOwnerStatusUpdate({ mode: 'auto', text: `${'y'.repeat(OWNER_STATUS_TEXT_MAX)}   ` }).text).toHaveLength(OWNER_STATUS_TEXT_MAX);
  });
});

describe('presence Worker client', () => {
  it('sends a fresh time-bound internal header that only verifies within the skew window', async () => {
    const before = Math.floor(Date.now() / 1000);
    await call('GET', await ownerSession());
    const header = worker.calls[0]?.header ?? '';
    const [ts, sig] = header.split('.');
    expect(Number(ts)).toBeGreaterThanOrEqual(before);
    expect(sig).toBe(await hmacBase64Url(SECRET, `${PRESENCE_INTERNAL_LABEL}:GET:/internal/owner:${ts}`));
    expect(worker.calls[0]?.url).toBe('https://presence.zuey.me/internal/owner');

    const now = Date.now();
    const M = 'PUT';
    const P = '/internal/owner';
    const valid = await signPresenceInternal(SECRET, M, P, now);
    expect(await verifyPresenceInternal(SECRET, valid, M, P, now)).toBe(true);
    expect(await verifyPresenceInternal(SECRET, valid, 'put', P, now)).toBe(true); // method is case-insensitive
    expect(await verifyPresenceInternal(SECRET, valid, 'GET', P, now)).toBe(false); // another method
    expect(await verifyPresenceInternal(SECRET, valid, M, '/internal/diagnostics', now)).toBe(false); // another path
    expect(await verifyPresenceInternal(SECRET, valid, M, P, now + PRESENCE_INTERNAL_MAX_SKEW_MS + 1_000)).toBe(false); // stale
    expect(await verifyPresenceInternal(SECRET, `0${valid}`, M, P, now)).toBe(false); // non-canonical timestamp
    expect(await verifyPresenceInternal(SECRET, await signPresenceInternal(SECRET, M, P, now + PRESENCE_INTERNAL_MAX_SKEW_MS + 1_000), M, P, now)).toBe(false); // future
    expect(await verifyPresenceInternal('other-secret', valid, M, P, now)).toBe(false);
    for (const bad of [null, '', 'abc', `${valid}x`, `x${valid}`, valid.replace('.', ':'), await hmacBase64Url(SECRET, PRESENCE_INTERNAL_LABEL)]) {
      expect(await verifyPresenceInternal(SECRET, bad, M, P, now)).toBe(false);
    }
  });

  it('uses only the binding when bound: a binding failure is a 503 and never retried over HTTP', async () => {
    expect(presenceOwnerTransport(env()).kind).toBe('binding');
    let httpCalls = 0;
    stubFetch(async () => { httpCalls++; return Response.json(STATE); });
    for (const fail of ['throw', 'status', 'garbage'] as const) {
      worker.fail = fail;
      const r = await call('GET', await ownerSession());
      expect([r.status, r.code]).toEqual([503, 'presence_unavailable']);
      expect(r.res.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(httpCalls).toBe(0);
  });

  it('uses HTTP only without a binding, and only to https or loopback http', async () => {
    expect(isAllowedPresenceHttpTarget(new URL('https://presence.zuey.me'))).toBe(true);
    for (const host of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
      expect(isAllowedPresenceHttpTarget(new URL(host))).toBe(true);
    }
    for (const host of ['http://presence.zuey.me', 'http://10.0.0.5', 'http://localhost.evil.example', 'ftp://localhost']) {
      expect(isAllowedPresenceHttpTarget(new URL(host))).toBe(false);
    }

    const http = new FakeWorker();
    const seen: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    stubFetch((input, init) => {
      seen.push({ url: typeof input === 'string' ? input : input.url, redirect: init?.redirect });
      return http.fetch(input, init);
    });
    envOverrides = { PRESENCE: undefined, PUBLIC_PRESENCE_URL: 'http://localhost:8787/' };
    expect(presenceOwnerTransport(env()).kind).toBe('http');
    expect((await call('GET', await ownerSession())).status).toBe(200);
    expect(seen).toEqual([{ url: 'http://localhost:8787/internal/owner', redirect: 'manual' }]);

    // Plain http to a non-loopback host is refused before anything is sent (the header never leaves).
    envOverrides = { PRESENCE: undefined, PUBLIC_PRESENCE_URL: 'http://presence.zuey.me' };
    expect((await call('PUT', await ownerSession(), { mode: 'away' })).code).toBe('presence_unavailable');
    envOverrides = { PRESENCE: undefined, PUBLIC_PRESENCE_URL: 'ftp://nope' };
    expect((await call('GET', await ownerSession())).code).toBe('presence_unavailable');
    expect(seen).toHaveLength(1);
  });

  it('treats a redirect from the Worker as a failure, never following it', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      return new Response(null, { status: 302, headers: { Location: 'https://evil.example/collect' } });
    });
    envOverrides = { PRESENCE: undefined };
    const r = await call('GET', await ownerSession());
    expect([r.status, r.code]).toEqual([503, 'presence_unavailable']);
    expect(calls).toBe(1);
  });

  it('answers 503 without the ticket secret', async () => {
    envOverrides = { PRESENCE_TICKET_SECRET: undefined };
    expect((await call('PUT', await ownerSession(), { mode: 'away' })).code).toBe('presence_unavailable');
    expect(worker.calls).toHaveLength(0);
  });

  it('validates the Worker owner view strictly', () => {
    expect(isOwnerStatusState(STATE)).toBe(true);
    expect(isOwnerStatusState({ ...STATE, mode: 'gone' })).toBe(false);
    expect(isOwnerStatusState({ ...STATE, text: 'x'.repeat(OWNER_STATUS_TEXT_MAX + 1) })).toBe(false);
    expect(isOwnerStatusState({ ...STATE, public: { status: 'invisible', onSite: false, since: STATE.updatedAt } })).toBe(false);
  });
});

describe('owner presence MCP tools', () => {
  async function legacy(method: string, params: Record<string, unknown>, headers: Record<string, string>): Promise<unknown> {
    const request = new Request(`${ORIGIN}/api/mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const res = await legacyMcpApi({ request, locals: { runtime: { env: env() } } } as unknown as APIContext);
    return res.json();
  }

  async function names(headers: Record<string, string>): Promise<string[]> {
    const body = await legacy('tools/list', {}, headers);
    const tools = isRecord(body) && isRecord(body.result) && Array.isArray(body.result.tools) ? body.result.tools : [];
    return tools.map(t => (isRecord(t) ? String(t.name) : ''));
  }

  async function bearerNames(headers: Record<string, string>): Promise<string[]> {
    const request = new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const body: unknown = await (await mcpApi({ request, locals: { runtime: { env: env() } } } as unknown as APIContext)).json();
    const tools = isRecord(body) && isRecord(body.result) && Array.isArray(body.result.tools) ? body.result.tools : [];
    return tools.map(t => (isRecord(t) ? String(t.name) : ''));
  }

  it('lists the tools only for the owner, within scope', async () => {
    expect(TOOL_ACCESS.presence_status_get).toEqual({ kind: 'owner', scope: 'account:read' });
    expect(TOOL_ACCESS.presence_status_set).toEqual({ kind: 'owner', scope: 'account:write' });
    expect(allMcpTools().filter(t => t.name.startsWith('presence_')).map(t => t.name)).toEqual(['presence_status_get', 'presence_status_set']);

    const full = await userKey(ownerId, ['account:read', 'account:write']);
    expect(await names(full)).toEqual(expect.arrayContaining(['presence_status_get', 'presence_status_set']));
    expect(await bearerNames(full)).toEqual(expect.arrayContaining(['presence_status_get', 'presence_status_set']));
    const readOnly = await bearerNames(await userKey(ownerId, ['account:read']));
    expect(readOnly).toContain('presence_status_get');
    expect(readOnly).not.toContain('presence_status_set');

    const adminKey = (await createApiKey('ops', 'admin', d1)).key;
    const boss = await member('boss@example.com');
    const lan = await member('lan@example.com');
    for (const headers of [{ Authorization: `Bearer ${adminKey}` }, boss.headers, lan.headers, await userKey(lan.userId, ['account:read', 'account:write']), {}]) {
      expect((await names(headers)).some(n => n.startsWith('presence_'))).toBe(false);
    }
    expect((await bearerNames({ Authorization: `Bearer ${adminKey}` })).some(n => n.startsWith('presence_'))).toBe(false);
  });

  it('re-checks the owner and scope on every call', async () => {
    const adminKey = (await createApiKey('ops', 'admin', d1)).key;
    const asAdmin = await legacy('tools/call', { name: 'presence_status_get', arguments: {} }, { Authorization: `Bearer ${adminKey}` });
    expect(isRecord(asAdmin) && isRecord(asAdmin.error) && isRecord(asAdmin.error.data) ? asAdmin.error.data.code : null).toBe('not_owner');

    const readOnly = await userKey(ownerId, ['account:read']);
    const denied = await legacy('tools/call', { name: 'presence_status_set', arguments: { mode: 'away' } }, readOnly);
    expect(isRecord(denied) && isRecord(denied.error) && isRecord(denied.error.data) ? denied.error.data.code : null).toBe('insufficient_scope');

    const full = await userKey(ownerId, ['account:read', 'account:write']);
    const ok = await legacy('tools/call', { name: 'presence_status_set', arguments: { mode: 'busy', text: 'Deep work' } }, full);
    const text = isRecord(ok) && isRecord(ok.result) && Array.isArray(ok.result.content) && isRecord(ok.result.content[0]) ? ok.result.content[0].text : null;
    expect(typeof text === 'string' ? JSON.parse(text) : null).toMatchObject({ mode: 'busy', text: 'Deep work' });
    expect(worker.calls.filter(c => c.method === 'PUT')).toHaveLength(1);
  });
});

describe('owner presence OpenAPI', () => {
  it('documents GET and PUT /api/v1/presence/owner', () => {
    const fragment = OPENAPI_FRAGMENTS.find(f => f.paths['/api/v1/presence/owner']);
    expect(fragment).toBeDefined();
    expect(Object.keys(fragment?.paths['/api/v1/presence/owner'] ?? {}).sort()).toEqual(['get', 'put']);
    expect(fragment?.schemas.PresenceOwnerStatus).toBeDefined();
  });
});
