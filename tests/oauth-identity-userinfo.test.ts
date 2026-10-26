import { beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import type { RuntimeEnv } from '../src/env';
import { isForbiddenCrossSiteSubmission } from '../src/lib/csrf-origin-check';
import { membersRuntime } from '../src/lib/members/runtime';
import { createMemberSession } from '../src/lib/members/session';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { OPENAPI_FRAGMENTS } from '../src/lib/openapi/registry';
import { loadConsent, startAuthorization } from '../src/lib/oauth/authorize';
import { ACCESS_TOKEN_TTL_MS } from '../src/lib/oauth/config';
import { scopeLabel } from '../src/lib/oauth/scope-copy';
import { pkceChallenge } from '../src/lib/oauth/tokens';
import { GET as asMetadataApi } from '../src/pages/.well-known/oauth-authorization-server';
import { GET as prmMcpApi } from '../src/pages/.well-known/oauth-protected-resource/mcp';
import { POST as registerApi } from '../src/pages/oauth/register';
import { POST as consentApi } from '../src/pages/oauth/consent';
import { POST as tokenApi } from '../src/pages/oauth/token';
import { POST as revokeApi } from '../src/pages/oauth/revoke';
import { GET as connectionsApi } from '../src/pages/oauth/connections/index';
import { GET as userinfoGet, POST as userinfoPost } from '../src/pages/oauth/userinfo';
import { POST as mcpApi } from '../src/pages/mcp';
import { POST as legacyMcpApi } from '../src/pages/api/mcp';
import { GET as meApi } from '../src/pages/api/v1/me/index';

const T0 = Date.parse('2026-10-26T00:00:00.000Z');
const ORIGIN = 'https://zuey.test';
const MCP_URL = `${ORIGIN}/mcp`;
const USERINFO_URL = `${ORIGIN}/oauth/userinfo`;
const LOOPBACK_REDIRECT = 'http://localhost:4321/auth/zuey/callback';
const UNLOCK_CLIENT_ID = 'https://unlock.zuey.me/oauth/zuey-client.json';
const UNLOCK_REDIRECT = 'https://unlock.zuey.me/auth/zuey/callback';

type TestDb = ReturnType<typeof createTestD1>;
let d1: TestDb;
let now: number;
let fetchHandler: (url: string) => Response;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function get(v: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = v;
  for (const k of path) {
    if (typeof k === 'number') cur = Array.isArray(cur) ? cur[k] : undefined;
    else cur = isRecord(cur) ? cur[k] : undefined;
  }
  return cur;
}

const env = (): RuntimeEnv => ({ DB: d1, PUBLIC_SITE_URL: ORIGIN, MEMBER_HASH_SALT: 'salt', ADMIN_EMAILS: 'boss@example.com' });

interface CtxOpts {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string | string[]>;
}

function ctx(opts: CtxOpts): APIContext {
  const headers = new Headers(opts.headers ?? {});
  let reqBody: string | undefined;
  if (opts.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    reqBody = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers.set('Content-Type', 'application/x-www-form-urlencoded');
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.form)) for (const one of Array.isArray(v) ? v : [v]) sp.append(k, one);
    reqBody = sp.toString();
  }
  const request = new Request(opts.url ?? `${ORIGIN}/`, { method: opts.method ?? (reqBody === undefined ? 'GET' : 'POST'), headers, body: reqBody });
  // Handlers only read request/params/locals; a full APIContext is not constructible in tests.
  const partial = { request, params: {}, url: new URL(request.url), locals: { runtime: { env: env() } } };
  return partial as unknown as APIContext;
}

