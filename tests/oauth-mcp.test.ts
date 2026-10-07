import { beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createApiKey } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { jsonError, withRequestId } from '../src/lib/http';
import { createUserKey } from '../src/lib/members/api-keys';
import { membersRuntime } from '../src/lib/members/runtime';
import { createMemberSession } from '../src/lib/members/session';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { allMcpTools } from '../src/lib/mcp/dispatch';
import { OPENAPI_FRAGMENTS } from '../src/lib/openapi/registry';
import { loadConsent, startAuthorization } from '../src/lib/oauth/authorize';
import { pkceChallenge } from '../src/lib/oauth/tokens';
import { TOOL_ACCESS } from '../src/lib/oauth/tool-access';
import { GET as asMetadataApi } from '../src/pages/.well-known/oauth-authorization-server';
import { GET as prmRootApi } from '../src/pages/.well-known/oauth-protected-resource';
import { GET as prmMcpApi } from '../src/pages/.well-known/oauth-protected-resource/mcp';
import { POST as registerApi } from '../src/pages/oauth/register';
import { POST as consentApi } from '../src/pages/oauth/consent';
import { POST as tokenApi } from '../src/pages/oauth/token';
import { POST as revokeApi } from '../src/pages/oauth/revoke';
import { GET as connectionsApi } from '../src/pages/oauth/connections/index';
import { DELETE as disconnectApi } from '../src/pages/oauth/connections/[id]';
import { DELETE as mcpDeleteApi, GET as mcpGetApi, POST as mcpApi } from '../src/pages/mcp';
import { POST as legacyMcpApi } from '../src/pages/api/mcp';

const T0 = Date.parse('2026-10-05T00:00:00.000Z');
const ORIGIN = 'https://zuey.test';
const MCP_URL = `${ORIGIN}/mcp`;
const REDIRECT = 'http://127.0.0.1:33418/callback';
const MODERN = '2026-07-28';
const HOUR = 60 * 60 * 1000;

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
  params?: Record<string, string>;
}

function makeRequest(opts: CtxOpts): Request {
  const headers = new Headers(opts.headers ?? {});
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers.set('Content-Type', 'application/x-www-form-urlencoded');
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.form)) for (const one of Array.isArray(v) ? v : [v]) sp.append(k, one);
    body = sp.toString();
  }
  return new Request(opts.url ?? `${ORIGIN}/`, { method: opts.method ?? (body === undefined ? 'GET' : 'POST'), headers, body });
}

function ctx(opts: CtxOpts): APIContext {
  const request = makeRequest(opts);
  // Handlers only read request/params/locals; a full APIContext is not constructible in tests.
  const partial = { request, params: opts.params ?? {}, url: new URL(request.url), locals: { runtime: { env: env() } } };
  return partial as unknown as APIContext;
}

async function body(res: Response): Promise<unknown> {
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function member(email: string): Promise<{ userId: string; cookie: string }> {
  const { user } = await findOrCreateVerifiedUser(d1, { email });
  const { token } = await createMemberSession(d1, user.id);
  return { userId: user.id, cookie: `zuey_member=${token}` };
}

function randomVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString('base64url');
}

