import { describe, expect, test } from 'bun:test';
import { PRESENCE_CONTRACT_VERSION, type PresenceSnapshot } from '../src/lib/presence/contract';
import { createPresenceFeed, isFeedStale, type FeedSocket, type FeedState, type SocketHandlers } from '../src/lib/presence/presence-feed';
import { isPresenceSnapshot, parseServerFrame, parseTicketGrant } from '../src/lib/presence/presence-feed-guards';

const snap = (active: number, extra: Partial<PresenceSnapshot> = {}): PresenceSnapshot => ({
  v: PRESENCE_CONTRACT_VERSION,
  at: '2026-10-20T04:00:00.000Z',
  active,
  members: null,
  categories: [],
  owner: { status: 'offline', onSite: false, since: '2026-10-20T03:00:00.000Z' },
  ...extra,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const grant = { success: true, data: { ticket: 't k/1', url: 'wss://presence.test/v1/connect', expiresAt: '2026-10-20T04:02:00.000Z' } };

/** Lets queued promise continuations (fetch → json → connect) settle. */
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

interface Harness {
  feed: ReturnType<typeof createPresenceFeed>;
  states: FeedState[];
  sockets: Array<{ url: string; sent: string[]; closed: boolean; handlers: SocketHandlers }>;
  calls: string[];
}

function harness(routes: { snapshot: () => Response | Promise<Response>; ticket: () => Response | Promise<Response> }, now = () => Date.now()): Harness {
  const h: Harness = { feed: null as never, states: [], sockets: [], calls: [] };
  h.feed = createPresenceFeed({
    origin: 'https://presence.test',
    baseDelayMs: 5,
    maxDelayMs: 10,
    random: () => 0,
    now,
    fetchImpl: async (input) => {
      h.calls.push(input);
      return input.endsWith('/v1/snapshot') ? routes.snapshot() : routes.ticket();
    },
    openSocket: (url, handlers): FeedSocket => {
      const rec = { url, sent: [] as string[], closed: false, handlers };
      h.sockets.push(rec);
      return { send: (d) => { rec.sent.push(d); }, close: () => { rec.closed = true; } };
    },
  });
  return h;
}

describe('presence feed guards', () => {
  test('accepts a valid snapshot and rejects malformed ones', () => {
    expect(isPresenceSnapshot(snap(3, { members: 3, categories: [{ id: 'reading', count: 3 }] }))).toBe(true);
    expect(isPresenceSnapshot({ ...snap(1), active: -1 })).toBe(false);
    expect(isPresenceSnapshot({ ...snap(1), categories: [{ id: 'hacking', count: 3 }] })).toBe(false);
    expect(isPresenceSnapshot({ ...snap(1), v: 2 })).toBe(false);
    expect(isPresenceSnapshot(null)).toBe(false);
  });

  test('frames and ticket envelopes are validated', () => {
    expect(parseServerFrame(JSON.stringify({ t: 'snapshot', data: snap(2) }))?.t).toBe('snapshot');
    expect(parseServerFrame(JSON.stringify({ t: 'snapshot', data: { active: 'x' } }))).toBeNull();
    expect(parseServerFrame('not json')).toBeNull();
    expect(parseServerFrame(new ArrayBuffer(2))).toBeNull();
    expect(parseTicketGrant(grant)).toEqual({ ticket: 't k/1', url: 'wss://presence.test/v1/connect' });
    expect(parseTicketGrant({ success: true, data: { ticket: 'a', url: 'https://x' } })).toBeNull();
    expect(parseTicketGrant({ success: false })).toBeNull();
  });
});

describe('presence feed state machine', () => {
  test('snapshot over HTTP first, then the socket subscribes and goes live', async () => {
    const h = harness({ snapshot: () => json(snap(4)), ticket: () => json(grant) });
    const unsub = h.feed.subscribeFeed((s) => h.states.push(s));
    expect(h.feed.getFeedState().connection).toBe('connecting');
    await settle();

    expect(h.calls).toEqual(['https://presence.test/v1/snapshot', '/api/v1/presence/ticket']);
    expect(h.feed.getFeedState()).toMatchObject({ connection: 'connecting', snapshot: { active: 4 } });
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0].url).toBe('wss://presence.test/v1/connect?ticket=t%20k%2F1');

    h.sockets[0].handlers.onOpen();
    expect(h.sockets[0].sent).toEqual(['{"t":"sub"}']);
    h.sockets[0].handlers.onMessage(JSON.stringify({ t: 'snapshot', data: snap(7) }));
    expect(h.feed.getFeedState()).toMatchObject({ connection: 'live', snapshot: { active: 7 } });
    expect(h.feed.getFeedState().updatedAt).not.toBeNull();
    unsub();
  });

  test('503 from the snapshot endpoint is unavailable and never invents numbers', async () => {
    const h = harness({ snapshot: () => json({ success: false }, 503), ticket: () => json(grant) });
    const unsub = h.feed.subscribeFeed(() => undefined);
    await settle();
    expect(h.feed.getFeedState()).toMatchObject({ connection: 'unavailable', snapshot: null, updatedAt: null });
    expect(h.sockets).toHaveLength(0);
    unsub();
  });

  test('503 from the ticket endpoint is unavailable but keeps the HTTP snapshot', async () => {
    const h = harness({ snapshot: () => json(snap(2)), ticket: () => json({ success: false }, 503) });
    const unsub = h.feed.subscribeFeed(() => undefined);
    await settle();
    expect(h.feed.getFeedState()).toMatchObject({ connection: 'unavailable', snapshot: { active: 2 } });
    unsub();
  });

  test('a network failure before any data is offline, and it retries', async () => {
    let n = 0;
    const h = harness({
      snapshot: () => { if (n++ === 0) throw new TypeError('network'); return json(snap(1)); },
      ticket: () => json(grant),
    });
    const unsub = h.feed.subscribeFeed(() => undefined);
    await settle();
    expect(h.calls.filter((c) => c.endsWith('/v1/snapshot')).length).toBeGreaterThanOrEqual(2);
    expect(h.feed.getFeedState().snapshot?.active).toBe(1);
    unsub();
  });

  test('a socket closing after going live is reconnecting, then reconnects with a fresh ticket', async () => {
    const h = harness({ snapshot: () => json(snap(4)), ticket: () => json(grant) });
    const unsub = h.feed.subscribeFeed(() => undefined);
    await settle();
    h.sockets[0].handlers.onMessage(JSON.stringify({ t: 'snapshot', data: snap(5) }));
    h.sockets[0].handlers.onClose();
    expect(h.feed.getFeedState()).toMatchObject({ connection: 'reconnecting', snapshot: { active: 5 }, error: 'socket_closed' });
    await settle();
    expect(h.sockets).toHaveLength(2);
    expect(h.calls.filter((c) => c.endsWith('/ticket'))).toHaveLength(2);
    unsub();
  });

  test('invalid payloads are ignored and leave the state untouched', async () => {
    const h = harness({ snapshot: () => json(snap(4)), ticket: () => json(grant) });
    const unsub = h.feed.subscribeFeed(() => undefined);
    await settle();
    h.sockets[0].handlers.onMessage(JSON.stringify({ t: 'snapshot', data: { active: 'lots' } }));
    h.sockets[0].handlers.onMessage('garbage');
    expect(h.feed.getFeedState()).toMatchObject({ connection: 'connecting', snapshot: { active: 4 } });
    unsub();
  });

  test('an invalid HTTP snapshot is a failure, not data', async () => {
    const h = harness({ snapshot: () => json({ hello: 'world' }), ticket: () => json(grant) });
    const unsub = h.feed.subscribeFeed(() => undefined);
    await settle();
    expect(h.feed.getFeedState().snapshot).toBeNull();
    expect(h.sockets).toHaveLength(0);
    unsub();
  });

  test('one shared connection; the last unsubscribe closes the socket and resets state', async () => {
    const h = harness({ snapshot: () => json(snap(4)), ticket: () => json(grant) });
    const a = h.feed.subscribeFeed(() => undefined);
    const b = h.feed.subscribeFeed(() => undefined);
    await settle();
    expect(h.sockets).toHaveLength(1);
    a();
    expect(h.sockets[0].closed).toBe(false);
    b();
    b(); // idempotent
    expect(h.sockets[0].closed).toBe(true);
    expect(h.feed.getFeedState()).toMatchObject({ snapshot: null, connection: 'connecting' });
    await settle();
    expect(h.sockets).toHaveLength(1); // no reconnect after stop
  });

  test('a live feed with no update for over 60 s is stale', () => {
    const live: FeedState = { snapshot: snap(1), connection: 'live', updatedAt: 1_000 };
    expect(isFeedStale(live, 1_000 + 60_000)).toBe(false);
    expect(isFeedStale(live, 1_000 + 60_001)).toBe(true);
    expect(isFeedStale({ ...live, connection: 'reconnecting' }, 1_000 + 120_000)).toBe(false);
    expect(isFeedStale({ ...live, updatedAt: null }, 999_999)).toBe(false);
  });
});
