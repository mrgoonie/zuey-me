import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import type { RuntimeEnv } from '../src/env';
import { OPENAPI_FRAGMENTS } from '../src/lib/openapi/registry';
import { membersRuntime } from '../src/lib/members/runtime';
import { createMemberSession } from '../src/lib/members/session';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { PRESENCE_TICKET_TTL_MS, type PresenceTicketPayload } from '../src/lib/presence/contract';
import { presenceIpKey } from '../src/lib/presence/ip-prefix';
import { createFixedWindowLimiter, presenceTicketLimiter, PRESENCE_TICKET_RATE_LIMIT } from '../src/lib/presence/presence-rate-limit';
import { presenceConnectUrl, presenceOwnerIds } from '../src/lib/presence/presence-ticket-issuer';
import { hmacBase64Url, verifyPresenceTicket } from '../src/lib/presence/ticket';
import { POST } from '../src/pages/api/v1/presence/ticket';

const ORIGIN = 'https://zuey.me';
const SECRET = 'test-presence-secret-0123456789';
const BROWSER_ID = 'AbCdEfGhIjKlMnOpQrStUvWx';
const T0 = Date.parse('2026-10-20T03:00:00.000Z');

let d1: ReturnType<typeof createTestD1>;
let envOverrides: Partial<RuntimeEnv>;
const realNow = membersRuntime.now;

function env(): RuntimeEnv {
  return {
    DB: d1, PUBLIC_SITE_URL: ORIGIN, ADMIN_EMAILS: 'boss@example.com', PRESENCE_TICKET_SECRET: SECRET, ...envOverrides,
  };
}

