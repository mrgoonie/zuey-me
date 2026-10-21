import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import {
  PRESENCE_HISTORY_BUCKETS, PRESENCE_INTERNAL_HEADER, PRESENCE_INTERNAL_MAX_SKEW_MS,
  type PresenceServerMessage,
} from '../src/lib/presence/contract';
import { signPresenceInternal } from '../src/lib/presence/internal-auth';
import { handleRequest } from '../workers/presence/src/index';
import { PresenceHub } from '../workers/presence/src/presence-hub';
import { MAX_SOCKETS_PER_IP, MAX_SOCKETS_PER_KEY, MAX_SOCKETS_TOTAL, MAX_STRIKES, newSession, type SessionIdentity } from '../workers/presence/src/presence-state';
import { HISTORY_CACHE_PATH, HISTORY_MEMO_MS, isPresenceHistory, resetSnapshotCache } from '../workers/presence/src/snapshot-cache';
import type { DurableObjectStateLike, EdgeCacheLike, HubWebSocket, PresenceEnv } from '../workers/presence/src/runtime-types';

const SECRET = 'test-presence-secret';
const ORIGIN = 'https://zuey.me';
const T0 = Date.parse('2026-10-20T04:00:00.000Z');
const HISTORY_URL = 'https://presence.zuey.me/v1/history';
const DIAG_URL = 'https://presence.zuey.me/internal/diagnostics';

class FakeSocket implements HubWebSocket {
  sent: PresenceServerMessage[] = [];
  closed = false;
  private attachment: unknown = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
  }
  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }
}

class FakeState implements DurableObjectStateLike {
  sockets: { ws: FakeSocket; tags: string[] }[] = [];
  data = new Map<string, unknown>();
  alarmAt: number | null = null;
  storage = {
    get: async (key: string): Promise<unknown> => structuredClone(this.data.get(key)),
    put: async (key: string, value: unknown): Promise<void> => { this.data.set(key, structuredClone(value)); },
    getAlarm: async (): Promise<number | null> => this.alarmAt,
    setAlarm: async (t: number): Promise<void> => { this.alarmAt = t; },
  };
  acceptWebSocket(ws: HubWebSocket, tags: string[] = []): void {
    if (!(ws instanceof FakeSocket)) throw new Error('unexpected socket');
    this.sockets.push({ ws, tags });
  }
  getWebSockets(tag?: string): HubWebSocket[] {
    return this.sockets.filter((s) => !s.ws.closed && (tag === undefined || s.tags.includes(tag))).map((s) => s.ws);
  }
}

let now: number;
let state: FakeState;
let hub: PresenceHub;
let hubCalls: string[];
let env: PresenceEnv;

function tick(ms: number): void {
  now += ms;
  setSystemTime(new Date(now));
}

function socket(k: string, over: Partial<SessionIdentity> = {}): FakeSocket {
  const id: SessionIdentity = { k, c: true, m: false, o: false, ipHash: `iphash-${k}`, ...over };
  const ws = new FakeSocket();
  state.acceptWebSocket(ws, [`ip:${id.ipHash}`, `k:${id.k}`]);
  ws.serializeAttachment(newSession(id, now));
  return ws;
}

const send = (ws: FakeSocket, msg: unknown) => hub.webSocketMessage(ws, typeof msg === 'string' ? msg : JSON.stringify(msg));

const diagRequest = async (headers: Record<string, string> = {}, method = 'GET'): Promise<Request> =>
  new Request(DIAG_URL, { method, headers: { [PRESENCE_INTERNAL_HEADER]: await signPresenceInternal(SECRET, now), ...headers } });

beforeEach(() => {
  now = T0;
  setSystemTime(new Date(now));
  resetSnapshotCache();
  state = new FakeState();
  hub = new PresenceHub(state, { PRESENCE_HUB: { idFromName: () => ({ toString: () => 'x' }), get: () => ({ fetch: async () => new Response() }) } });
  hubCalls = [];
  env = {
    PRESENCE_HUB: {
      idFromName: (n) => ({ toString: () => n }),
      get: () => ({
        fetch: (req) => {
          hubCalls.push(new URL(req.url).pathname);
          return hub.fetch(req);
        },
      }),
    },
    PRESENCE_TICKET_SECRET: SECRET,
  };
});

afterEach(() => {
  setSystemTime();
  Reflect.deleteProperty(globalThis, 'caches');
});