async function register(meta: Record<string, unknown> = {}): Promise<{ clientId: string; secret: string | null; status: number; body: unknown }> {
  const res = await registerApi(ctx({
    url: `${ORIGIN}/oauth/register`,
    json: { client_name: 'Test MCP Client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], ...meta },
    headers: { 'cf-connecting-ip': '198.51.100.7' },
  }));
  const b = await body(res);
  const clientId = get(b, 'client_id');
  const secret = get(b, 'client_secret');
  return { clientId: typeof clientId === 'string' ? clientId : '', secret: typeof secret === 'string' ? secret : null, status: res.status, body: b };
}

function authorizeUrl(params: Record<string, string>): string {
  return `${ORIGIN}/oauth/authorize?${new URLSearchParams(params).toString()}`;
}

/** Drives the real flow: authorize -> (member signed in) consent screen -> approve -> code on the redirect URI. */
async function authorize(opts: {
  clientId: string; cookie: string; verifier: string; scope?: string; approve?: string[]; state?: string; redirectUri?: string;
}): Promise<{ code: string | null; location: URL }> {
  const params: Record<string, string> = {
    response_type: 'code', client_id: opts.clientId, redirect_uri: opts.redirectUri ?? REDIRECT,
    code_challenge: await pkceChallenge(opts.verifier), code_challenge_method: 'S256', state: opts.state ?? 'st-123', resource: MCP_URL,
  };
  if (opts.scope !== undefined) params.scope = opts.scope;
  const start = await startAuthorization(d1, new Request(authorizeUrl(params)));
  if (start.kind !== 'redirect') throw new Error(`authorize failed: ${start.kind === 'error' ? start.message : ''}`);
  const requestId = new URL(start.location, ORIGIN).searchParams.get('request_id') ?? '';
  const consent = await loadConsent(d1, env(), new Request(`${ORIGIN}${start.location}`, { headers: { cookie: opts.cookie } }), requestId);
  if (consent.kind !== 'consent') throw new Error(`consent not shown: ${consent.kind}`);
  const approve = opts.approve ?? consent.view.scopes.filter(s => s.requested).map(s => s.scope);
  const res = await consentApi(ctx({
    url: `${ORIGIN}/oauth/consent`, form: { request_id: requestId, decision: 'approve', scope: approve }, headers: { cookie: opts.cookie, Origin: ORIGIN },
  }));
  expect(res.status).toBe(303);
  const location = new URL(res.headers.get('Location') ?? '');
  return { code: location.searchParams.get('code'), location };
}

async function exchange(form: Record<string, string>, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const res = await tokenApi(ctx({ url: `${ORIGIN}/oauth/token`, form, headers }));
  return { status: res.status, body: await body(res) };
}

async function fullFlow(email: string, opts: { scope?: string; approve?: string[] } = {}): Promise<{ clientId: string; access: string; refresh: string; userId: string; cookie: string }> {
  const m = await member(email);
  const { clientId } = await register();
  const verifier = randomVerifier();
  const { code } = await authorize({ clientId, cookie: m.cookie, verifier, ...opts });
  const tok = await exchange({ grant_type: 'authorization_code', code: code ?? '', redirect_uri: REDIRECT, code_verifier: verifier, client_id: clientId, resource: MCP_URL });
  expect(tok.status).toBe(200);
  return { clientId, access: String(get(tok.body, 'access_token')), refresh: String(get(tok.body, 'refresh_token')), userId: m.userId, cookie: m.cookie };
}

interface McpOpts { token?: string; url?: string; modern?: boolean; headers?: Record<string, string> }

async function mcp(method: string, params: Record<string, unknown> = {}, opts: McpOpts = {}): Promise<{ status: number; body: unknown; res: Response }> {
  const headers: Record<string, string> = { Accept: 'application/json, text/event-stream' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let p = params;
  if (opts.modern !== false) {
    headers['MCP-Protocol-Version'] = MODERN;
    headers['Mcp-Method'] = method;
    if (method === 'tools/call' && typeof params.name === 'string') headers['Mcp-Name'] = params.name;
    p = { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} } };
  }
  const res = await mcpApi(ctx({ url: opts.url ?? MCP_URL, json: { jsonrpc: '2.0', id: 1, method, params: p }, headers: { ...headers, ...(opts.headers ?? {}) } }));
  return { status: res.status, body: await body(res.clone()), res };
}

async function toolNames(token: string): Promise<string[]> {
  const r = await mcp('tools/list', {}, { token });
  expect(r.status).toBe(200);
  const tools = get(r.body, 'result', 'tools');
  return Array.isArray(tools) ? tools.map(t => String(get(t, 'name'))) : [];
}

beforeEach(() => {
  d1 = createTestD1();
  now = T0;
  fetchHandler = () => new Response('not found', { status: 404 });
  membersRuntime.now = () => now;
  membersRuntime.fetch = async (input: string, init?: RequestInit) => {
    // Mirrors the Workers runtime, which throws on the `error` redirect mode.
    if (init?.redirect === 'error') throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
    return fetchHandler(input);
  };
});

describe('discovery metadata', () => {
  it('serves authorization server and protected resource metadata', async () => {
    const as = await body(await asMetadataApi(ctx({ url: `${ORIGIN}/.well-known/oauth-authorization-server` })));
    expect(get(as, 'issuer')).toBe(ORIGIN);
    expect(get(as, 'authorization_endpoint')).toBe(`${ORIGIN}/oauth/authorize`);
    expect(get(as, 'token_endpoint')).toBe(`${ORIGIN}/oauth/token`);
    expect(get(as, 'registration_endpoint')).toBe(`${ORIGIN}/oauth/register`);
    expect(get(as, 'revocation_endpoint')).toBe(`${ORIGIN}/oauth/revoke`);
    expect(get(as, 'code_challenge_methods_supported')).toEqual(['S256']);
    expect(get(as, 'client_id_metadata_document_supported')).toBe(true);
    expect(get(as, 'authorization_response_iss_parameter_supported')).toBe(true);
    expect(get(as, 'response_types_supported')).toEqual(['code']);

    for (const api of [prmMcpApi, prmRootApi]) {
      const prm = await body(await api(ctx({ url: `${ORIGIN}/.well-known/oauth-protected-resource/mcp` })));
      expect(get(prm, 'resource')).toBe(MCP_URL);
      expect(get(prm, 'authorization_servers')).toEqual([ORIGIN]);
      expect(get(prm, 'bearer_methods_supported')).toEqual(['header']);
      const scopes = get(prm, 'scopes_supported');
      expect(Array.isArray(scopes) && scopes.includes('articles:read')).toBe(true);
    }
  });

  it('documents OAuth and /mcp in the OpenAPI registry', () => {
    const paths = Object.assign({}, ...OPENAPI_FRAGMENTS.map(f => f.paths));
    for (const p of ['/mcp', '/oauth/token', '/oauth/register', '/oauth/revoke', '/oauth/authorize', '/oauth/connections', '/oauth/connections/{id}', '/.well-known/oauth-authorization-server']) {
      expect(paths[p]).toBeDefined();
    }
  });
});