interface CallOpts { body?: unknown; raw?: string; headers?: Record<string, string>; ip?: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function call(opts: CallOpts = {}): Promise<{ status: number; data: Record<string, unknown>; code: string | null; res: Response }> {
  const headers = new Headers({ 'Content-Type': 'application/json', 'cf-connecting-ip': opts.ip ?? '203.0.113.7', ...opts.headers });
  const body = opts.raw ?? JSON.stringify(opts.body ?? { count: false });
  const request = new Request(`${ORIGIN}/api/v1/presence/ticket`, { method: 'POST', headers, body });
  // Handlers only read request/locals; a full APIContext is not constructible in tests.
  const res = await POST({ request, locals: { runtime: { env: env() } } } as unknown as APIContext);
  const json: unknown = await res.clone().json();
  const data = isRecord(json) && isRecord(json.data) ? json.data : {};
  const error = isRecord(json) && isRecord(json.error) ? json.error : null;
  return { status: res.status, data, code: error && typeof error.code === 'string' ? error.code : null, res };
}

async function payloadOf(data: Record<string, unknown>): Promise<PresenceTicketPayload> {
  expect(typeof data.ticket).toBe('string');
  const payload = await verifyPresenceTicket(SECRET, String(data.ticket), T0);
  if (!payload) throw new Error('ticket did not verify');
  return payload;
}

async function member(email: string): Promise<{ userId: string; headers: Record<string, string> }> {
  const { user } = await findOrCreateVerifiedUser(d1, { email });
  const { token } = await createMemberSession(d1, user.id);
  return { userId: user.id, headers: { cookie: `zuey_member=${token}`, Origin: ORIGIN } };
}

beforeEach(() => {
  d1 = createTestD1();
  envOverrides = {};
  membersRuntime.now = () => T0;
  presenceTicketLimiter.reset();
});

afterEach(() => {
  membersRuntime.now = realNow;
  presenceTicketLimiter.reset();
});

describe('POST /api/v1/presence/ticket', () => {
  it('issues a watch-only ticket to an anonymous visitor with a throwaway key', async () => {
    const a = await call({ body: { count: false } });
    expect(a.status).toBe(200);
    expect(a.res.headers.get('Cache-Control')).toBe('no-store');
    expect(a.data.url).toBe('wss://presence.zuey.me/v1/connect');
    expect(a.data.expiresAt).toBe(new Date(T0 + PRESENCE_TICKET_TTL_MS).toISOString());
    const p = await payloadOf(a.data);
    expect(p).toMatchObject({ c: false, m: false, o: false, exp: T0 + PRESENCE_TICKET_TTL_MS });
    expect(p.k).toHaveLength(32);
    const b = await payloadOf((await call({ body: { count: false } })).data);
    expect(b.k).not.toBe(p.k);
    expect(b.n).not.toBe(p.n);
  });

  it('counts an anonymous visitor by an HMAC of its browser id, stable across tabs', async () => {
    const a = await payloadOf((await call({ body: { count: true, browserId: BROWSER_ID } })).data);
    const b = await payloadOf((await call({ body: { count: true, browserId: BROWSER_ID } })).data);
    expect(a).toMatchObject({ c: true, m: false, o: false });
    expect(a.k).toBe(b.k);
    expect(a.k).toBe((await hmacBase64Url(SECRET, `b:${BROWSER_ID}`)).slice(0, 32));
    expect(JSON.stringify(a)).not.toContain(BROWSER_ID);
  });

  it('rejects a counting guest without a well-formed browser id', async () => {
    for (const browserId of [undefined, 'short', 'has spaces in it here!', 'x'.repeat(65), 42]) {
      const r = await call({ body: { count: true, browserId } });
      expect(r.status).toBe(400);
      expect(r.code).toBe('invalid_browser_id');
    }
    expect((await call({ raw: 'not json' })).code).toBe('invalid_json');
    expect((await call({ body: { count: 'yes' } })).code).toBe('invalid_request');
  });

  it('collapses a member across devices and ignores client-supplied m/o/k', async () => {
    const m = await member('reader@example.com');
    const r = await call({ body: { count: true, browserId: BROWSER_ID, m: false, o: true, k: 'forged' }, headers: m.headers });
    expect(r.status).toBe(200);
    const p = await payloadOf(r.data);
    expect(p).toMatchObject({ c: true, m: true, o: false });
    expect(p.k).toBe((await hmacBase64Url(SECRET, `m:${m.userId}`)).slice(0, 32));
    const other = await payloadOf((await call({ body: { count: true, browserId: 'ZZZZZZZZZZZZZZZZZZZZ' }, headers: m.headers })).data);
    expect(other.k).toBe(p.k);
    const text = JSON.stringify(p) + atob(String(r.data.ticket).split('.')[0].replace(/-/g, '+').replace(/_/g, '/'));
    expect(text).not.toContain(m.userId);
    expect(text).not.toContain('reader@example.com');
  });

  it('treats a session cookie on a cross-site request as anonymous', async () => {
    const m = await member('reader@example.com');
    const p = await payloadOf((await call({ body: { count: false }, headers: { cookie: m.headers.cookie, Origin: 'https://evil.example' } })).data);
    expect(p.m).toBe(false);
  });

  it('marks only members listed in PRESENCE_OWNER_MEMBER_IDS as owner, never admins by role', async () => {
    const owner = await member('owner@example.com');
    const admin = await member('boss@example.com');
    envOverrides = { PRESENCE_OWNER_MEMBER_IDS: ` usr_other , ${owner.userId} ,` };
    expect(await payloadOf((await call({ body: { count: true }, headers: owner.headers })).data)).toMatchObject({ m: true, o: true });
    expect(await payloadOf((await call({ body: { count: true }, headers: admin.headers })).data)).toMatchObject({ m: true, o: false });
    expect(await payloadOf((await call({ body: { count: false }, headers: { Authorization: `Bearer ${owner.userId}` } })).data)).toMatchObject({ m: false, o: false });
  });

  it('answers 503 presence_unavailable without the ticket secret', async () => {
    envOverrides = { PRESENCE_TICKET_SECRET: undefined };
    const r = await call({ body: { count: false } });
    expect(r.status).toBe(503);
    expect(r.code).toBe('presence_unavailable');
    expect(r.res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rate limits tickets per client IP', async () => {
    for (let i = 0; i < PRESENCE_TICKET_RATE_LIMIT; i++) expect((await call({ body: { count: false } })).status).toBe(200);
    const limited = await call({ body: { count: false } });
    expect(limited.status).toBe(429);
    expect(limited.code).toBe('rate_limited');
    expect(Number(limited.res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await call({ body: { count: false }, ip: '198.51.100.9' })).status).toBe(200);
  });

  it('counts IPv6 clients per /64, so rotating addresses inside it shares one budget', async () => {
    for (let i = 0; i < PRESENCE_TICKET_RATE_LIMIT; i++) presenceTicketLimiter.hit(presenceIpKey('2001:db8:aa:bb::1'), membersRuntime.now());
    expect((await call({ body: { count: false }, ip: '2001:db8:aa:bb:1234:5678:9abc:def0' })).status).toBe(429);
    expect((await call({ body: { count: false }, ip: '2001:db8:aa:bc::1' })).status).toBe(200);
  });

  it('uses PUBLIC_PRESENCE_URL as a ws(s) origin', () => {
    expect(presenceConnectUrl({ PUBLIC_PRESENCE_URL: 'http://localhost:8787/' })).toBe('ws://localhost:8787/v1/connect');
    expect(presenceConnectUrl({ PUBLIC_PRESENCE_URL: 'https://presence.example.com' })).toBe('wss://presence.example.com/v1/connect');
    expect(() => presenceConnectUrl({ PUBLIC_PRESENCE_URL: 'ftp://x' })).toThrow();
    expect([...presenceOwnerIds({ PRESENCE_OWNER_MEMBER_IDS: 'a, b,,a ' })]).toEqual(['a', 'b']);
  });

  it('is documented in the OpenAPI registry', () => {
    const fragment = OPENAPI_FRAGMENTS.find(f => '/api/v1/presence/ticket' in f.paths);
    expect(fragment?.tag.name).toBe('Presence');
  });
});

describe('fixed-window limiter', () => {
  it('resets after the window and stays within its key bound', () => {
    const limiter = createFixedWindowLimiter(2, 1_000, 3);
    expect(limiter.hit('a', 0)).toBeNull();
    expect(limiter.hit('a', 10)).toBeNull();
    expect(limiter.hit('a', 20)).toBe(1);
    expect(limiter.hit('a', 1_000)).toBeNull();
    for (const k of ['b', 'c', 'd', 'e']) expect(limiter.hit(k, 1_100)).toBeNull();
  });
});

describe('presenceIpKey', () => {
  it('keeps IPv4 and reduces IPv6 to its /64', () => {
    expect(presenceIpKey('203.0.113.7')).toBe('203.0.113.7');
    expect(presenceIpKey(' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(presenceIpKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(presenceIpKey('2001:0DB8:0001:0002:ffff:aaaa:bbbb:cccc')).toBe('2001:db8:1:2::/64');
    expect(presenceIpKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(presenceIpKey('::1')).toBe('0:0:0:0::/64');
    expect(presenceIpKey('[2001:db8:1:2::1]')).toBe('2001:db8:1:2::/64');
    expect(presenceIpKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(presenceIpKey('2001:db8:1:2:3:4:192.0.2.1')).toBe('2001:db8:1:2::/64');
  });

  it('treats IPv4-mapped IPv6 as IPv4 and leaves unparseable input alone', () => {
    expect(presenceIpKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(presenceIpKey('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(presenceIpKey('')).toBe('');
    expect(presenceIpKey('unknown')).toBe('unknown');
    expect(presenceIpKey('1:2:3:4:5:6:7:8:9')).toBe('1:2:3:4:5:6:7:8:9');
    expect(presenceIpKey('1::2::3')).toBe('1::2::3');
    expect(presenceIpKey('2001:db8:zz::1')).toBe('2001:db8:zz::1');
  });
});
