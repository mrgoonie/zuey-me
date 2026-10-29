import { beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createApiKey, createSession } from '../src/db/store';
import type { RuntimeEnv, ServiceBindingLike } from '../src/env';
import { createUserKey } from '../src/lib/members/api-keys';
import { createMemberSession } from '../src/lib/members/session';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { OPENAPI_FRAGMENTS } from '../src/lib/openapi/registry';
import { PRESENCE_CONTRACT_VERSION, PRESENCE_INTERNAL_HEADER, type PresenceDiagnostics } from '../src/lib/presence/contract';
import { verifyPresenceInternal } from '../src/lib/presence/internal-auth';
import { isPresenceDiagnostics, parsePresenceDiagnostics } from '../src/lib/presence/presence-diagnostics-guards';
import { GET } from '../src/pages/api/v1/presence/diagnostics';

const ORIGIN = 'https://zuey.me';
const SECRET = 'test-presence-secret-0123456789';

const DIAG: PresenceDiagnostics = {
  v: PRESENCE_CONTRACT_VERSION,
  at: '2026-10-20T04:00:00.000Z',
  sockets: { total: 9, activeSessions: 5, idle: 1, watchOnly: 2, subscribers: 2, owner: 1 },
  limits: { maxTotal: 5000, maxPerIp: 20, maxPerKey: 8 },
  counters: { startedAt: '2026-10-20T01:00:00.000Z', connectsAccepted: 40, connectsRejected: 2, messagesDropped: 3, abuseCloses: 0, broadcasts: 120 },
  alarm: { nextAt: '2026-10-20T04:00:25.000Z', lastRunAt: null, lastRunMs: null },
  history: { buckets: 288, oldest: '2026-10-19T04:05:00.000Z', storageBytes: 40_960 },
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** In-memory presence Worker `/internal/diagnostics` behind the service binding. */
class FakeWorker implements ServiceBindingLike {
  paths: string[] = [];
  answer: () => Response = () => Response.json(DIAG);
  async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    this.paths.push(`${request.method} ${new URL(request.url).pathname}`);
    if (!(await verifyPresenceInternal(SECRET, request.headers.get(PRESENCE_INTERNAL_HEADER), request.method, new URL(request.url).pathname))) return new Response('Not found', { status: 404 });
    return this.answer();
  }
}

let d1: ReturnType<typeof createTestD1>;
let worker: FakeWorker;
let envOverrides: Partial<RuntimeEnv>;

const env = (): RuntimeEnv => ({
  DB: d1, PUBLIC_SITE_URL: ORIGIN, ADMIN_EMAILS: 'boss@example.com', MEMBER_HASH_SALT: 'salt',
  PRESENCE_TICKET_SECRET: SECRET, PRESENCE_OWNER_MEMBER_IDS: 'usr_owner', PRESENCE: worker, ...envOverrides,
});

async function memberHeaders(email: string): Promise<{ userId: string; headers: Record<string, string> }> {
  const { user } = await findOrCreateVerifiedUser(d1, { email });
  const { token } = await createMemberSession(d1, user.id);
  return { userId: user.id, headers: { cookie: `zuey_member=${token}`, Origin: ORIGIN } };
}

async function call(headers: Record<string, string> = {}): Promise<{ status: number; code: string | null; data: unknown; res: Response }> {
  const request = new Request(`${ORIGIN}/api/v1/presence/diagnostics`, { headers });
  // Handlers only read request/locals; a full APIContext is not constructible in tests.
  const ctx = { request, locals: { runtime: { env: env() } } } as unknown as APIContext;
  const res = await GET(ctx);
  const json: unknown = await res.clone().json();
  const error = isRecord(json) && isRecord(json.error) ? json.error : null;
  return { status: res.status, code: error && typeof error.code === 'string' ? error.code : null, data: isRecord(json) ? json.data : null, res };
}

beforeEach(() => {
  d1 = createTestD1();
  worker = new FakeWorker();
  envOverrides = {};
});