describe('dynamic client registration', () => {
  it('registers public and confidential clients and validates metadata', async () => {
    const pub = await register();
    expect(pub.status).toBe(201);
    expect(pub.clientId.startsWith('zc_')).toBe(true);
    expect(pub.secret).toBeNull();

    const conf = await register({ token_endpoint_auth_method: 'client_secret_basic' });
    expect(conf.status).toBe(201);
    expect(conf.secret?.startsWith('zcs_')).toBe(true);

    for (const bad of [
      { redirect_uris: [] },
      { redirect_uris: ['http://evil.example/cb'] },
      { redirect_uris: ['javascript:alert(1)'] },
      { redirect_uris: ['https://app.example/cb#frag'] },
      { grant_types: ['client_credentials'] },
      { token_endpoint_auth_method: 'private_key_jwt' },
    ]) {
      const r = await register(bad);
      expect(r.status).toBe(400);
      expect(String(get(r.body, 'error'))).toMatch(/invalid_(redirect_uri|client_metadata)/);
    }
  });

  it('rate limits registrations per network', async () => {
    for (let i = 0; i < 20; i++) expect((await register()).status).toBe(201);
    const limited = await register();
    expect(limited.status).toBe(429);
    expect(get(limited.body, 'error')).toBe('temporarily_unavailable');
  });
});

