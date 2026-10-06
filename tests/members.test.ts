import { beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createApiKey, createSession } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { authenticateAdmin } from '../src/lib/auth';
import { createUserKey } from '../src/lib/members/api-keys';
import { membersRuntime } from '../src/lib/members/runtime';
import { can, resolvePrincipal } from '../src/lib/members/policy';
import { createMemberSession } from '../src/lib/members/session';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { membersMcpModule } from '../src/lib/members/mcp';
import { billingOpenApi, membersOpenApi } from '../src/lib/members/openapi';
import { MCP_FEATURE_MODULES } from '../src/lib/mcp/registry';
import { OPENAPI_FRAGMENTS } from '../src/lib/openapi/registry';
import { AppError } from '../src/lib/http';
import { POST as magicLinkApi } from '../src/pages/api/members/auth/magic-link';
import { POST as verifyApi } from '../src/pages/api/members/auth/magic-link/verify';
import { GET as oauthStartApi } from '../src/pages/api/members/auth/[provider]';
import { POST as logoutApi } from '../src/pages/api/members/auth/logout';
import { GET as googleCallback } from '../src/pages/api/auth/google/callback';
import { GET as githubCallback } from '../src/pages/api/auth/github/callback';
import { DELETE as meDeleteApi, GET as meApi, PATCH as mePatchApi } from '../src/pages/api/v1/me/index';
import { POST as emailChangeApi } from '../src/pages/api/v1/me/email/index';
import { POST as emailConfirmApi } from '../src/pages/api/v1/me/email/confirm';
import { GET as sessionsApi } from '../src/pages/api/v1/me/sessions/index';
import { DELETE as sessionDeleteApi } from '../src/pages/api/v1/me/sessions/[id]';
import { GET as exportApi } from '../src/pages/api/v1/me/export';
import { GET as keysListApi, POST as keysCreateApi } from '../src/pages/api/v1/me/keys/index';
import { DELETE as keyRevokeApi } from '../src/pages/api/v1/me/keys/[id]/index';
import { POST as keyRotateApi } from '../src/pages/api/v1/me/keys/[id]/rotate';
import { GET as adminMembersApi } from '../src/pages/api/v1/admin/members';

// Monday 2026-10-05 00:00 UTC.
const T0 = Date.parse('2026-10-05T00:00:00.000Z');
const ORIGIN = 'https://zuey.test';
const MIN = 60 * 1000;

type TestDb = ReturnType<typeof createTestD1>;
let d1: TestDb;
let now: number;
let emails: { to: string; subject: string; text: string }[];
let fetchLog: string[];
let oauthProfiles: { google: Record<string, unknown>; githubUser: Record<string, unknown>; githubEmails: unknown[] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  fetchLog.push(input);
  if (input === 'https://api.resend.com/emails') {
    const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    if (isRecord(body)) {
      const to = Array.isArray(body.to) ? String(body.to[0]) : String(body.to);
      emails.push({ to, subject: String(body.subject), text: String(body.text) });
    }
    return json({ id: `email_${emails.length}` });
  }
  if (input === 'https://oauth2.googleapis.com/token') return json({ access_token: 'g_access' });
  if (input === 'https://openidconnect.googleapis.com/v1/userinfo') return json(oauthProfiles.google);
  if (input === 'https://github.com/login/oauth/access_token') return json({ access_token: 'gh_access' });
  if (input === 'https://api.github.com/user') return json(oauthProfiles.githubUser);
  if (input === 'https://api.github.com/user/emails') return json(oauthProfiles.githubEmails);
  return json({ error: 'unexpected' }, 500);
}

const baseEnv = (): RuntimeEnv => ({
  DB: d1,
  PUBLIC_SITE_URL: ORIGIN,
  RESEND_API_KEY: 're_test',
  MEMBER_HASH_SALT: 'salt',
  ADMIN_EMAILS: 'boss@example.com',
  GOOGLE_CLIENT_ID: 'gid',
  GOOGLE_CLIENT_SECRET: 'gsecret',
  GITHUB_CLIENT_ID: 'ghid',
  GITHUB_CLIENT_SECRET: 'ghsecret',
});

interface CtxOpts {
  env?: RuntimeEnv;
  method?: string;
  path?: string;
  body?: unknown;
  headers?: Record<string, string>;
  params?: Record<string, string>;
}

