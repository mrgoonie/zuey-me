import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { PRESENCE_MAX_MESSAGE_BYTES, PRESENCE_TTL_MS, type PresenceServerMessage } from '../src/lib/presence/contract';
import { BROADCAST_MIN_INTERVAL_MS, KEEPALIVE_INTERVAL_MS, PresenceHub, SESSION_HEADER, SWEEP_INTERVAL_MS } from '../workers/presence/src/presence-hub';
import { CLOSE_POLICY, MAX_SOCKETS_PER_KEY, MAX_STRIKES, isSocketSession, newSession, type SessionIdentity } from '../workers/presence/src/presence-state';
import type { DurableObjectStateLike, HubWebSocket } from '../workers/presence/src/runtime-types';

const T0 = Date.parse('2026-10-20T04:00:00.000Z');
const MIN_GAP = 5_000;

class FakeSocket implements HubWebSocket {
  sent: PresenceServerMessage[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private attachment: unknown = null;
  send(data: string): void {
    if (this.closed) throw new Error('closed');
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }
  snapshots() {
    return this.sent.flatMap((m) => (m.t === 'snapshot' ? [m.data] : []));
  }
  errors() {
    return this.sent.flatMap((m) => (m.t === 'error' ? [m.code] : []));
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

let state: FakeState;
let hub: PresenceHub;
let now: number;

function tick(ms: number): void {
  now += ms;
  setSystemTime(new Date(now));
}

/** Adds a socket the way the hub's connect path does (accept with tags, then attach the session). */
function connect(k: string, over: Partial<SessionIdentity> = {}): FakeSocket {
  const id: SessionIdentity = { k, c: true, m: false, o: false, ipHash: `ip-${k}`, ...over };
  const ws = new FakeSocket();
  state.acceptWebSocket(ws, [`ip:${id.ipHash}`, `k:${id.k}`]);
  ws.serializeAttachment(newSession(id, now));
  return ws;
}

const send = (ws: FakeSocket, msg: unknown) => hub.webSocketMessage(ws, typeof msg === 'string' ? msg : JSON.stringify(msg));

/** Fires the pending alarm the way the runtime does: the alarm is consumed before the handler runs. */
async function fireAlarm(): Promise<void> {
  state.alarmAt = null;
  await hub.alarm();
}

beforeEach(() => {
  now = T0;
  setSystemTime(new Date(now));
  state = new FakeState();
  hub = new PresenceHub(state, { PRESENCE_HUB: { idFromName: () => ({ toString: () => 'x' }), get: () => ({ fetch: async () => new Response() }) } });
});

afterEach(() => {
  setSystemTime();
});

describe('PresenceHub', () => {
  it('sends a subscriber the snapshot immediately', async () => {
    const watcher = connect('w', { c: false });
    await send(watcher, { t: 'sub' });
    expect(watcher.snapshots()).toHaveLength(1);
    expect(watcher.snapshots()[0]?.active).toBe(0);
  });

  it('broadcasts changes to subscribers only, coalesced to one per 2 s via the alarm', async () => {
    const watcher = connect('w', { c: false });
    const bystander = connect('x', { c: false });
    await send(watcher, { t: 'sub' });
    tick(BROADCAST_MIN_INTERVAL_MS);

    const a = connect('a');
    await send(a, { t: 'hb', cat: 'reading' });
    expect(watcher.snapshots().at(-1)?.active).toBe(1);
    expect(bystander.sent).toHaveLength(0);

    const b = connect('b');
    tick(100);
    await send(b, { t: 'hb', cat: 'reading' });
    // Within the 2 s window: no push yet, an alarm is due at the end of the window.
    expect(watcher.snapshots().at(-1)?.active).toBe(1);
    expect(state.alarmAt).toBe(T0 + 2 * BROADCAST_MIN_INTERVAL_MS);

    tick(BROADCAST_MIN_INTERVAL_MS);
    await fireAlarm();
    expect(watcher.snapshots().at(-1)?.active).toBe(2);
    // Next: the subscriber keepalive, which comes before the oldest live session's TTL expiry.
    expect(state.alarmAt).toBe(now + KEEPALIVE_INTERVAL_MS);
  });

  it('does not push when the public snapshot is unchanged', async () => {
    const watcher = connect('w', { c: false });
    await send(watcher, { t: 'sub' });
    const a = connect('a');
    tick(BROADCAST_MIN_INTERVAL_MS);
    await send(a, { t: 'hb', cat: 'reading' });
    const pushes = watcher.snapshots().length;
    tick(25_000);
    await send(a, { t: 'hb', cat: 'reading' });
    await fireAlarm();
    expect(watcher.snapshots()).toHaveLength(pushes);
  });

  it('sweeps TTL expiry on the alarm and stops alarming once no sockets remain', async () => {
    const watcher = connect('w', { c: false });
    await send(watcher, { t: 'sub' });
    const a = connect('a');
    tick(BROADCAST_MIN_INTERVAL_MS);
    await send(a, { t: 'hb', cat: 'reading' });
    expect(watcher.snapshots().at(-1)?.active).toBe(1);

    tick(PRESENCE_TTL_MS + 1);
    await fireAlarm();
    expect(watcher.snapshots().at(-1)?.active).toBe(0);

    a.close();
    watcher.close();
    await fireAlarm();
    expect(state.alarmAt).toBeNull();
  });

  it('does not re-arm the alarm while sockets exist but none is live or subscribed', async () => {
    const a = connect('a');
    connect('b');
    expect(state.alarmAt).toBeNull(); // connecting alone arms nothing
    await send(a, { t: 'hb', cat: 'reading' });
    expect(state.alarmAt).toBe(now + PRESENCE_TTL_MS + 1); // a newly live session arms the sweep at its expiry
    tick(SWEEP_INTERVAL_MS);
    await send(a, { t: 'idle' });
    tick(PRESENCE_TTL_MS);
    await fireAlarm();
    expect(state.sockets.filter((s) => !s.ws.closed)).toHaveLength(2);
    expect(state.alarmAt).toBeNull();

    // A heartbeat from the now non-live session arms it again.
    tick(MIN_GAP);
    await send(a, { t: 'hb', cat: 'reading' });
    expect(state.alarmAt).toBe(now + PRESENCE_TTL_MS + 1);
  });

  it('arms the sweep at the oldest live heartbeat expiry, at least one sweep interval ahead', async () => {
    const a = connect('a');
    const b = connect('b');
    await send(a, { t: 'hb', cat: 'reading' });
    tick(30_000);
    await send(b, { t: 'hb', cat: 'reading' });
    tick(10_000);
    await fireAlarm();
    expect(state.alarmAt).toBe(T0 + PRESENCE_TTL_MS + 1);
    tick(PRESENCE_TTL_MS - 40_000 + 1);
    await fireAlarm();
    expect(state.alarmAt).toBe(T0 + 30_000 + PRESENCE_TTL_MS + 1); // a expired; b is next
  });

  it('sends subscribers a keepalive snapshot at most every 45 s, only while they exist', async () => {
    const watcher = connect('w', { c: false });
    await send(watcher, { t: 'sub' });
    expect(watcher.snapshots()).toHaveLength(1);
    expect(state.alarmAt).toBe(now + KEEPALIVE_INTERVAL_MS);

    tick(KEEPALIVE_INTERVAL_MS);
    await fireAlarm();
    expect(watcher.snapshots()).toHaveLength(2); // unchanged snapshot, still pushed
    expect(state.alarmAt).toBe(now + KEEPALIVE_INTERVAL_MS);

    tick(10_000);
    await fireAlarm(); // an early alarm (e.g. a coalesced broadcast) does not double the keepalive
    expect(watcher.snapshots()).toHaveLength(2);

    await send(watcher, { t: 'unsub' });
    tick(KEEPALIVE_INTERVAL_MS);
    await fireAlarm();
    expect(watcher.snapshots()).toHaveLength(2);
    expect(state.alarmAt).toBeNull();
  });

  it('upgrades with the presence subprotocol selected', async () => {
    class PairSocket extends FakeSocket {
      accept(): void {}
    }
    Object.assign(globalThis, { WebSocketPair: class { 0 = new PairSocket(); 1 = new PairSocket(); } });
    const identity: SessionIdentity = { k: 'k1', c: true, m: false, o: false, ipHash: 'ip' };
    let res: Response;
    try {
      res = await hub.fetch(new Request('https://hub/connect', { headers: { [SESSION_HEADER]: JSON.stringify(identity) } }));
    } finally {
      Reflect.deleteProperty(globalThis, 'WebSocketPair');
    }
    expect(res.status).toBe(101);
    expect(res.headers.get('Sec-WebSocket-Protocol')).toBe('zuey-presence.v1');
    expect(state.sockets).toHaveLength(1);
    expect(state.alarmAt).toBeNull();
  });

  it('drops a closed socket from the count', async () => {
    const watcher = connect('w', { c: false });
    await send(watcher, { t: 'sub' });
    const a = connect('a');
    tick(BROADCAST_MIN_INTERVAL_MS);
    await send(a, { t: 'hb', cat: 'reading' });
    tick(BROADCAST_MIN_INTERVAL_MS);
    await hub.webSocketClose(a, 1001, '', true);
    expect(a.closed?.code).toBe(1000);
    expect(watcher.snapshots().at(-1)?.active).toBe(0);
  });

  it('persists the owner status change time across a fresh hub instance', async () => {
    const owner = connect('owner', { o: true, m: true });
    await send(owner, { t: 'hb', cat: 'exploring' });
    const res = await hub.fetch(new Request('https://hub/snapshot'));
    const body: unknown = await res.json();
    expect(body).toMatchObject({ active: 0, owner: { status: 'online', onSite: true, since: new Date(T0).toISOString() } });

    tick(10_000);
    const revived = new PresenceHub(state, { PRESENCE_HUB: { idFromName: () => ({ toString: () => 'x' }), get: () => ({ fetch: async () => new Response() }) } });
    const again: unknown = await (await revived.fetch(new Request('https://hub/snapshot'))).json();
    expect(again).toMatchObject({ owner: { status: 'online', since: new Date(T0).toISOString() } });
  });

  it('answers oversize and invalid messages with bad_message', async () => {
    const a = connect('a');
    await send(a, `{"t":"idle","p":"${'x'.repeat(PRESENCE_MAX_MESSAGE_BYTES)}"}`);
    await send(a, '{"t":"hb","cat":"secret-page"}');
    expect(a.errors()).toEqual(['bad_message', 'bad_message']);
    const stored = a.deserializeAttachment();
    expect(isSocketSession(stored) && stored.lastHb).toBe(0);
  });

  it('rate-limits a flooding socket and closes it after repeated abuse', async () => {
    const a = connect('a');
    for (let i = 0; i < 4 + MAX_STRIKES; i += 1) await send(a, { t: 'idle' });
    expect(a.errors()).toContain('rate_limited');
    expect(a.closed?.code).toBe(CLOSE_POLICY);
  });

  it('caps sockets per key', () => {
    const id: SessionIdentity = { k: 'busy', c: true, m: false, o: false, ipHash: 'shared' };
    for (let i = 0; i < MAX_SOCKETS_PER_KEY; i += 1) connect('busy', { ipHash: `ip-${i}` });
    expect(hub.admits(id)).toBe(false);
    expect(hub.admits({ ...id, k: 'other' })).toBe(true);
  });

  it('rejects a connect request without a verified identity', async () => {
    const res = await hub.fetch(new Request('https://hub/connect', { headers: { 'X-Presence-Session': '{"k":""}' } }));
    expect(res.status).toBe(400);
  });
});