describe('authorization code + PKCE', () => {
  it('completes the real flow and calls /mcp with the token', async () => {
    const m = await member('lan@example.com');
    const { clientId } = await register();
    const verifier = randomVerifier();
    const { code, location } = await authorize({ clientId, cookie: m.cookie, verifier, scope: 'articles:read account:read', state: 'xyz' });
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('state')).toBe('xyz');
    expect(location.searchParams.get('iss')).toBe(ORIGIN);
    expect(code?.startsWith('zac_')).toBe(true);

    const tok = await exchange({ grant_type: 'authorization_code', code: code ?? '', redirect_uri: REDIRECT, code_verifier: verifier, client_id: clientId });
    expect(tok.status).toBe(200);
    expect(get(tok.body, 'token_type')).toBe('Bearer');
    expect(get(tok.body, 'scope')).toBe('articles:read account:read');
    expect(String(get(tok.body, 'access_token')).startsWith('zoa_')).toBe(true);
    expect(String(get(tok.body, 'refresh_token')).startsWith('zor_')).toBe(true);

    const me = await mcp('tools/call', { name: 'me_get', arguments: {} }, { token: String(get(tok.body, 'access_token')) });
    expect(me.status).toBe(200);
    expect(get(me.body, 'result', 'resultType')).toBe('complete');
    expect(String(get(me.body, 'result', 'content', 0, 'text'))).toContain('lan@example.com');
    const meView: unknown = JSON.parse(String(get(me.body, 'result', 'content', 0, 'text')));
    // OAuth access tokens are reported as such, not as personal `zk_` keys.
    expect(get(meView, 'auth')).toEqual({ via: 'oauth_token', scopes: ['articles:read', 'account:read'] });
  });

  it('sends unauthenticated members to /login and back to the parked request', async () => {
    const { clientId } = await register();
    const start = await startAuthorization(d1, new Request(authorizeUrl({
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: await pkceChallenge(randomVerifier()), code_challenge_method: 'S256',
    })));
    expect(start.kind).toBe('redirect');
    const requestId = start.kind === 'redirect' ? new URL(start.location, ORIGIN).searchParams.get('request_id') ?? '' : '';
    const load = await loadConsent(d1, env(), new Request(`${ORIGIN}/oauth/authorize?request_id=${requestId}`), requestId);
    expect(load.kind).toBe('login');
    if (load.kind === 'login') expect(load.location).toBe(`/login?next=${encodeURIComponent(`/oauth/authorize?request_id=${requestId}`)}`);
  });

  it('rejects a wrong verifier, a reused code and a mismatched redirect_uri', async () => {
    const m = await member('lan@example.com');
    const { clientId } = await register();

    const v1 = randomVerifier();
    const a1 = await authorize({ clientId, cookie: m.cookie, verifier: v1 });
    const wrong = await exchange({ grant_type: 'authorization_code', code: a1.code ?? '', redirect_uri: REDIRECT, code_verifier: randomVerifier(), client_id: clientId });
    expect(wrong.status).toBe(400);
    expect(get(wrong.body, 'error')).toBe('invalid_grant');
    // The code was consumed by the failed attempt.
    const retry = await exchange({ grant_type: 'authorization_code', code: a1.code ?? '', redirect_uri: REDIRECT, code_verifier: v1, client_id: clientId });
    expect(get(retry.body, 'error')).toBe('invalid_grant');

    const v2 = randomVerifier();
    const a2 = await authorize({ clientId, cookie: m.cookie, verifier: v2 });
    const first = await exchange({ grant_type: 'authorization_code', code: a2.code ?? '', redirect_uri: REDIRECT, code_verifier: v2, client_id: clientId });
    expect(first.status).toBe(200);
    const reuse = await exchange({ grant_type: 'authorization_code', code: a2.code ?? '', redirect_uri: REDIRECT, code_verifier: v2, client_id: clientId });
    expect(reuse.status).toBe(400);
    expect(get(reuse.body, 'error')).toBe('invalid_grant');
    // Reuse means the code leaked: tokens it produced are revoked.
    expect((await mcp('ping', {}, { token: String(get(first.body, 'access_token')) })).status).toBe(401);

    const v3 = randomVerifier();
    const a3 = await authorize({ clientId, cookie: m.cookie, verifier: v3 });
    const mismatch = await exchange({ grant_type: 'authorization_code', code: a3.code ?? '', redirect_uri: 'http://127.0.0.1:33418/other', code_verifier: v3, client_id: clientId });
    expect(get(mismatch.body, 'error')).toBe('invalid_grant');

    // At the authorization endpoint an unregistered redirect_uri never redirects.
    const bad = await startAuthorization(d1, new Request(authorizeUrl({
      response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:33418/callback/', code_challenge: await pkceChallenge(v3), code_challenge_method: 'S256',
    })));
    expect(bad.kind).toBe('error');
  });

  it('expires codes after two minutes', async () => {
    const m = await member('lan@example.com');
    const { clientId } = await register();
    const v = randomVerifier();
    const { code } = await authorize({ clientId, cookie: m.cookie, verifier: v });
    now += 3 * 60 * 1000;
    const r = await exchange({ grant_type: 'authorization_code', code: code ?? '', redirect_uri: REDIRECT, code_verifier: v, client_id: clientId });
    expect(get(r.body, 'error')).toBe('invalid_grant');
  });

  it('reports request errors to the verified redirect_uri with state and iss', async () => {
    const { clientId } = await register();
    const noPkce = await startAuthorization(d1, new Request(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 's1' })));
    expect(noPkce.kind).toBe('redirect');
    const loc = new URL(noPkce.kind === 'redirect' ? noPkce.location : '');
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('s1');
    expect(loc.searchParams.get('iss')).toBe(ORIGIN);

    const wrongResource = await startAuthorization(d1, new Request(authorizeUrl({
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: await pkceChallenge(randomVerifier()), code_challenge_method: 'S256',
      resource: 'https://evil.example/mcp',
    })));
    expect(new URL(wrongResource.kind === 'redirect' ? wrongResource.location : '').searchParams.get('error')).toBe('invalid_target');

    const unknown = await startAuthorization(d1, new Request(authorizeUrl({ response_type: 'code', client_id: 'zc_nope', redirect_uri: REDIRECT })));
    expect(unknown.kind).toBe('error');
  });

  it('honours a denial and binds the request to one member', async () => {
    const lan = await member('lan@example.com');
    const mai = await member('mai@example.com');
    const { clientId } = await register();
    const start = await startAuthorization(d1, new Request(authorizeUrl({
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: await pkceChallenge(randomVerifier()), code_challenge_method: 'S256', state: 'd',
    })));
    const requestId = start.kind === 'redirect' ? new URL(start.location, ORIGIN).searchParams.get('request_id') ?? '' : '';
    expect((await loadConsent(d1, env(), new Request(`${ORIGIN}/oauth/authorize`, { headers: { cookie: lan.cookie } }), requestId)).kind).toBe('consent');
    expect((await loadConsent(d1, env(), new Request(`${ORIGIN}/oauth/authorize`, { headers: { cookie: mai.cookie } }), requestId)).kind).toBe('error');

    const crossSite = await consentApi(ctx({ url: `${ORIGIN}/oauth/consent`, form: { request_id: requestId, decision: 'approve', scope: 'articles:read' }, headers: { cookie: lan.cookie, Origin: 'https://evil.example' } }));
    expect(crossSite.status).toBe(403);

    const deny = await consentApi(ctx({ url: `${ORIGIN}/oauth/consent`, form: { request_id: requestId, decision: 'deny' }, headers: { cookie: lan.cookie, Origin: ORIGIN } }));
    expect(deny.status).toBe(303);
    const loc = new URL(deny.headers.get('Location') ?? '');
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('d');
    const again = await consentApi(ctx({ url: `${ORIGIN}/oauth/consent`, form: { request_id: requestId, decision: 'approve', scope: 'articles:read' }, headers: { cookie: lan.cookie, Origin: ORIGIN } }));
    expect(again.status).toBe(400);
  });

  it('accepts Client ID Metadata Document clients', async () => {
    const clientId = 'https://client.example/oauth/metadata.json';
    fetchHandler = (url) => url === clientId
      ? new Response(JSON.stringify({ client_id: clientId, client_name: 'Example Desktop', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }), { headers: { 'Content-Type': 'application/json' } })
      : new Response('nope', { status: 404 });
    const m = await member('lan@example.com');
    const v = randomVerifier();
    const { code } = await authorize({ clientId, cookie: m.cookie, verifier: v });
    const tok = await exchange({ grant_type: 'authorization_code', code: code ?? '', redirect_uri: REDIRECT, code_verifier: v, client_id: clientId });
    expect(tok.status).toBe(200);
    expect(get(tok.body, 'refresh_token')).toBeUndefined();

    const mismatched = 'https://client.example/other.json';
    fetchHandler = () => new Response(JSON.stringify({ client_id: clientId, client_name: 'x', redirect_uris: [REDIRECT] }));
    const bad = await startAuthorization(d1, new Request(authorizeUrl({ response_type: 'code', client_id: mismatched, redirect_uri: REDIRECT })));
    expect(bad.kind).toBe('error');

    const jwtOnly = 'https://client.example/jwt-only.json';
    fetchHandler = () => new Response(JSON.stringify({ client_id: jwtOnly, client_name: 'x', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'private_key_jwt' }));
    const refused = await startAuthorization(d1, new Request(authorizeUrl({ response_type: 'code', client_id: jwtOnly, redirect_uri: REDIRECT })));
    expect(refused.kind).toBe('error');

    const redirecting = 'https://client.example/moved.json';
    fetchHandler = () => new Response(null, { status: 302, headers: { Location: clientId } });
    const moved = await startAuthorization(d1, new Request(authorizeUrl({ response_type: 'code', client_id: redirecting, redirect_uri: REDIRECT })));
    expect(moved.kind).toBe('error');
    if (moved.kind === 'error') expect(moved.message).toContain('must not redirect');
  });

  it('accepts metadata documents that prefer private_key_jwt but also support none', async () => {
    const clientId = 'https://chat.example/oauth/client.json';
    fetchHandler = (url) => url === clientId
      ? new Response(JSON.stringify({
        client_id: clientId, client_name: 'Chat Example', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      }))
      : new Response('nope', { status: 404 });
    const m = await member('lan@example.com');
    const v = randomVerifier();
    const { code } = await authorize({ clientId, cookie: m.cookie, verifier: v });
    const tok = await exchange({ grant_type: 'authorization_code', code: code ?? '', redirect_uri: REDIRECT, code_verifier: v, client_id: clientId });
    expect(tok.status).toBe(200);
  });

  it('matches loopback redirect URIs on any port', async () => {
    const clientId = 'https://cli.example/oauth/client-metadata';
    fetchHandler = (url) => url === clientId
      ? new Response(JSON.stringify({ client_id: clientId, client_name: 'CLI', redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'], token_endpoint_auth_method: 'none' }))
      : new Response('nope', { status: 404 });
    const m = await member('lan@example.com');
    const v = randomVerifier();
    const redirectUri = 'http://localhost:64510/callback';
    const { code } = await authorize({ clientId, cookie: m.cookie, verifier: v, redirectUri });
    const tok = await exchange({ grant_type: 'authorization_code', code: code ?? '', redirect_uri: redirectUri, code_verifier: v, client_id: clientId });
    expect(tok.status).toBe(200);

    for (const other of ['http://localhost:64510/other', 'http://evil.example:64510/callback', 'https://localhost:64510/callback']) {
      const r = await startAuthorization(d1, new Request(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: other })));
      expect(r.kind).toBe('error');
    }
  });

  it('authenticates confidential clients at the token endpoint', async () => {
    const m = await member('lan@example.com');
    const { clientId, secret } = await register({ token_endpoint_auth_method: 'client_secret_basic' });
    const v = randomVerifier();
    const { code } = await authorize({ clientId, cookie: m.cookie, verifier: v });
    const form = { grant_type: 'authorization_code', code: code ?? '', redirect_uri: REDIRECT, code_verifier: v };
    const noAuth = await exchange({ ...form, client_id: clientId });
    expect(noAuth.status).toBe(401);
    expect(get(noAuth.body, 'error')).toBe('invalid_client');
    const wrong = await exchange(form, { Authorization: `Basic ${btoa(`${clientId}:zcs_wrong`)}` });
    expect(wrong.status).toBe(401);
    const ok = await exchange(form, { Authorization: `Basic ${btoa(`${clientId}:${secret ?? ''}`)}` });
    expect(ok.status).toBe(200);
  });
});