function ctx(opts: CtxOpts): APIContext {
  const headers = new Headers(opts.headers ?? {});
  const method = opts.method ?? 'GET';
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json');
  const request = new Request(`${ORIGIN}${opts.path ?? '/api/test'}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  // Handlers only read request/params/locals; a full APIContext is not constructible in tests.
  const redirect = (location: string, status = 302) => new Response(null, { status, headers: { Location: location } });
  const partial = { request, params: opts.params ?? {}, url: new URL(request.url), redirect, locals: { runtime: { env: opts.env ?? baseEnv() } } };
  return partial as unknown as APIContext;
}

/** Browser-style same-origin request carrying the member cookie. */
function browser(cookie: string, extra: Record<string, string> = {}): Record<string, string> {
  return { cookie, Origin: ORIGIN, ...extra };
}

interface Envelope { success: boolean; data?: unknown; error?: { code: string; message: string } }

async function read(res: Response): Promise<Envelope> {
  const body: unknown = await res.json();
  if (!isRecord(body)) throw new Error('non-object body');
  return {
    success: body.success === true,
    data: body.data,
    error: isRecord(body.error) ? { code: String(body.error.code), message: String(body.error.message) } : undefined,
  };
}

function field(v: unknown, key: string): unknown {
  return isRecord(v) ? v[key] : undefined;
}

function cookieFrom(res: Response, name: string): string {
  const all = res.headers.getSetCookie();
  const c = all.find(h => h.startsWith(`${name}=`));
  if (!c) throw new Error(`no ${name} cookie`);
  return c.split(';')[0];
}

function lastToken(): string {
  const last = emails[emails.length - 1];
  const m = last ? /token=([A-Za-z0-9_-]+)/.exec(last.text) : null;
  if (!m) throw new Error('no token in email');
  return m[1];
}

async function signInByMagicLink(email: string, next = '/account'): Promise<string> {
  const req = await magicLinkApi(ctx({ method: 'POST', body: { email, next }, headers: { 'cf-connecting-ip': '203.0.113.9' } }));
  expect(req.status).toBe(202);
  const res = await verifyApi(ctx({ method: 'POST', body: { token: lastToken() }, headers: { Origin: ORIGIN } }));
  expect(res.status).toBe(200);
  return cookieFrom(res, 'zuey_member');
}

async function memberWithSession(email: string): Promise<{ userId: string; cookie: string }> {
  const { user } = await findOrCreateVerifiedUser(d1, { email });
  const { token } = await createMemberSession(d1, user.id);
  return { userId: user.id, cookie: `zuey_member=${token}` };
}

beforeEach(() => {
  d1 = createTestD1();
  now = T0;
  emails = [];
  fetchLog = [];
  oauthProfiles = {
    google: { sub: 'g-1', email: 'lan@example.com', email_verified: true, name: 'Lan', picture: 'https://img.test/lan.png' },
    githubUser: { id: 42, login: 'lan-gh', name: null, avatar_url: 'https://img.test/gh.png' },
    githubEmails: [{ email: 'lan@example.com', verified: true, primary: true }],
  };
  membersRuntime.now = () => now;
  membersRuntime.fetch = fakeFetch;
});

describe('magic link sign-in', () => {
  it('signs in once, creates the account, and refuses reuse', async () => {
    const req = await magicLinkApi(ctx({ method: 'POST', body: { email: 'Lan@Example.com', next: '/pricing' } }));
    expect(req.status).toBe(202);
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toBe('lan@example.com');
    expect(emails[0].text).toContain(`${ORIGIN}/login/verify?token=`);
    const token = lastToken();

    const ok = await verifyApi(ctx({ method: 'POST', body: { token }, headers: { Origin: ORIGIN } }));
    expect(ok.status).toBe(200);
    const okBody = await read(ok);
    expect(field(okBody.data, 'next')).toBe('/pricing');
    expect(field(okBody.data, 'created')).toBe(true);
    const setCookie = ok.headers.getSetCookie().join('\n');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');

    // The raw token is never stored; only its hash.
    const stored = d1.raw.query('SELECT token_hash FROM member_sessions').all();
    expect(JSON.stringify(stored)).not.toContain(cookieFrom(ok, 'zuey_member').split('=')[1]);

    const reuse = await verifyApi(ctx({ method: 'POST', body: { token }, headers: { Origin: ORIGIN } }));
    expect(reuse.status).toBe(400);
    expect((await read(reuse)).error?.code).toBe('invalid_token');
  });

  it('expires links after 15 minutes and rejects open redirects', async () => {
    await magicLinkApi(ctx({ method: 'POST', body: { email: 'lan@example.com', next: '//evil.test/x' } }));
    const token = lastToken();
    now += 16 * MIN;
    const late = await verifyApi(ctx({ method: 'POST', body: { token }, headers: { Origin: ORIGIN } }));
    expect(late.status).toBe(400);
    expect((await read(late)).error?.code).toBe('invalid_token');

    await magicLinkApi(ctx({ method: 'POST', body: { email: 'lan@example.com', next: '//evil.test/x' } }));
    const res = await verifyApi(ctx({ method: 'POST', body: { token: lastToken() }, headers: { Origin: ORIGIN } }));
    expect(field((await read(res)).data, 'next')).toBe('/account');
  });

  it('rate limits per email and per IP', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await magicLinkApi(ctx({ method: 'POST', body: { email: 'spam@example.com' } }))).status).toBe(202);
    }
    const limited = await magicLinkApi(ctx({ method: 'POST', body: { email: 'spam@example.com' } }));
    expect(limited.status).toBe(429);
    expect((await read(limited)).error?.code).toBe('rate_limited');

    const ipHeaders = { 'cf-connecting-ip': '198.51.100.7' };
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await magicLinkApi(ctx({ method: 'POST', body: { email: `u${i}@example.com` }, headers: ipHeaders }))).status;
    }
    expect(last).toBe(429);

    now += 16 * MIN;
    expect((await magicLinkApi(ctx({ method: 'POST', body: { email: 'spam@example.com' } }))).status).toBe(202);
  });

  it('returns 503 without the email provider and never creates a token', async () => {
    const env = { ...baseEnv(), RESEND_API_KEY: undefined };
    const res = await magicLinkApi(ctx({ env, method: 'POST', body: { email: 'lan@example.com' } }));
    expect(res.status).toBe(503);
    expect((await read(res)).error?.code).toBe('email_unconfigured');
    expect(d1.raw.query('SELECT COUNT(*) AS n FROM login_tokens').get()).toEqual({ n: 0 });
  });

  it('rejects cross-site token consumption (CSRF)', async () => {
    await magicLinkApi(ctx({ method: 'POST', body: { email: 'lan@example.com' } }));
    const token = lastToken();
    const evil = await verifyApi(ctx({ method: 'POST', body: { token }, headers: { Origin: 'https://evil.test' } }));
    expect(evil.status).toBe(403);
    const noOrigin = await verifyApi(ctx({ method: 'POST', body: { token }, headers: { 'Sec-Fetch-Site': 'cross-site' } }));
    expect(noOrigin.status).toBe(403);
    const fetchMeta = await verifyApi(ctx({ method: 'POST', body: { token }, headers: { 'Sec-Fetch-Site': 'same-origin' } }));
    expect(fetchMeta.status).toBe(200);
  });
});

describe('member sessions and CSRF', () => {
  it('reads /me, blocks cross-site writes with the cookie, and logs out', async () => {
    const cookie = await signInByMagicLink('lan@example.com');
    const me = await meApi(ctx({ headers: { cookie } }));
    expect(me.status).toBe(200);
    expect(me.headers.get('Cache-Control')).toContain('no-store');
    const body = await read(me);
    expect(field(body.data, 'email')).toBe('lan@example.com');
    expect(field(body.data, 'is_admin')).toBe(false);

    const crossSite = await mePatchApi(ctx({ method: 'PATCH', body: { name: 'Hacked' }, headers: { cookie, Origin: 'https://evil.test' } }));
    expect(crossSite.status).toBe(403);
    expect((await read(crossSite)).error?.code).toBe('csrf_rejected');
    const noHeaders = await mePatchApi(ctx({ method: 'PATCH', body: { name: 'Hacked' }, headers: { cookie } }));
    expect(noHeaders.status).toBe(403);

    const patched = await mePatchApi(ctx({ method: 'PATCH', body: { name: 'Lan Nguyễn', locale: 'en' }, headers: browser(cookie) }));
    expect(patched.status).toBe(200);
    expect(field((await read(patched)).data, 'name')).toBe('Lan Nguyễn');
    const badAvatar = await mePatchApi(ctx({ method: 'PATCH', body: { avatar_url: 'javascript:alert(1)' }, headers: browser(cookie) }));
    expect(badAvatar.status).toBe(400);

    const out = await logoutApi(ctx({ method: 'POST', headers: browser(cookie) }));
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().join('')).toContain('Max-Age=0');
    expect((await meApi(ctx({ headers: { cookie } }))).status).toBe(401);
  });

  it('slides the 30-day session and expires idle sessions', async () => {
    const cookie = await signInByMagicLink('lan@example.com');
    now += 29 * 24 * 60 * MIN;
    expect((await meApi(ctx({ headers: { cookie } }))).status).toBe(200);
    now += 29 * 24 * 60 * MIN; // still alive: the previous request slid the expiry
    expect((await meApi(ctx({ headers: { cookie } }))).status).toBe(200);
    now += 31 * 24 * 60 * MIN;
    expect((await meApi(ctx({ headers: { cookie } }))).status).toBe(401);
  });

  it('isolates sessions between members', async () => {
    const a = await memberWithSession('a@example.com');
    const b = await memberWithSession('b@example.com');
    const listA = await read(await sessionsApi(ctx({ headers: { cookie: a.cookie } })));
    const aSessionId = field(Array.isArray(listA.data) ? listA.data[0] : null, 'id');
    expect(typeof aSessionId).toBe('string');
    const steal = await sessionDeleteApi(ctx({ method: 'DELETE', params: { id: String(aSessionId) }, headers: browser(b.cookie) }));
    expect(steal.status).toBe(404);
    expect((await meApi(ctx({ headers: { cookie: a.cookie } }))).status).toBe(200);
  });
});

describe('OAuth sign-in and linking', () => {
  async function oauthRoundTrip(provider: 'google' | 'github', existingCookie?: string): Promise<Response> {
    const start = await oauthStartApi(ctx({ path: `/api/members/auth/${provider}?next=%2Fpricing`, params: { provider } }));
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get('Location') ?? '');
    const state = location.searchParams.get('state') ?? '';
    expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/${provider}/callback`);
    const stateCookie = cookieFrom(start, 'zuey_member_oauth');
    const cookie = existingCookie ? `${stateCookie}; ${existingCookie}` : stateCookie;
    const handler = provider === 'google' ? googleCallback : githubCallback;
    return handler(ctx({ path: `/api/auth/${provider}/callback?code=abc&state=${encodeURIComponent(state)}`, headers: { cookie } }));
  }

  it('creates a member from a verified Google identity and redirects to next', async () => {
    const res = await oauthRoundTrip('google');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/pricing');
    const cookie = cookieFrom(res, 'zuey_member');
    const me = await read(await meApi(ctx({ headers: { cookie } })));
    expect(field(me.data, 'email')).toBe('lan@example.com');
    expect(JSON.stringify(field(me.data, 'identities'))).toContain('google');
  });

  it('links GitHub to the same member by verified email, and to the signed-in member explicitly', async () => {
    const magicCookie = await signInByMagicLink('lan@example.com');
    const gh = await oauthRoundTrip('github');
    const ghCookie = cookieFrom(gh, 'zuey_member');
    const viaGh = await read(await meApi(ctx({ headers: { cookie: ghCookie } })));
    const viaMagic = await read(await meApi(ctx({ headers: { cookie: magicCookie } })));
    expect(field(viaGh.data, 'id')).toBe(field(viaMagic.data, 'id'));

    // Signed-in member links a Google account whose email differs.
    oauthProfiles.google = { sub: 'g-2', email: 'other@gmail.test', email_verified: true };
    const link = await oauthRoundTrip('google', magicCookie);
    expect(link.status).toBe(302);
    expect(link.headers.getSetCookie().some(c => c.startsWith('zuey_member='))).toBe(false);
    const identities = JSON.stringify(field((await read(await meApi(ctx({ headers: { cookie: magicCookie } })))).data, 'identities'));
    expect(identities).toContain('other@gmail.test');
  });

  it('refuses unverified provider emails and identities owned by another member', async () => {
    oauthProfiles.google = { sub: 'g-3', email: 'x@example.com', email_verified: false };
    const unverified = await oauthRoundTrip('google');
    expect(unverified.headers.get('Location')).toBe('/login?error=email_unverified');

    await oauthRoundTrip('github'); // github id 42 → lan@example.com
    const other = await memberWithSession('someone@example.com');
    const conflict = await oauthRoundTrip('github', other.cookie);
    expect(conflict.headers.get('Location')).toBe('/login?error=identity_linked_elsewhere');
  });

  it('rejects a callback whose state does not match the browser cookie', async () => {
    const start = await oauthStartApi(ctx({ path: '/api/members/auth/google', params: { provider: 'google' } }));
    const stateCookie = cookieFrom(start, 'zuey_member_oauth');
    const res = await googleCallback(ctx({ path: '/api/auth/google/callback?code=abc&state=forged', headers: { cookie: stateCookie } }));
    expect(res.headers.get('Location')).toBe('/login?error=oauth_state');
    expect(fetchLog.some(u => u.includes('oauth2.googleapis.com'))).toBe(false);
  });
});

