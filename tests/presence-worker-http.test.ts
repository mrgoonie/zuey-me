import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { PRESENCE_TICKET_TTL_MS, type PresenceSnapshot, type PresenceTicketPayload } from '../src/lib/presence/contract';
import { signPresenceTicket, verifyPresenceTicket } from '../src/lib/presence/ticket';
import worker, { handleRequest, ticketFromProtocols } from '../workers/presence/src/index';
import { SNAPSHOT_CACHE_PATH, SNAPSHOT_MAX_STALE_MS, SNAPSHOT_MEMO_MS, resetSnapshotCache } from '../workers/presence/src/snapshot-cache';
import type { DurableObjectNamespaceLike, EdgeCacheLike, PresenceEnv } from '../workers/presence/src/runtime-types';

const SECRET = 'test-presence-secret';
const ORIGIN = 'https://zuey.me';

const SNAPSHOT: PresenceSnapshot = {
  v: 1, at: '2026-10-20T04:00:00.000Z', active: 4, members: null, categories: [{ id: 'reading', count: 4 }],
  owner: { status: 'offline', onSite: false, since: '2026-10-20T03:00:00.000Z' },
};

function payload(over: Partial<PresenceTicketPayload> = {}): PresenceTicketPayload {
  return { k: 'opaque-key', c: true, m: false, o: false, exp: Date.now() + 60_000, n: 'nonce-1', ...over };
}

/** Namespace double that records requests forwarded to the hub. */
function hubNamespace(handler: (req: Request) => Promise<Response>): { ns: DurableObjectNamespaceLike; seen: Request[]; names: string[] } {
  const seen: Request[] = [];
  const names: string[] = [];
  const ns: DurableObjectNamespaceLike = {
    idFromName: (name) => {
      names.push(name);
      return { toString: () => name };
    },
    get: () => ({
      fetch: async (req) => {
        seen.push(req);
        return handler(req);
      },
    }),
  };
  return { ns, seen, names };
}

function env(over: Partial<PresenceEnv> = {}, handler = async () => Response.json(SNAPSHOT)) {
  const hub = hubNamespace(handler);
  return { env: { PRESENCE_HUB: hub.ns, PRESENCE_TICKET_SECRET: SECRET, ...over }, hub };
}

/** A browser handshake: `new WebSocket(url, ['zuey-presence.v1', ticket])`. */
function connectRequest(ticket: string, headers: Record<string, string> = {}): Request {
  return new Request('https://presence.zuey.me/v1/connect', {
    headers: {
      Origin: ORIGIN, Upgrade: 'websocket', 'CF-Connecting-IP': '203.0.113.7', Cookie: 'zuey_session=abc',
      'Sec-WebSocket-Protocol': `zuey-presence.v1, ${ticket}`, ...headers,
    },
  });
}

let clock = Date.parse('2026-10-20T04:00:00.000Z');
const advance = (ms: number) => {
  clock += ms;
  setSystemTime(new Date(clock));
};

beforeEach(() => {
  resetSnapshotCache();
  setSystemTime(new Date(clock));
});

afterEach(() => {
  setSystemTime();
  Reflect.deleteProperty(globalThis, 'caches');
});

async function errorCode(res: Response): Promise<string> {
  const body: unknown = await res.json();
  if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'object' && body.error !== null && 'code' in body.error && typeof body.error.code === 'string') {
    return body.error.code;
  }
  throw new Error('not an error envelope');
}

describe('presence tickets', () => {
  it('accepts a valid ticket', async () => {
    const t = await signPresenceTicket(SECRET, payload());
    expect(await verifyPresenceTicket(SECRET, t)).toMatchObject({ k: 'opaque-key', c: true });
  });

  it('rejects a ticket signed with another secret', async () => {
    expect(await verifyPresenceTicket(SECRET, await signPresenceTicket('forged', payload()))).toBeNull();
  });

  it('rejects expired tickets and tickets issued too far ahead', async () => {
    expect(await verifyPresenceTicket(SECRET, await signPresenceTicket(SECRET, payload({ exp: Date.now() - 1 })))).toBeNull();
    expect(await verifyPresenceTicket(SECRET, await signPresenceTicket(SECRET, payload({ exp: Date.now() + PRESENCE_TICKET_TTL_MS * 10 })))).toBeNull();
  });

  it('rejects a tampered payload and malformed tickets', async () => {
    const t = await signPresenceTicket(SECRET, payload());
    const [, sig] = t.split('.');
    const forgedBody = btoa(JSON.stringify(payload({ o: true }))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await verifyPresenceTicket(SECRET, `${forgedBody}.${sig}`)).toBeNull();
    expect(await verifyPresenceTicket(SECRET, `${t}.extra`)).toBeNull();
    expect(await verifyPresenceTicket(SECRET, 'garbage')).toBeNull();
  });
});