describe('refresh tokens and revocation', () => {
  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const f = await fullFlow('lan@example.com');
    const r1 = await exchange({ grant_type: 'refresh_token', refresh_token: f.refresh, client_id: f.clientId });
    expect(r1.status).toBe(200);
    const access2 = String(get(r1.body, 'access_token'));
    const refresh2 = String(get(r1.body, 'refresh_token'));
    expect(refresh2).not.toBe(f.refresh);
    expect((await mcp('ping', {}, { token: access2 })).status).toBe(200);

    const narrowed = await exchange({ grant_type: 'refresh_token', refresh_token: refresh2, client_id: f.clientId, scope: 'articles:read' });
    expect(get(narrowed.body, 'scope')).toBe('articles:read');
    const refresh3 = String(get(narrowed.body, 'refresh_token'));
    const widen = await exchange({ grant_type: 'refresh_token', refresh_token: refresh3, client_id: f.clientId, scope: 'articles:read admin' });
    expect(get(widen.body, 'error')).toBe('invalid_scope');

    const reuse = await exchange({ grant_type: 'refresh_token', refresh_token: f.refresh, client_id: f.clientId });
    expect(reuse.status).toBe(400);
    expect(get(reuse.body, 'error')).toBe('invalid_grant');
    expect((await mcp('ping', {}, { token: access2 })).status).toBe(401);
    const afterReuse = await exchange({ grant_type: 'refresh_token', refresh_token: refresh3, client_id: f.clientId });
    expect(get(afterReuse.body, 'error')).toBe('invalid_grant');
  });

  it('refuses refresh tokens presented by another client', async () => {
    const f = await fullFlow('lan@example.com');
    const other = await register();
    const r = await exchange({ grant_type: 'refresh_token', refresh_token: f.refresh, client_id: other.clientId });
    expect(get(r.body, 'error')).toBe('invalid_grant');
  });

  it('revokes tokens via /oauth/revoke', async () => {
    const f = await fullFlow('lan@example.com');
    const res = await revokeApi(ctx({ url: `${ORIGIN}/oauth/revoke`, form: { token: f.access, client_id: f.clientId } }));
    expect(res.status).toBe(200);
    expect((await mcp('ping', {}, { token: f.access })).status).toBe(401);
    const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: f.refresh, client_id: f.clientId });
    expect(get(refreshed.body, 'error')).toBe('invalid_grant');
    const unknown = await revokeApi(ctx({ url: `${ORIGIN}/oauth/revoke`, form: { token: 'zoa_unknown', client_id: f.clientId } }));
    expect(unknown.status).toBe(200);
  });

  it('lists connected apps and disconnects them from /account', async () => {
    const f = await fullFlow('lan@example.com');
    const list = await body(await connectionsApi(ctx({ url: `${ORIGIN}/oauth/connections`, headers: { cookie: f.cookie } })));
    const apps = get(list, 'data');
    expect(Array.isArray(apps) && apps.length).toBe(1);
    expect(get(apps, 0, 'client_name')).toBe('Test MCP Client');
    expect(get(apps, 0, 'redirect_hosts')).toEqual(['http://127.0.0.1:33418']);
    expect(JSON.stringify(list)).not.toContain(f.access);
    const id = String(get(apps, 0, 'id'));

    const other = await member('mai@example.com');
    expect((await disconnectApi(ctx({ method: 'DELETE', url: `${ORIGIN}/oauth/connections/${id}`, params: { id }, headers: { cookie: other.cookie, Origin: ORIGIN } }))).status).toBe(404);
    const keyUser = await createUserKey(d1, f.userId, { name: 'k', scopes: ['account:read'], expires_in_days: 30 });
    expect((await disconnectApi(ctx({ method: 'DELETE', url: `${ORIGIN}/oauth/connections/${id}`, params: { id }, headers: { Authorization: `Bearer ${keyUser.secret}` } }))).status).toBe(403);

    const del = await disconnectApi(ctx({ method: 'DELETE', url: `${ORIGIN}/oauth/connections/${id}`, params: { id }, headers: { cookie: f.cookie, Origin: ORIGIN } }));
    expect(del.status).toBe(200);
    expect((await mcp('ping', {}, { token: f.access })).status).toBe(401);
    const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: f.refresh, client_id: f.clientId });
    expect(get(refreshed.body, 'error')).toBe('invalid_grant');
  });
});