describe('GET /api/v1/presence/diagnostics auth matrix', () => {
  it('anonymous callers get 401 and never reach the Worker', async () => {
    const r = await call();
    expect(r.status).toBe(401);
    expect(r.code).toBe('unauthorized');
    expect(r.res.headers.get('Cache-Control')).toBe('no-store');
    expect(worker.paths).toEqual([]);
  });

  it('a signed-in member who is not an admin, or a personal key, gets 403', async () => {
    const m = await memberHeaders('reader@example.com');
    expect((await call(m.headers)).status).toBe(403);
    const { secret } = await createUserKey(d1, m.userId, { name: 'k', scopes: ['account:read'], expires_in_days: 30 });
    expect((await call({ Authorization: `Bearer ${secret}` })).status).toBe(403);
    expect(worker.paths).toEqual([]);
  });

  it('an invalid key is 401', async () => {
    expect((await call({ Authorization: 'Bearer zuey_nope' })).status).toBe(401);
  });

  it('every admin credential and a read-only key get the diagnostics (not owner-only)', async () => {
    const boss = await memberHeaders('boss@example.com');
    const studio = await createSession('owner@zuey.me', d1);
    const adminKey = (await createApiKey('ops', 'admin', d1)).key;
    const readKey = (await createApiKey('viewer', 'read', d1)).key;
    for (const headers of [boss.headers, { cookie: `zuey_session=${studio}` }, { Authorization: `Bearer ${adminKey}` }, { 'X-API-Key': readKey }]) {
      const r = await call(headers);
      expect(r.status).toBe(200);
      expect(r.data).toEqual(DIAG);
      expect(r.res.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(new Set(worker.paths)).toEqual(new Set(['GET /internal/diagnostics']));
  });

  it('a Worker that is down, errors or answers garbage is 503 presence_unavailable', async () => {
    const adminKey = (await createApiKey('ops', 'admin', d1)).key;
    const auth = { Authorization: `Bearer ${adminKey}` };
    const answers: Array<() => Response> = [
      () => { throw new Error('Worker down'); },
      () => new Response('oops', { status: 500 }),
      () => Response.json({ ...DIAG, sockets: { total: 'many' } }),
      () => new Response(null, { status: 302, headers: { Location: 'https://evil.test' } }),
    ];
    for (const answer of answers) {
      worker.answer = answer;
      const r = await call(auth);
      expect(r.status).toBe(503);
      expect(r.code).toBe('presence_unavailable');
      expect(r.res.headers.get('Cache-Control')).toBe('no-store');
    }
    envOverrides = { PRESENCE_TICKET_SECRET: undefined };
    expect((await call(auth)).code).toBe('presence_unavailable');
  });
});

describe('diagnostics guard', () => {
  it('accepts the contract shape', () => {
    expect(isPresenceDiagnostics(DIAG)).toBe(true);
    expect(parsePresenceDiagnostics(DIAG)).toEqual(DIAG);
  });

  it('strips fields the contract does not know, at every level', () => {
    const leaky = { ...DIAG, ips: ['203.0.113.7'], sockets: { ...DIAG.sockets, keys: ['k1'] }, counters: { ...DIAG.counters, lastTicket: 't.s' } };
    expect(parsePresenceDiagnostics(leaky)).toEqual(DIAG);
  });

  it('rejects unexpected shapes', () => {
    const bad: unknown[] = [
      null, [], 'diag', { ...DIAG, v: 2 }, { ...DIAG, at: 'now' },
      { ...DIAG, sockets: undefined },
      { ...DIAG, sockets: { ...DIAG.sockets, total: -1 } },
      { ...DIAG, sockets: { ...DIAG.sockets, idle: 1.5 } },
      { ...DIAG, limits: { maxTotal: 1, maxPerIp: 1 } },
      { ...DIAG, counters: { ...DIAG.counters, startedAt: null } },
      { ...DIAG, counters: { ...DIAG.counters, broadcasts: '3' } },
      { ...DIAG, alarm: { ...DIAG.alarm, lastRunMs: -5 } },
      { ...DIAG, alarm: { ...DIAG.alarm, nextAt: 'soon' } },
      { ...DIAG, history: { ...DIAG.history, storageBytes: null } },
      { ...DIAG, history: [] },
    ];
    for (const v of bad) expect(parsePresenceDiagnostics(v)).toBeNull();
  });
});

describe('diagnostics OpenAPI', () => {
  it('documents the endpoint and its schema in the Presence fragment', () => {
    const fragment = OPENAPI_FRAGMENTS.find((f) => f.paths['/api/v1/presence/diagnostics']);
    expect(fragment?.tag.name).toBe('Presence');
    const get = fragment?.paths['/api/v1/presence/diagnostics'].get;
    expect(isRecord(get) && isRecord(get.responses) ? Object.keys(get.responses).sort() : []).toEqual(['200', '401', '403', '503']);
    const schema = fragment?.schemas.PresenceDiagnostics;
    expect(isRecord(schema) && Array.isArray(schema.required) ? schema.required : []).toEqual(['v', 'at', 'sockets', 'limits', 'counters', 'alarm', 'history']);
  });
});