describe('presence worker routes', () => {
  it('answers health and 404s everything else', async () => {
    const { env: e } = env();
    expect((await handleRequest(new Request('https://presence.zuey.me/v1/health'), e)).status).toBe(200);
    const res = await handleRequest(new Request('https://presence.zuey.me/internal/state'), e);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
  });

  it('serves the snapshot with CORS for allowed origins and a 5 s cache', async () => {
    const { env: e, hub } = env();
    const res = await handleRequest(new Request('https://presence.zuey.me/v1/snapshot', { headers: { Origin: ORIGIN } }), e);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=5');
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(await res.json()).toEqual(SNAPSHOT);
    expect(hub.names).toEqual(['global']);
  });

  it('serves the snapshot without CORS headers to server-side callers and refuses foreign origins', async () => {
    const { env: e } = env();
    const plain = await handleRequest(new Request('https://presence.zuey.me/v1/snapshot'), e);
    expect(plain.status).toBe(200);
    expect(plain.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const foreign = await handleRequest(new Request('https://presence.zuey.me/v1/snapshot', { headers: { Origin: 'https://evil.example' } }), e);
    expect(foreign.status).toBe(403);
  });

  it('falls back to the last known snapshot when the hub fails, without leaking details, for at most 5 minutes', async () => {
    const { env: ok } = env();
    await handleRequest(new Request('https://presence.zuey.me/v1/snapshot'), ok);
    const { env: broken, hub } = env({}, async () => {
      throw new Error('internal stack detail');
    });
    advance(SNAPSHOT_MEMO_MS);
    const res = await handleRequest(new Request('https://presence.zuey.me/v1/snapshot'), broken);
    expect(hub.seen).toHaveLength(1);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('internal stack detail');
    expect(JSON.parse(text)).toEqual(SNAPSHOT);

    advance(SNAPSHOT_MAX_STALE_MS);
    const tooOld = await handleRequest(new Request('https://presence.zuey.me/v1/snapshot', { headers: { Origin: ORIGIN } }), broken);
    expect(tooOld.status).toBe(503);
    expect(tooOld.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(await errorCode(tooOld)).toBe('unavailable');
  });

  it('a burst of snapshot requests reaches the hub once, and CORS stays per request', async () => {
    const { env: e, hub } = env();
    const origins = [ORIGIN, 'https://www.zuey.me', null];
    const responses = await Promise.all(Array.from({ length: 30 }, (_, i) => {
      const origin = origins[i % origins.length];
      return handleRequest(new Request('https://presence.zuey.me/v1/snapshot', { headers: origin ? { Origin: origin } : {} }), e);
    }));
    expect(hub.seen).toHaveLength(1);
    responses.forEach((res, i) => {
      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origins[i % origins.length]);
      expect(res.headers.get('Vary')).toBe('Origin');
    });
    advance(SNAPSHOT_MEMO_MS - 1);
    await handleRequest(new Request('https://presence.zuey.me/v1/snapshot'), e);
    expect(hub.seen).toHaveLength(1);
    advance(1);
    await handleRequest(new Request('https://presence.zuey.me/v1/snapshot'), e);
    expect(hub.seen).toHaveLength(2);
  });

  it('shares snapshots across isolates through the edge cache under a fixed internal key', async () => {
    const stored = new Map<string, string>();
    const edge: EdgeCacheLike = {
      match: async (req) => {
        const body = stored.get(req.url);
        return body === undefined ? undefined : new Response(body);
      },
      put: async (req, res) => {
        expect(res.headers.get('Cache-Control')).toBe('public, max-age=5');
        expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
        stored.set(req.url, await res.text());
      },
    };
    Object.assign(globalThis, { caches: { default: edge } });
    const { env: e, hub } = env();
    await handleRequest(new Request('https://presence.zuey.me/v1/snapshot', { headers: { Origin: ORIGIN } }), e);
    expect([...stored.keys()]).toEqual([`https://presence.zuey.me${SNAPSHOT_CACHE_PATH}`]);

    resetSnapshotCache(); // a second, cold isolate in the same colo
    const res = await handleRequest(new Request('https://presence.zuey.me/v1/snapshot', { headers: { Origin: 'https://www.zuey.me' } }), e);
    expect(hub.seen).toHaveLength(1);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://www.zuey.me');
    expect(await res.json()).toEqual(SNAPSHOT);
  });

  it('allows the local dev origins only when PRESENCE_DEV_ORIGINS=1', async () => {
    const dev = new Request('https://presence.zuey.me/v1/snapshot', { headers: { Origin: 'http://localhost:4321' } });
    expect((await handleRequest(dev, env().env)).status).toBe(403);
    const res = await handleRequest(dev, env({ PRESENCE_DEV_ORIGINS: '1' }).env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:4321');
    const t = await signPresenceTicket(SECRET, payload());
    expect((await handleRequest(connectRequest(t, { Origin: 'http://127.0.0.1:4321' }), env().env)).status).toBe(403);
  });

  it('returns 503 for connect when the ticket secret is missing', async () => {
    const { env: e } = env({ PRESENCE_TICKET_SECRET: undefined });
    const res = await handleRequest(connectRequest('x'), e);
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe('unavailable');
  });

  it('refuses connects from foreign or missing origins', async () => {
    const { env: e, hub } = env();
    const t = await signPresenceTicket(SECRET, payload());
    expect((await handleRequest(connectRequest(t, { Origin: 'https://evil.example' }), e)).status).toBe(403);
    const noOrigin = new Request('https://presence.zuey.me/v1/connect', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `zuey-presence.v1, ${t}` } });
    expect((await handleRequest(noOrigin, e)).status).toBe(403);
    expect(hub.seen).toHaveLength(0);
  });

  it('rejects forged, expired and tampered tickets with 401 before upgrading', async () => {
    const { env: e, hub } = env();
    const forged = await signPresenceTicket('wrong-secret', payload());
    const expired = await signPresenceTicket(SECRET, payload({ exp: Date.now() - 1_000 }));
    const valid = await signPresenceTicket(SECRET, payload());
    for (const t of [forged, expired, `${valid}x`, '']) {
      const res = await handleRequest(connectRequest(t), e);
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe('unauthorized');
    }
    expect(hub.seen).toHaveLength(0);
  });

  it('reads the ticket only from the subprotocol header; a query-string ticket is refused', async () => {
    const { env: e, hub } = env();
    const t = await signPresenceTicket(SECRET, payload());
    const query = new Request(`https://presence.zuey.me/v1/connect?ticket=${t}`, { headers: { Origin: ORIGIN, Upgrade: 'websocket' } });
    expect((await handleRequest(query, e)).status).toBe(401);
    const withoutProtocolName = connectRequest(t, { 'Sec-WebSocket-Protocol': t });
    expect((await handleRequest(withoutProtocolName, e)).status).toBe(401);
    expect(hub.seen).toHaveLength(0);
    expect(ticketFromProtocols(`zuey-presence.v1,${t}`)).toBe(t);
    expect(ticketFromProtocols(`${t}, zuey-presence.v1`)).toBe(t);
    expect(ticketFromProtocols(`zuey-presence.v1, ${t}, other`)).toBe('');
    expect(ticketFromProtocols(null)).toBe('');
  });

  it('collapses IPv6 clients to their /64 for the hub IP hash (IPv4 unchanged)', async () => {
    const { env: e, hub } = env({}, async () => new Response('upgraded'));
    const t = await signPresenceTicket(SECRET, payload());
    for (const ip of ['2001:db8:1:2::1', '2001:0db8:0001:0002:ffff:aaaa:bbbb:cccc', '2001:db8:1:3::1', '203.0.113.7', '203.0.113.8']) {
      await handleRequest(connectRequest(t, { 'CF-Connecting-IP': ip }), e);
    }
    const hashes = hub.seen.map((req) => {
      const session: unknown = JSON.parse(req.headers.get('X-Presence-Session') ?? '');
      return typeof session === 'object' && session !== null && 'ipHash' in session ? session.ipHash : null;
    });
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
    expect(hashes[3]).not.toBe(hashes[4]);
  });

  it('requires a WebSocket upgrade', async () => {
    const { env: e } = env();
    const t = await signPresenceTicket(SECRET, payload());
    expect((await handleRequest(connectRequest(t, { Upgrade: 'h2c' }), e)).status).toBe(426);
  });

  it('forwards only the verified identity and an IP hash to the hub', async () => {
    const { env: e, hub } = env({}, async () => new Response('upgraded'));
    const t = await signPresenceTicket(SECRET, payload({ m: true }));
    const res = await handleRequest(connectRequest(t, { 'X-Presence-Session': '{"k":"spoof","c":true,"m":true,"o":true,"ipHash":"x"}' }), e);
    expect(await res.text()).toBe('upgraded');
    const forwarded = hub.seen[0];
    if (!forwarded) throw new Error('nothing forwarded');
    expect(new URL(forwarded.url).pathname).toBe('/connect');
    expect(forwarded.headers.get('Cookie')).toBeNull();
    expect(forwarded.headers.get('Sec-WebSocket-Protocol')).toBeNull();
    const session: unknown = JSON.parse(forwarded.headers.get('X-Presence-Session') ?? '');
    expect(session).toMatchObject({ k: 'opaque-key', c: true, m: true, o: false });
    expect(typeof session === 'object' && session !== null ? Object.keys(session).sort() : []).toEqual(['c', 'ipHash', 'k', 'm', 'o']);
    expect(JSON.stringify(session)).not.toContain('203.0.113.7');
  });

  it('the default export never throws to the runtime', async () => {
    const { env: e } = env();
    const res = await worker.fetch(new Request('https://presence.zuey.me/v1/health'), e);
    expect(res.status).toBe(200);
  });
});