describe('/mcp resource server', () => {
  it('answers 401 with a resource_metadata challenge when unauthenticated or expired', async () => {
    const anon = await mcp('tools/list');
    expect(anon.status).toBe(401);
    expect(anon.res.headers.get('WWW-Authenticate')).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);

    const f = await fullFlow('lan@example.com');
    now += 2 * HOUR;
    const expired = await mcp('tools/list', {}, { token: f.access });
    expect(expired.status).toBe(401);
    const challenge = expired.res.headers.get('WWW-Authenticate') ?? '';
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain('resource_metadata=');

    const bogus = await mcp('tools/list', {}, { token: 'zoa_bogus' });
    expect(bogus.status).toBe(401);
  });

  it('rejects tokens issued for another audience', async () => {
    const f = await fullFlow('lan@example.com');
    const elsewhere = await mcp('tools/list', {}, { token: f.access, url: 'https://other.test/mcp' });
    expect(elsewhere.status).toBe(401);
    expect(elsewhere.res.headers.get('WWW-Authenticate')).toContain('not issued for this resource');
    // Tokens never work on the REST API either (audience-bound to /mcp).
  });

  it('limits tools/call by OAuth scope with an insufficient_scope step-up', async () => {
    const f = await fullFlow('lan@example.com', { scope: 'articles:read' });
    const names = await toolNames(f.access);
    expect(names).toContain('article_list');
    expect(names).not.toContain('me_get');
    expect(names).not.toContain('billing_checkout_create');

    const denied = await mcp('tools/call', { name: 'me_get', arguments: {} }, { token: f.access });
    expect(denied.status).toBe(403);
    expect(denied.res.headers.get('WWW-Authenticate')).toContain('error="insufficient_scope"');
    expect(denied.res.headers.get('WWW-Authenticate')).toContain('scope="account:read"');
    expect(get(denied.body, 'error', 'data', 'required_scope')).toBe('account:read');

    const adminTool = await mcp('tools/call', { name: 'update_profile', arguments: { name: 'x' } }, { token: f.access });
    expect(adminTool.status).toBe(200);
    expect(get(adminTool.body, 'result', 'isError')).toBe(true);
  });

  it('filters tools/list for members, admins, personal keys and admin keys', async () => {
    const lan = await fullFlow('lan@example.com', { scope: 'articles:read account:read billing:read checkout:write' });
    const memberTools = await toolNames(lan.access);
    expect(memberTools).toEqual(expect.arrayContaining(['get_profile', 'article_list', 'me_get', 'me_keys_list', 'plans_list', 'billing_checkout_create', 'subscription_get']));
    for (const adminOnly of ['update_profile', 'members_list', 'article_create', 'workflow_delete', 'booking_list']) expect(memberTools).not.toContain(adminOnly);

    // Admin identity without the admin scope stays a member and is told which scope to request.
    const bossMember = await fullFlow('boss@example.com', { scope: 'account:read' });
    expect(await toolNames(bossMember.access)).not.toContain('update_profile');
    const stepUp = await mcp('tools/call', { name: 'members_list', arguments: {} }, { token: bossMember.access });
    expect(stepUp.status).toBe(403);
    expect(stepUp.res.headers.get('WWW-Authenticate')).toContain('scope="admin"');

    const boss = await fullFlow('boss@example.com', { scope: 'account:read admin', approve: ['account:read', 'admin'] });
    const adminTools = await toolNames(boss.access);
    expect(adminTools).toEqual(expect.arrayContaining(['update_profile', 'members_list', 'article_create']));

    // A non-admin cannot obtain the admin scope even by forging the consent form.
    const mai = await member('mai@example.com');
    const { clientId } = await register();
    const v = randomVerifier();
    const { code } = await authorize({ clientId, cookie: mai.cookie, verifier: v, scope: 'account:read admin', approve: ['account:read', 'admin'] });
    const tok = await exchange({ grant_type: 'authorization_code', code: code ?? '', redirect_uri: REDIRECT, code_verifier: v, client_id: clientId });
    expect(get(tok.body, 'scope')).toBe('account:read');

    const key = await createUserKey(d1, lan.userId, { name: 'cli', scopes: ['articles:read'], expires_in_days: 30 });
    const keyTools = await toolNames(key.secret);
    expect(keyTools).toContain('article_list');
    expect(keyTools).not.toContain('me_get');
    expect(keyTools).not.toContain('update_profile');

    const adminKey = (await createApiKey('ops', 'admin', d1)).key;
    expect(await toolNames(adminKey)).toEqual(expect.arrayContaining(['update_profile', 'members_list']));

    // Cookies are ignored on /mcp: a session alone is not a credential.
    const cookieOnly = await mcp('tools/list', {}, { headers: { cookie: lan.cookie, Origin: ORIGIN } });
    expect(cookieOnly.status).toBe(401);
  });

  it('lists key metadata read-only and never exposes secrets', async () => {
    const f = await fullFlow('lan@example.com', { scope: 'account:read' });
    const key = await createUserKey(d1, f.userId, { name: 'laptop', scopes: ['articles:read'], expires_in_days: 30 });
    const r = await mcp('tools/call', { name: 'me_keys_list', arguments: {} }, { token: f.access });
    const text = String(get(r.body, 'result', 'content', 0, 'text'));
    expect(text).toContain('laptop');
    expect(text).not.toContain(key.secret);
    expect(allMcpTools().some(t => /key/.test(t.name) && t.name !== 'me_keys_list')).toBe(false);
  });

  it('keeps the tool access map complete (unknown tools would be hidden)', () => {
    for (const t of allMcpTools()) expect(TOOL_ACCESS[t.name]).toBeDefined();
  });

  it('negotiates protocol versions and validates mirrored headers', async () => {
    const f = await fullFlow('lan@example.com');
    const discover = await mcp('server/discover', {}, { token: f.access });
    expect(discover.status).toBe(200);
    expect(get(discover.body, 'result', 'supportedVersions')).toEqual(expect.arrayContaining([MODERN, '2025-06-18']));
    expect(get(discover.body, 'result', '_meta', 'io.modelcontextprotocol/serverInfo', 'name')).toBe('zuey-me');

    const legacy = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }, { token: f.access, modern: false });
    expect(get(legacy.body, 'result', 'protocolVersion')).toBe('2025-06-18');
    const legacyList = await mcp('tools/list', {}, { token: f.access, modern: false, headers: { 'MCP-Protocol-Version': '2025-06-18' } });
    expect(legacyList.status).toBe(200);

    const mismatch = await mcp('tools/list', {}, { token: f.access, headers: { 'Mcp-Method': 'tools/call' } });
    expect(mismatch.status).toBe(400);
    expect(get(mismatch.body, 'error', 'code')).toBe(-32020);

    const unsupported = await mcp('tools/list', {}, { token: f.access, modern: false, headers: { 'MCP-Protocol-Version': '1999-01-01' } });
    expect(unsupported.status).toBe(400);
    expect(get(unsupported.body, 'error', 'code')).toBe(-32022);

    const unknownMethod = await mcp('nope/nope', {}, { token: f.access });
    expect(unknownMethod.status).toBe(404);
    expect(get(unknownMethod.body, 'error', 'code')).toBe(-32601);

    const unknownTool = await mcp('tools/call', { name: 'does_not_exist', arguments: {} }, { token: f.access });
    expect(get(unknownTool.body, 'error', 'code')).toBe(-32602);

    const note = await mcpApi(ctx({ url: MCP_URL, json: { jsonrpc: '2.0', method: 'notifications/initialized' }, headers: { Authorization: `Bearer ${f.access}` } }));
    expect(note.status).toBe(202);

    const badOrigin = await mcp('ping', {}, { token: f.access, headers: { Origin: 'https://evil.example' } });
    expect(badOrigin.status).toBe(403);

    expect((await mcpGetApi(ctx({ url: MCP_URL }))).status).toBe(405);
    expect((await mcpDeleteApi(ctx({ method: 'DELETE', url: MCP_URL }))).status).toBe(405);
  });
});