describe('admin identity', () => {
  it('grants admin only to a verified allowlisted email', async () => {
    const env = baseEnv();
    d1.raw.run(`INSERT INTO users (id, email, email_verified_at, locale, created_at, updated_at) VALUES ('u_boss', 'boss@example.com', NULL, 'vi', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`);
    const { token } = await createMemberSession(d1, 'u_boss');
    const req = () => new Request(`${ORIGIN}/api/v1/admin/members`, { headers: { cookie: `zuey_member=${token}` } });

    const unverified = await resolvePrincipal(req(), env);
    expect(unverified.kind).toBe('member');
    expect((await authenticateAdmin(req(), d1, env)).authenticated).toBe(false);
    expect((await adminMembersApi(ctx({ headers: { cookie: `zuey_member=${token}` } }))).status).toBe(403);

    d1.raw.run(`UPDATE users SET email_verified_at = '2026-10-02T00:00:00.000Z' WHERE id = 'u_boss'`);
    const verified = await resolvePrincipal(req(), env);
    expect(verified.kind).toBe('admin');
    expect((await authenticateAdmin(req(), d1, env)).authenticated).toBe(true);
    const list = await adminMembersApi(ctx({ headers: { cookie: `zuey_member=${token}` } }));
    expect(list.status).toBe(200);
    expect(JSON.stringify((await read(list)).data)).toContain('boss@example.com');

    // A member whose email is not allowlisted is never admin.
    const plain = await memberWithSession('lan@example.com');
    expect((await authenticateAdmin(new Request(ORIGIN, { headers: { cookie: plain.cookie } }), d1, env)).authenticated).toBe(false);
  });

  it('opens a member session alongside the Studio session on owner sign-in', async () => {
    oauthProfiles.githubUser = { id: 7, login: 'mrgoonie', name: 'Duy', avatar_url: 'https://img.test/duy.png' };
    oauthProfiles.githubEmails = [{ email: 'duy@example.com', verified: true, primary: true }];
    const realFetch = globalThis.fetch;
    // The Studio callback calls the global fetch for its own token and profile checks.
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => fakeFetch(String(input), init)) as typeof fetch;
    try {
      const studioLogin = (cookie?: string) => githubCallback(ctx({ path: '/api/auth/github/callback?code=abc', headers: cookie ? { cookie } : {} }));
      const first = await studioLogin();
      expect(first.headers.get('Location')).toBe('/studio');
      const studioCookie = cookieFrom(first, 'zuey_session');
      const memberCookie = cookieFrom(first, 'zuey_member');
      const me = await read(await meApi(ctx({ headers: browser(`${studioCookie}; ${memberCookie}`) })));
      expect(field(me.data, 'email')).toBe('duy@example.com');
      expect(JSON.stringify(field(me.data, 'identities'))).toContain('github');

      // Signing in to Studio again from the same browser keeps the existing member session.
      const again = await studioLogin(memberCookie);
      expect(again.headers.getSetCookie().some(c => c.startsWith('zuey_member='))).toBe(false);
      expect(again.headers.getSetCookie().some(c => c.startsWith('zuey_session='))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('lets a member session win over a Studio cookie in the same browser', async () => {
    const env = baseEnv();
    const studio = await createSession('owner@zuey.me', d1);
    const lan = await memberWithSession('lan@example.com');
    const both = `zuey_session=${studio}; ${lan.cookie}`;

    // Same-origin: the member account is used and the Studio cookie still grants admin.
    const p = await resolvePrincipal(new Request(`${ORIGIN}/api/v1/me`, { headers: { cookie: both, Origin: ORIGIN } }), env);
    expect(p.via).toBe('member_session');
    expect(p.userId).toBe(lan.userId);
    expect(p.kind).toBe('admin');
    expect(can(p, 'community:access')).toBe(true);
    expect(can(p, 'keys:manage')).toBe(true);
    const me = await meApi(ctx({ headers: browser(both) }));
    expect(me.status).toBe(200);

    // Cross-site: the member cookie is ignored and the Studio session behaves as before.
    const cross = await resolvePrincipal(new Request(`${ORIGIN}/api/x`, { method: 'POST', headers: { cookie: both, Origin: 'https://evil.test' } }), env);
    expect(cross.via).toBe('studio_session');

    // Signing out ends both sessions.
    const out = await logoutApi(ctx({ method: 'POST', headers: browser(both) }));
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toContain('zuey_session=;');
    const after = await resolvePrincipal(new Request(`${ORIGIN}/api/x`, { headers: { cookie: both, Origin: ORIGIN } }), env);
    expect(after.kind).toBe('anonymous');
  });

  it('keeps Studio sessions and admin API keys working', async () => {
    const env = baseEnv();
    const studio = await createSession('owner@zuey.me', d1);
    const studioReq = new Request(`${ORIGIN}/api/x`, { headers: { cookie: `zuey_session=${studio}` } });
    expect((await authenticateAdmin(studioReq, d1, env)).authenticated).toBe(true);
    expect((await resolvePrincipal(studioReq, env)).via).toBe('studio_session');

    const adminKey = (await createApiKey('ops', 'admin', d1)).key;
    const keyReq = new Request(`${ORIGIN}/api/x`, { headers: { Authorization: `Bearer ${adminKey}` } });
    expect((await resolvePrincipal(keyReq, env)).kind).toBe('admin');
    expect((await authenticateAdmin(keyReq, d1, env)).authenticated).toBe(true);

    const readKey = (await createApiKey('reader', 'read', d1)).key;
    const readP = await resolvePrincipal(new Request(ORIGIN, { headers: { 'X-API-Key': readKey } }), env);
    expect(readP.kind).toBe('anonymous');
    expect(readP.via).toBe('read_api_key');

    const bogus = await resolvePrincipal(new Request(ORIGIN, { headers: { Authorization: 'Bearer nope' } }), env);
    expect(bogus.credentialError?.code).toBe('invalid_api_key');
    const anon = await resolvePrincipal(new Request(ORIGIN), env);
    expect(anon.kind).toBe('anonymous');
    expect(can(anon, 'account:read')).toBe(false);
  });
});

describe('personal API keys', () => {
  async function createKey(cookie: string, body: Record<string, unknown>): Promise<{ secret: string; id: string; status: number; code?: string }> {
    const res = await keysCreateApi(ctx({ method: 'POST', body, headers: browser(cookie) }));
    const env = await read(res);
    return { status: res.status, code: env.error?.code, secret: String(field(env.data, 'secret') ?? ''), id: String(field(field(env.data, 'key'), 'id') ?? '') };
  }

  const bearer = (secret: string) => ({ Authorization: `Bearer ${secret}` });

  it('creates a scoped key shown once and stored only as a hash', async () => {
    const { cookie } = await memberWithSession('lan@example.com');
    const key = await createKey(cookie, { name: 'CLI', scopes: ['account:read'], expires_in_days: 30 });
    expect(key.status).toBe(201);
    expect(key.secret.startsWith('zk_')).toBe(true);
    expect(JSON.stringify(d1.raw.query('SELECT * FROM user_api_keys').all())).not.toContain(key.secret);
    const list = await read(await keysListApi(ctx({ headers: { cookie } })));
    expect(JSON.stringify(list.data)).not.toContain(key.secret);

    const me = await meApi(ctx({ headers: bearer(key.secret) }));
    expect(me.status).toBe(200);
    expect(field(field((await read(me)).data, 'auth'), 'via')).toBe('user_api_key');
    // Keys are not subject to the cookie CSRF rule but are limited to their scopes.
    const write = await mePatchApi(ctx({ method: 'PATCH', body: { name: 'x' }, headers: bearer(key.secret) }));
    expect(write.status).toBe(403);
    expect((await read(write)).error?.code).toBe('insufficient_scope');
  });

  it('never grants admin or session-only actions to keys', async () => {
    const { cookie } = await memberWithSession('boss@example.com'); // allowlisted, verified
    const bad = await createKey(cookie, { name: 'root', scopes: ['admin'] });
    expect(bad.status).toBe(400);
    const key = await createKey(cookie, { name: 'all', scopes: ['account:read', 'account:write', 'billing:read', 'checkout:write', 'articles:read', 'chat:write'] });
    const p = await resolvePrincipal(new Request(ORIGIN, { headers: bearer(key.secret) }), baseEnv());
    expect(p.kind).toBe('member');
    expect((await authenticateAdmin(new Request(ORIGIN, { headers: bearer(key.secret) }), d1, baseEnv())).authenticated).toBe(false);
    expect((await adminMembersApi(ctx({ headers: bearer(key.secret) }))).status).toBe(403);
    const keysViaKey = await keysListApi(ctx({ headers: bearer(key.secret) }));
    expect(keysViaKey.status).toBe(403);
    expect((await read(keysViaKey)).error?.code).toBe('session_required');
    const mcp = await membersMcpModule.call('members_list', {}, {
      request: new Request(`${ORIGIN}/api/mcp`, { method: 'POST', headers: bearer(key.secret) }), env: baseEnv(), d1,
      async requireAdmin() { throw new AppError(401, 'unauthorized', 'no'); }, async isAdmin() { return false; },
    }).then(() => null, (e: unknown) => e);
    expect(mcp instanceof AppError && mcp.status === 403).toBe(true);
  });

  it('returns 401 for expired and revoked keys', async () => {
    const { cookie } = await memberWithSession('lan@example.com');
    const shortLived = await createKey(cookie, { name: 'short', scopes: ['account:read'], expires_in_days: 1 });
    now += 2 * 24 * 60 * MIN;
    const expired = await meApi(ctx({ headers: bearer(shortLived.secret) }));
    expect(expired.status).toBe(401);
    expect((await read(expired)).error?.code).toBe('api_key_expired');

    const { cookie: fresh } = await memberWithSession('lan@example.com');
    const key = await createKey(fresh, { name: 'rev', scopes: ['account:read'] });
    expect((await keyRevokeApi(ctx({ method: 'DELETE', params: { id: key.id }, headers: browser(fresh) }))).status).toBe(200);
    const revoked = await meApi(ctx({ headers: bearer(key.secret) }));
    expect(revoked.status).toBe(401);
    expect((await read(revoked)).error?.code).toBe('api_key_revoked');
  });

  it('rotates with overlap and without widening scopes', async () => {
    const { cookie } = await memberWithSession('lan@example.com');
    const old = await createKey(cookie, { name: 'agent', scopes: ['account:read'] });
    const widen = await keyRotateApi(ctx({ method: 'POST', params: { id: old.id }, body: { scopes: ['account:read', 'account:write'] }, headers: browser(cookie) }));
    expect(widen.status).toBe(400);

    const rotated = await keyRotateApi(ctx({ method: 'POST', params: { id: old.id }, body: {}, headers: browser(cookie) }));
    expect(rotated.status).toBe(201);
    const newSecret = String(field((await read(rotated)).data, 'secret'));
    expect(newSecret).not.toBe(old.secret);
    expect((await meApi(ctx({ headers: bearer(old.secret) }))).status).toBe(200);
    expect((await meApi(ctx({ headers: bearer(newSecret) }))).status).toBe(200);

    const again = await keyRotateApi(ctx({ method: 'POST', params: { id: old.id }, body: {}, headers: browser(cookie) }));
    expect(again.status).toBe(409);
    expect((await read(again)).error?.code).toBe('already_rotated');

    await keyRevokeApi(ctx({ method: 'DELETE', params: { id: old.id }, headers: browser(cookie) }));
    expect((await meApi(ctx({ headers: bearer(old.secret) }))).status).toBe(401);
    expect((await meApi(ctx({ headers: bearer(newSecret) }))).status).toBe(200);
  });

  it('isolates keys between members', async () => {
    const a = await memberWithSession('a@example.com');
    const b = await memberWithSession('b@example.com');
    const aKey = await createUserKey(d1, a.userId, { name: 'a', scopes: ['account:read'], expires_in_days: 30 });
    expect((await keyRevokeApi(ctx({ method: 'DELETE', params: { id: aKey.key.id }, headers: browser(b.cookie) }))).status).toBe(404);
    expect((await keyRotateApi(ctx({ method: 'POST', params: { id: aKey.key.id }, body: {}, headers: browser(b.cookie) }))).status).toBe(404);
    const bList = await read(await keysListApi(ctx({ headers: { cookie: b.cookie } })));
    expect(Array.isArray(bList.data) && bList.data.length).toBe(0);
    const aMe = await read(await meApi(ctx({ headers: bearer(aKey.secret) })));
    expect(field(aMe.data, 'email')).toBe('a@example.com');
  });
});

describe('email change, export and deletion', () => {
  it('changes email after verifying the new address and notifies the old one', async () => {
    const { cookie } = await memberWithSession('old@example.com');
    const crossSite = await emailChangeApi(ctx({ method: 'POST', body: { new_email: 'new@example.com' }, headers: { cookie, Origin: 'https://evil.test' } }));
    expect(crossSite.status).toBe(403);
    const req = await emailChangeApi(ctx({ method: 'POST', body: { new_email: 'new@example.com' }, headers: browser(cookie) }));
    expect(req.status).toBe(202);
    expect(emails[emails.length - 1].to).toBe('new@example.com');
    expect(emails[emails.length - 1].text).toContain('/account/email-confirm?token=');

    const confirm = await emailConfirmApi(ctx({ method: 'POST', body: { token: lastToken() }, headers: { Origin: ORIGIN } }));
    expect(confirm.status).toBe(200);
    expect(emails[emails.length - 1].to).toBe('old@example.com');
    expect(field((await read(await meApi(ctx({ headers: { cookie } })))).data, 'email')).toBe('new@example.com');

    await memberWithSession('taken@example.com');
    const taken = await emailChangeApi(ctx({ method: 'POST', body: { new_email: 'taken@example.com' }, headers: browser(cookie) }));
    expect(taken.status).toBe(409);
  });

  it('exports own data and deletes the account only with confirmation', async () => {
    const { cookie } = await memberWithSession('lan@example.com');
    const exp = await exportApi(ctx({ headers: { cookie } }));
    expect(exp.status).toBe(200);
    expect(exp.headers.get('Content-Disposition')).toContain('attachment');
    expect(await exp.text()).toContain('lan@example.com');

    const wrong = await meDeleteApi(ctx({ method: 'DELETE', body: { confirm_email: 'nope@example.com' }, headers: browser(cookie) }));
    expect(wrong.status).toBe(400);
    const del = await meDeleteApi(ctx({ method: 'DELETE', body: { confirm_email: 'lan@example.com' }, headers: browser(cookie) }));
    expect(del.status).toBe(200);
    expect((await meApi(ctx({ headers: { cookie } }))).status).toBe(401);
    expect(d1.raw.query("SELECT COUNT(*) AS n FROM users WHERE email = 'lan@example.com'").get()).toEqual({ n: 0 });

    // The address can sign up again as a fresh account.
    const again = await signInByMagicLink('lan@example.com');
    expect((await meApi(ctx({ headers: { cookie: again } }))).status).toBe(200);
  });
});

describe('API surface registration', () => {
  it('registers OpenAPI paths and MCP tools', () => {
    expect(OPENAPI_FRAGMENTS).toContain(membersOpenApi);
    expect(OPENAPI_FRAGMENTS).toContain(billingOpenApi);
    expect(MCP_FEATURE_MODULES).toContain(membersMcpModule);
    const paths = [...Object.keys(membersOpenApi.paths), ...Object.keys(billingOpenApi.paths)];
    for (const p of ['/api/v1/me', '/api/v1/me/keys', '/api/v1/me/keys/{id}/rotate', '/api/v1/plans', '/api/v1/billing/orders', '/api/v1/billing/subscription', '/api/v1/admin/members', '/api/v1/billing/reconcile', '/api/v1/admin/billing/attention', '/api/v1/admin/billing/orders/{code}/resolve', '/api/members/auth/magic-link', '/api/members/auth/logout']) {
      expect(paths).toContain(p);
    }
    expect(membersMcpModule.tools.map(t => t.name).sort()).toEqual([
      'billing_attention_list', 'billing_checkout_create', 'billing_order_get', 'billing_order_resolve', 'me_get', 'members_list', 'plans_list', 'subscription_get',
    ]);
  });
});