async function body(res: Response): Promise<unknown> {
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function member(email: string, profile: { name?: string; avatar?: string; locale?: string } = {}): Promise<{ userId: string; cookie: string }> {
  const { user } = await findOrCreateVerifiedUser(d1, { email });
  await d1.prepare('UPDATE users SET name = ?, avatar_url = ?, locale = ? WHERE id = ?')
    .bind(profile.name ?? null, profile.avatar ?? null, profile.locale ?? 'vi', user.id).run();
  const { token } = await createMemberSession(d1, user.id);
  return { userId: user.id, cookie: `zuey_member=${token}` };
}

function randomVerifier(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

/** Local-dev style client: DCR with the unlock app's loopback callback. */
async function registerLoopbackClient(): Promise<string> {
  const res = await registerApi(ctx({
    url: `${ORIGIN}/oauth/register`,
    json: { client_name: 'Unlock (dev)', redirect_uris: [LOOPBACK_REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] },
    headers: { 'cf-connecting-ip': '198.51.100.9' },
  }));
  expect(res.status).toBe(201);
  return String(get(await body(res), 'client_id'));
}

type Start = Awaited<ReturnType<typeof startAuthorization>>;

async function start(params: { clientId: string; redirectUri: string; verifier: string; scope: string; resource?: string }): Promise<Start> {
  const q: Record<string, string> = {
    response_type: 'code', client_id: params.clientId, redirect_uri: params.redirectUri, scope: params.scope,
    code_challenge: await pkceChallenge(params.verifier), code_challenge_method: 'S256', state: 'st-1',
  };
  if (params.resource !== undefined) q.resource = params.resource;
  return startAuthorization(d1, new Request(`${ORIGIN}/oauth/authorize?${new URLSearchParams(q).toString()}`));
}

/** authorize -> consent (approving `approve` or every requested scope) -> token exchange. */
async function signIn(opts: {
  cookie: string; scope: string; resource?: string; approve?: string[]; clientId?: string; redirectUri?: string;
}): Promise<{ access: string; refresh: string; scope: string; clientId: string }> {
  const clientId = opts.clientId ?? await registerLoopbackClient();
  const redirectUri = opts.redirectUri ?? LOOPBACK_REDIRECT;
  const verifier = randomVerifier();
  const started = await start({ clientId, redirectUri, verifier, scope: opts.scope, resource: opts.resource });
  if (started.kind !== 'redirect') throw new Error(`authorize failed: ${started.kind === 'error' ? started.message : ''}`);
  const requestId = new URL(started.location, ORIGIN).searchParams.get('request_id') ?? '';
  const consent = await loadConsent(d1, env(), new Request(`${ORIGIN}${started.location}`, { headers: { cookie: opts.cookie } }), requestId);
  if (consent.kind !== 'consent') throw new Error(`consent not shown: ${consent.kind}`);
  const approve = opts.approve ?? consent.view.scopes.filter(s => s.requested).map(s => s.scope);
  const decided = await consentApi(ctx({
    url: `${ORIGIN}/oauth/consent`, form: { request_id: requestId, decision: 'approve', scope: approve }, headers: { cookie: opts.cookie, Origin: ORIGIN },
  }));
  const code = new URL(decided.headers.get('Location') ?? '').searchParams.get('code') ?? '';
  const form: Record<string, string> = { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, client_id: clientId };
  if (opts.resource !== undefined) form.resource = opts.resource;
  const tok = await tokenApi(ctx({ url: `${ORIGIN}/oauth/token`, form }));
  const tb = await body(tok);
  expect(tok.status).toBe(200);
  return { access: String(get(tb, 'access_token')), refresh: String(get(tb, 'refresh_token')), scope: String(get(tb, 'scope')), clientId };
}

async function userinfo(token: string | null, method: 'GET' | 'POST' = 'GET'): Promise<{ status: number; body: unknown; res: Response }> {
  const headers: Record<string, string> = token === null ? {} : { Authorization: `Bearer ${token}` };
  const handler = method === 'GET' ? userinfoGet : userinfoPost;
  const res = await handler(ctx({ url: USERINFO_URL, method, headers }));
  return { status: res.status, body: await body(res.clone()), res };
}

async function mcpStatus(token: string, method = 'tools/list'): Promise<number> {
  const res = await mcpApi(ctx({
    url: MCP_URL, headers: { Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2025-06-18' },
    json: { jsonrpc: '2.0', id: 1, method, params: {} },
  }));
  return res.status;
}

beforeEach(() => {
  d1 = createTestD1();
  now = T0;
  fetchHandler = () => new Response('not found', { status: 404 });
  membersRuntime.now = () => now;
  membersRuntime.fetch = async (input: string) => fetchHandler(input);
});

describe('identity discovery', () => {
  it('lists the identity scopes and the userinfo endpoint in authorization server metadata', async () => {
    const as = await body(await asMetadataApi(ctx({ url: `${ORIGIN}/.well-known/oauth-authorization-server` })));
    expect(get(as, 'userinfo_endpoint')).toBe(USERINFO_URL);
    expect(get(as, 'scopes_supported')).toEqual(expect.arrayContaining(['openid', 'profile', 'email', 'articles:read', 'admin']));
    // The MCP protected resource does not advertise identity scopes: they open nothing there.
    const prm = get(await body(await prmMcpApi(ctx({ url: `${ORIGIN}/.well-known/oauth-protected-resource/mcp` }))), 'scopes_supported');
    expect(Array.isArray(prm) && prm.includes('openid')).toBe(false);
  });

  it('documents userinfo in OpenAPI and treats it as a cookie-free machine endpoint', () => {
    const paths = Object.assign({}, ...OPENAPI_FRAGMENTS.map(f => f.paths));
    expect(paths['/oauth/userinfo']).toBeDefined();
    const req = new Request(USERINFO_URL, { method: 'POST', headers: { Authorization: 'Bearer zoa_x' } });
    expect(isForbiddenCrossSiteSubmission(req, new URL(req.url))).toBe(false);
  });

  it('has Vietnamese consent copy for the identity scopes', () => {
    expect(scopeLabel('openid')).toBe('Xác nhận bạn là ai trên zuey.me');
    expect(scopeLabel('profile')).toBe('Xem tên hiển thị, ảnh đại diện và ngôn ngữ');
    expect(scopeLabel('email')).toBe('Xem địa chỉ email đã xác minh');
  });
});

describe('identity-only authorization', () => {
  it('binds a sign-in request to the userinfo audience whether resource is omitted or explicit', async () => {
    const m = await member('lan@example.com');
    const clientId = await registerLoopbackClient();
    for (const resource of [undefined, USERINFO_URL]) {
      const started = await start({ clientId, redirectUri: LOOPBACK_REDIRECT, verifier: randomVerifier(), scope: 'openid profile email', resource });
      expect(started.kind).toBe('redirect');
      const requestId = started.kind === 'redirect' ? new URL(started.location, ORIGIN).searchParams.get('request_id') ?? '' : '';
      const consent = await loadConsent(d1, env(), new Request(`${ORIGIN}/oauth/authorize?request_id=${requestId}`, { headers: { cookie: m.cookie } }), requestId);
      expect(consent.kind === 'consent' ? consent.view.resource : null).toBe(USERINFO_URL);
    }
  });

  it('refuses an identity-only request aimed at /mcp and a member request aimed at userinfo', async () => {
    const clientId = await registerLoopbackClient();
    for (const [scope, resource] of [['openid email', MCP_URL], ['openid articles:read', USERINFO_URL]]) {
      const started = await start({ clientId, redirectUri: LOOPBACK_REDIRECT, verifier: randomVerifier(), scope, resource });
      expect(started.kind).toBe('redirect');
      const loc = new URL(started.kind === 'redirect' ? started.location : '', ORIGIN);
      expect(loc.searchParams.get('error')).toBe('invalid_target');
    }
  });

  it('never offers admin on a sign-in request, even to an admin', async () => {
    const boss = await member('boss@example.com');
    const clientId = await registerLoopbackClient();
    const started = await start({ clientId, redirectUri: LOOPBACK_REDIRECT, verifier: randomVerifier(), scope: 'openid email' });
    const requestId = started.kind === 'redirect' ? new URL(started.location, ORIGIN).searchParams.get('request_id') ?? '' : '';
    const consent = await loadConsent(d1, env(), new Request(`${ORIGIN}/oauth/authorize?request_id=${requestId}`, { headers: { cookie: boss.cookie } }), requestId);
    expect(consent.kind === 'consent' ? consent.view.scopes.map(s => s.scope) : []).toEqual(['openid', 'email']);
  });
});

describe('/oauth/userinfo', () => {
  it('returns claims filtered by scope', async () => {
    const m = await member('lan@example.com', { name: 'Lan', avatar: 'https://cdn.example.com/lan.png', locale: 'en' });

    const openidOnly = await signIn({ cookie: m.cookie, scope: 'openid' });
    expect(openidOnly.scope).toBe('openid');
    expect((await userinfo(openidOnly.access)).body).toEqual({ sub: m.userId });

    const withEmail = await signIn({ cookie: m.cookie, scope: 'openid email' });
    expect((await userinfo(withEmail.access)).body).toEqual({ sub: m.userId, email: 'lan@example.com', email_verified: true });

    const full = await signIn({ cookie: m.cookie, scope: 'openid profile email' });
    const r = await userinfo(full.access);
    expect(r.status).toBe(200);
    expect(r.res.headers.get('Cache-Control')).toBe('no-store');
    expect(r.body).toEqual({
      sub: m.userId, email: 'lan@example.com', email_verified: true, name: 'Lan', picture: 'https://cdn.example.com/lan.png', locale: 'en',
    });
    // POST answers the same, and the refreshed token keeps the identity grant.
    expect((await userinfo(full.access, 'POST')).body).toEqual(r.body);
    const refreshed = await tokenApi(ctx({ url: `${ORIGIN}/oauth/token`, form: { grant_type: 'refresh_token', refresh_token: full.refresh, client_id: full.clientId } }));
    expect(refreshed.status).toBe(200);
    expect((await userinfo(String(get(await body(refreshed), 'access_token')))).body).toEqual(r.body);
  });

  it('reports a missing profile as nulls', async () => {
    const m = await member('bare@example.com');
    const t = await signIn({ cookie: m.cookie, scope: 'openid profile' });
    expect((await userinfo(t.access)).body).toEqual({ sub: m.userId, name: null, picture: null, locale: 'vi' });
  });

  it('answers 401 invalid_token for missing, unknown, expired and revoked tokens and deleted members', async () => {
    const expectInvalid = async (token: string | null): Promise<void> => {
      const r = await userinfo(token);
      expect(r.status).toBe(401);
      expect(get(r.body, 'error')).toBe('invalid_token');
      expect(r.res.headers.get('WWW-Authenticate') ?? '').toStartWith('Bearer error="invalid_token"');
    };
    await expectInvalid(null);
    await expectInvalid('zoa_unknown');
    await expectInvalid('zk_not_an_oauth_token');

    const m = await member('lan@example.com');
    const revoked = await signIn({ cookie: m.cookie, scope: 'openid email' });
    const rv = await revokeApi(ctx({ url: `${ORIGIN}/oauth/revoke`, form: { token: revoked.access, client_id: revoked.clientId } }));
    expect(rv.status).toBe(200);
    await expectInvalid(revoked.access);

    const expiring = await signIn({ cookie: m.cookie, scope: 'openid' });
    now = T0 + ACCESS_TOKEN_TTL_MS + 1;
    await expectInvalid(expiring.access);
    now = T0;

    const live = await signIn({ cookie: m.cookie, scope: 'openid' });
    expect((await userinfo(live.access)).status).toBe(200);
    await d1.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(new Date(T0).toISOString(), m.userId).run();
    await expectInvalid(live.access);
  });

  it('answers 403 insufficient_scope for a token without openid', async () => {
    const m = await member('lan@example.com');
    const t = await signIn({ cookie: m.cookie, scope: 'articles:read', resource: MCP_URL });
    const r = await userinfo(t.access);
    expect(r.status).toBe(403);
    expect(get(r.body, 'error')).toBe('insufficient_scope');
    expect(r.res.headers.get('WWW-Authenticate') ?? '').toContain('error="insufficient_scope"');
  });

  it('accepts an MCP token that was also granted openid, and /mcp keeps working with it', async () => {
    const m = await member('lan@example.com');
    const t = await signIn({ cookie: m.cookie, scope: 'openid email articles:read', resource: MCP_URL });
    expect(t.scope).toBe('articles:read openid email');
    expect((await userinfo(t.access)).body).toEqual({ sub: m.userId, email: 'lan@example.com', email_verified: true });
    expect(await mcpStatus(t.access)).toBe(200);
  });
});

describe('identity tokens never open MCP or the REST API', () => {
  it('rejects an identity-only token at /mcp, /api/mcp and REST bearer auth', async () => {
    const m = await member('lan@example.com');
    const t = await signIn({ cookie: m.cookie, scope: 'openid profile email' });
    expect((await userinfo(t.access)).status).toBe(200);

    expect(await mcpStatus(t.access)).toBe(401);
    expect(await mcpStatus(t.access, 'tools/call')).toBe(401);

    const legacy = await legacyMcpApi(ctx({
      url: `${ORIGIN}/api/mcp`, headers: { Authorization: `Bearer ${t.access}` },
      json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'me_get', arguments: {} } },
    }));
    expect(legacy.status).toBe(401);

    const rest = await meApi(ctx({ url: `${ORIGIN}/api/v1/me`, headers: { Authorization: `Bearer ${t.access}` } }));
    expect(rest.status).toBe(401);
  });

  it('rejects at /mcp an MCP-bound token whose member unticked every MCP scope', async () => {
    const m = await member('lan@example.com');
    const t = await signIn({ cookie: m.cookie, scope: 'openid articles:read', resource: MCP_URL, approve: ['openid'] });
    expect(t.scope).toBe('openid');
    expect(await mcpStatus(t.access)).toBe(401);
    expect((await userinfo(t.access)).status).toBe(200);
  });
});

describe('unlock.zuey.me clients', () => {
  it('signs in through the Client ID Metadata Document and lists the grant under connected apps', async () => {
    let fetches = 0;
    fetchHandler = (url) => {
      fetches++;
      return url === UNLOCK_CLIENT_ID
        ? new Response(JSON.stringify({
          client_id: UNLOCK_CLIENT_ID, client_name: 'Zuey Unlock', client_uri: 'https://unlock.zuey.me',
          redirect_uris: [UNLOCK_REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
        }), { headers: { 'Content-Type': 'application/json' } })
        : new Response('not found', { status: 404 });
    };
    const m = await member('lan@example.com');
    const t = await signIn({ cookie: m.cookie, scope: 'openid profile email', clientId: UNLOCK_CLIENT_ID, redirectUri: UNLOCK_REDIRECT });
    expect(fetches).toBeGreaterThan(0);
    expect(t.refresh.startsWith('zor_')).toBe(true);
    expect(get((await userinfo(t.access)).body, 'email')).toBe('lan@example.com');

    const apps = await body(await connectionsApi(ctx({ url: `${ORIGIN}/oauth/connections`, headers: { cookie: m.cookie, Origin: ORIGIN } })));
    expect(get(apps, 'data', 0, 'client_name')).toBe('Zuey Unlock');
    expect(get(apps, 'data', 0, 'registration')).toBe('cimd');
    expect(get(apps, 'data', 0, 'scopes')).toEqual(['openid', 'profile', 'email']);

    // A redirect URI the document does not list never receives a code.
    const bad = await start({ clientId: UNLOCK_CLIENT_ID, redirectUri: 'https://evil.example/cb', verifier: randomVerifier(), scope: 'openid' });
    expect(bad.kind).toBe('error');
  });
});