describe('legacy /api/mcp', () => {
  it('still serves initialize, tools/list and public tool calls', async () => {
    const init = await body(await legacyMcpApi(ctx({ url: `${ORIGIN}/api/mcp`, json: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } })));
    expect(get(init, 'result', 'protocolVersion')).toBe('2024-11-05');
    const list = await body(await legacyMcpApi(ctx({ url: `${ORIGIN}/api/mcp`, json: { jsonrpc: '2.0', id: 2, method: 'tools/list' } })));
    const tools = get(list, 'result', 'tools');
    const names = Array.isArray(tools) ? tools.map(t => String(get(t, 'name'))) : [];
    expect(names).toEqual(expect.arrayContaining(['get_profile', 'update_profile', 'article_list', 'me_keys_list']));
    const profile = await legacyMcpApi(ctx({ url: `${ORIGIN}/api/mcp`, json: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_profile', arguments: {} } } }));
    expect(profile.status).toBe(200);
    const denied = await legacyMcpApi(ctx({ url: `${ORIGIN}/api/mcp`, json: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'update_profile', arguments: { name: 'x' } } } }));
    expect(denied.status).toBe(401);
  });
});

describe('request ids', () => {
  it('stamps X-Request-Id and adds it to the JSON error envelope', async () => {
    const res = await withRequestId(jsonError(404, 'not_found', 'Nope'), 'req_test123');
    expect(res.headers.get('X-Request-Id')).toBe('req_test123');
    expect(get(await body(res), 'error', 'request_id')).toBe('req_test123');

    const ok = await withRequestId(new Response(JSON.stringify({ success: true, data: 1 }), { headers: { 'Content-Type': 'application/json' } }), 'req_ok12345');
    expect(ok.headers.get('X-Request-Id')).toBe('req_ok12345');
    expect(await body(ok)).toEqual({ success: true, data: 1 });

    const redirect = await withRequestId(Response.redirect(`${ORIGIN}/x`, 302), 'req_redirect1');
    expect(redirect.headers.get('X-Request-Id')).toBe('req_redirect1');
  });
});