describe('GET /v1/history', () => {
  it('serves the 24 h history with CORS for allowed origins and a one-minute cache', async () => {
    const a = socket('a');
    await send(a, { t: 'hb', cat: 'reading' });
    const res = await handleRequest(new Request(HISTORY_URL, { headers: { Origin: ORIGIN } }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    const body: unknown = await res.json();
    if (!isPresenceHistory(body)) throw new Error('not a history');
    expect(body.buckets).toHaveLength(PRESENCE_HISTORY_BUCKETS);
    expect(body.buckets.at(-1)).toEqual({ t: new Date(T0).toISOString(), peak: 1, categories: [] });
  });

  it('refuses foreign origins, answers preflight and rejects other methods', async () => {
    expect((await handleRequest(new Request(HISTORY_URL, { headers: { Origin: 'https://evil.example' } }), env)).status).toBe(403);
    const preflight = await handleRequest(new Request(HISTORY_URL, { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
    expect((await handleRequest(new Request(HISTORY_URL, { method: 'POST', headers: { Origin: ORIGIN } }), env)).status).toBe(405);
    const plain = await handleRequest(new Request(HISTORY_URL), env);
    expect(plain.status).toBe(200);
    expect(plain.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(hubCalls).toEqual(['/history']);
  });

  it('a burst of history requests reaches the hub once per memo window', async () => {
    const responses = await Promise.all(Array.from({ length: 30 }, (_, i) =>
      handleRequest(new Request(HISTORY_URL, { headers: i % 2 ? { Origin: ORIGIN } : {} }), env)));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(hubCalls).toEqual(['/history']);
    tick(HISTORY_MEMO_MS - 1);
    await handleRequest(new Request(HISTORY_URL), env);
    expect(hubCalls).toHaveLength(1);
    tick(1);
    await handleRequest(new Request(HISTORY_URL), env);
    expect(hubCalls).toHaveLength(2);
  });

  it('shares history across isolates through the edge cache under its own internal key', async () => {
    const stored = new Map<string, string>();
    const edge: EdgeCacheLike = {
      match: async (req) => {
        const body = stored.get(req.url);
        return body === undefined ? undefined : new Response(body);
      },
      put: async (req, res) => {
        expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
        stored.set(req.url, await res.text());
      },
    };
    Object.assign(globalThis, { caches: { default: edge } });
    await handleRequest(new Request(HISTORY_URL, { headers: { Origin: ORIGIN } }), env);
    expect([...stored.keys()]).toEqual([`https://presence.zuey.me${HISTORY_CACHE_PATH}`]);
    resetSnapshotCache();
    expect((await handleRequest(new Request(HISTORY_URL), env)).status).toBe(200);
    expect(hubCalls).toHaveLength(1);
  });

  it('answers 503 with CORS when the hub has no valid history', async () => {
    const broken: PresenceEnv = { ...env, PRESENCE_HUB: { idFromName: (n) => ({ toString: () => n }), get: () => ({ fetch: async () => Response.json({ v: 1 }) }) } };
    const res = await handleRequest(new Request(HISTORY_URL, { headers: { Origin: ORIGIN } }), broken);
    expect(res.status).toBe(503);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });
});

describe('GET /internal/diagnostics', () => {
  it('404s without a valid, fresh internal header and never sends CORS headers', async () => {
    const stale = await signPresenceInternal(SECRET, now - PRESENCE_INTERNAL_MAX_SKEW_MS - 1_000);
    const forged = await signPresenceInternal('wrong-secret', now);
    const cases: Record<string, string>[] = [{}, { [PRESENCE_INTERNAL_HEADER]: stale }, { [PRESENCE_INTERNAL_HEADER]: forged }, { [PRESENCE_INTERNAL_HEADER]: 'garbage' }];
    for (const headers of cases) {
      const res = await handleRequest(new Request(DIAG_URL, { headers: { Origin: ORIGIN, ...headers } }), env);
      expect(res.status).toBe(404);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
    expect(hubCalls).toHaveLength(0);
  });

  it('answers 503 without the secret and 405 for other methods', async () => {
    expect((await handleRequest(await diagRequest(), { ...env, PRESENCE_TICKET_SECRET: undefined })).status).toBe(503);
    const res = await handleRequest(await diagRequest({}, 'POST'), env);
    expect(res.status).toBe(405);
    expect(hubCalls).toHaveLength(0);
  });

  it('returns counts only: sockets, limits, counters, alarm and history, no keys or IP hashes', async () => {
    const watcher = socket('watcher-key', { c: false });
    const owner = socket('owner-key', { o: true });
    const a = socket('visitor-a');
    const b = socket('visitor-b');
    const idle = socket('visitor-idle');
    const flooder = socket('visitor-flood');
    await send(watcher, { t: 'sub' });
    await send(owner, { t: 'hb', cat: 'ai' });
    await send(a, { t: 'hb', cat: 'reading' });
    await send(b, { t: 'hb', cat: 'reading' });
    await send(idle, { t: 'idle' });
    for (let i = 0; i < 4 + MAX_STRIKES && !flooder.closed; i += 1) await send(flooder, '{"t":"nope"}');
    tick(2_000);
    state.alarmAt = null;
    await hub.alarm();

    const res = await handleRequest(await diagRequest({ Origin: ORIGIN }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const text = await res.text();
    const body: unknown = JSON.parse(text);
    expect(body).toMatchObject({
      v: 1,
      sockets: { total: 5, activeSessions: 2, idle: 1, watchOnly: 1, subscribers: 1, owner: 1 },
      limits: { maxTotal: MAX_SOCKETS_TOTAL, maxPerIp: MAX_SOCKETS_PER_IP, maxPerKey: MAX_SOCKETS_PER_KEY },
      counters: { startedAt: new Date(T0).toISOString(), connectsAccepted: 0, connectsRejected: 0, messagesDropped: MAX_STRIKES, abuseCloses: 1 },
      alarm: { lastRunAt: new Date(T0 + 2_000).toISOString(), lastRunMs: expect.any(Number) },
      history: { buckets: 1, oldest: new Date(T0).toISOString(), storageBytes: expect.any(Number) },
    });
    const keys = typeof body === 'object' && body !== null ? Object.keys(body).sort() : [];
    expect(keys).toEqual(['alarm', 'at', 'counters', 'history', 'limits', 'sockets', 'v']);
    const counters = typeof body === 'object' && body !== null && 'counters' in body ? body.counters : null;
    expect(counters).toMatchObject({ broadcasts: expect.any(Number) });
    for (const secret of ['watcher-key', 'owner-key', 'visitor-a', 'iphash', 'ipHash', '"k"', 'ticket']) expect(text).not.toContain(secret);
    expect(hubCalls).toEqual(['/diagnostics']);
  });
});
