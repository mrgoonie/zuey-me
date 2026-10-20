import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import {
  PRESENCE_HISTORY_BUCKETS, PRESENCE_HISTORY_BUCKET_MS, PRESENCE_TTL_MS,
  type ActivityCategory, type PresenceHistory, type PresenceServerMessage,
} from '../src/lib/presence/contract';
import { PresenceHub } from '../workers/presence/src/presence-hub';
import {
  HISTORY_STORAGE_KEY, HISTORY_WRITE_INTERVAL_MS, PresenceHistoryRecorder, bucketStart, windowStart,
} from '../workers/presence/src/presence-history';
import { newSession, type SessionIdentity } from '../workers/presence/src/presence-state';
import { isPresenceHistory } from '../workers/presence/src/snapshot-cache';
import type { DurableObjectStateLike, HubWebSocket, PresenceEnv } from '../workers/presence/src/runtime-types';

/** A bucket boundary, so offsets below land in predictable buckets. */
const T0 = Date.parse('2026-10-20T04:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Storage double that records every write. */
class FakeStorage {
  data = new Map<string, unknown>();
  puts: { key: string; at: number }[] = [];
  alarmAt: number | null = null;
  get = async (key: string): Promise<unknown> => structuredClone(this.data.get(key));
  put = async (key: string, value: unknown): Promise<void> => {
    this.puts.push({ key, at: Date.now() });
    this.data.set(key, structuredClone(value));
  };
  getAlarm = async (): Promise<number | null> => this.alarmAt;
  setAlarm = async (t: number): Promise<void> => {
    this.alarmAt = t;
  };
  historyPuts(): number[] {
    return this.puts.filter((p) => p.key === HISTORY_STORAGE_KEY).map((p) => p.at);
  }
}

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
  storage = new FakeStorage();
  acceptWebSocket(ws: HubWebSocket, tags: string[] = []): void {
    if (!(ws instanceof FakeSocket)) throw new Error('unexpected socket');
    this.sockets.push({ ws, tags });
  }
  getWebSockets(tag?: string): HubWebSocket[] {
    return this.sockets.filter((s) => !s.ws.closed && (tag === undefined || s.tags.includes(tag))).map((s) => s.ws);
  }
}

const ENV: PresenceEnv = { PRESENCE_HUB: { idFromName: () => ({ toString: () => 'x' }), get: () => ({ fetch: async () => new Response() }) } };

let now: number;

function tick(ms: number): void {
  now += ms;
  setSystemTime(new Date(now));
}

const many = (cat: ActivityCategory, n: number): ActivityCategory[] => Array.from({ length: n }, () => cat);

function bucketAt(h: PresenceHistory, t: number) {
  return h.buckets.find((b) => b.t === new Date(t).toISOString());
}

beforeEach(() => {
  now = T0;
  setSystemTime(new Date(now));
});

afterEach(() => {
  setSystemTime();
});

describe('PresenceHistoryRecorder', () => {
  it('tracks the peak per 5-minute bucket with the categories at the moment of the peak, and rolls over', async () => {
    const storage = new FakeStorage();
    const rec = new PresenceHistoryRecorder(storage);
    await rec.observe(now, many('reading', 2));
    tick(MIN);
    await rec.observe(now, [...many('reading', 3), 'ai']);
    tick(MIN);
    await rec.observe(now, many('ai', 3)); // lower than the peak: the bucket keeps the peak moment
    tick(3 * MIN); // next bucket
    await rec.observe(now, many('courses', 3));

    const h = await rec.toHistory(now);
    expect(bucketAt(h, T0)).toEqual({ t: new Date(T0).toISOString(), peak: 4, categories: [{ id: 'reading', count: 3 }, { id: 'other', count: 1 }] });
    expect(bucketAt(h, T0 + PRESENCE_HISTORY_BUCKET_MS)).toEqual({
      t: new Date(T0 + PRESENCE_HISTORY_BUCKET_MS).toISOString(), peak: 3, categories: [{ id: 'courses', count: 3 }],
    });
  });

  it('publishes 288 buckets oldest first ending with the current bucket, gaps filled with peak 0', async () => {
    const rec = new PresenceHistoryRecorder(new FakeStorage());
    await rec.observe(now, many('reading', 3));
    tick(2 * 60 * MIN + 2 * MIN); // two hours later, mid-bucket
    const h = await rec.toHistory(now);
    expect(h).toMatchObject({ v: 1, bucketMinutes: 5, at: new Date(now).toISOString() });
    expect(h.buckets).toHaveLength(PRESENCE_HISTORY_BUCKETS);
    expect(h.buckets[0]?.t).toBe(new Date(windowStart(now)).toISOString());
    expect(h.buckets.at(-1)?.t).toBe(new Date(bucketStart(now)).toISOString());
    for (let i = 1; i < h.buckets.length; i += 1) {
      expect(Date.parse(h.buckets[i]?.t ?? '') - Date.parse(h.buckets[i - 1]?.t ?? '')).toBe(PRESENCE_HISTORY_BUCKET_MS);
    }
    expect(h.buckets.filter((b) => b.peak > 0)).toHaveLength(1);
    expect(h.buckets.at(-1)).toMatchObject({ peak: 0, categories: [] });
  });

  it('suppresses small groups: categories under 3 fold into other, and a peak under 3 has no breakdown', async () => {
    const rec = new PresenceHistoryRecorder(new FakeStorage());
    await rec.observe(now, ['reading', 'ai']);
    tick(PRESENCE_HISTORY_BUCKET_MS);
    await rec.observe(now, [...many('reading', 3), 'ai', 'ai']);
    const h = await rec.toHistory(now);
    expect(bucketAt(h, T0)).toMatchObject({ peak: 2, categories: [] });
    expect(bucketAt(h, T0 + PRESENCE_HISTORY_BUCKET_MS)?.categories).toEqual([{ id: 'reading', count: 3 }, { id: 'other', count: 2 }]);
  });

  it('records nothing while nobody is live', async () => {
    const storage = new FakeStorage();
    const rec = new PresenceHistoryRecorder(storage);
    for (let i = 0; i < 10; i += 1) {
      await rec.observe(now, []);
      tick(PRESENCE_HISTORY_BUCKET_MS);
    }
    expect(storage.historyPuts()).toHaveLength(0);
    expect(rec.flushDueAt()).toBeNull();
    expect(await rec.stats(now)).toEqual({ buckets: 0, oldest: null, storageBytes: 0 });
  });

  it('writes at most once a minute under steady traffic, and only when something changed', async () => {
    const storage = new FakeStorage();
    const rec = new PresenceHistoryRecorder(storage);
    // One hour, an observation every 10 s with a peak that keeps rising.
    for (let i = 0; i < 360; i += 1) {
      await rec.observe(now, many('reading', 1 + i));
      tick(10_000);
    }
    const writes = storage.historyPuts();
    expect(writes.length).toBeLessThanOrEqual(60);
    for (let i = 1; i < writes.length; i += 1) expect((writes[i] ?? 0) - (writes[i - 1] ?? 0)).toBeGreaterThanOrEqual(HISTORY_WRITE_INTERVAL_MS);

    // A steady, unchanged count costs one write per new bucket at most.
    const before = storage.historyPuts().length;
    for (let i = 0; i < 360; i += 1) {
      await rec.observe(now, many('reading', 3));
      tick(10_000);
    }
    expect(storage.historyPuts().length - before).toBeLessThanOrEqual(13);
  });

  it('survives eviction: a new recorder over the same storage reads the history and keeps the write throttle', async () => {
    const storage = new FakeStorage();
    const first = new PresenceHistoryRecorder(storage);
    await first.observe(now, many('reads', 5));
    tick(PRESENCE_HISTORY_BUCKET_MS);
    await first.observe(now, many('reads', 3));
    expect(storage.historyPuts()).toHaveLength(2);

    tick(10_000);
    const revived = new PresenceHistoryRecorder(storage);
    expect(bucketAt(await revived.toHistory(now), T0)).toMatchObject({ peak: 5, categories: [{ id: 'reads', count: 5 }] });
    await revived.observe(now, many('reads', 4)); // higher peak, but the last write was 10 s ago
    expect(storage.historyPuts()).toHaveLength(2);
    expect(revived.flushDueAt()).toBe(now - 10_000 + HISTORY_WRITE_INTERVAL_MS);
    expect(bucketAt(await revived.toHistory(now), T0 + PRESENCE_HISTORY_BUCKET_MS)?.peak).toBe(4); // unwritten peak is still served
  });

  it('prunes buckets older than 24 h from storage and output', async () => {
    const storage = new FakeStorage();
    const rec = new PresenceHistoryRecorder(storage);
    await rec.observe(now, many('ai', 3));
    tick(DAY);
    await rec.observe(now, many('ai', 4));
    const stored: unknown = storage.data.get(HISTORY_STORAGE_KEY);
    const tuples = typeof stored === 'object' && stored !== null && 'b' in stored && Array.isArray(stored.b) ? stored.b : [];
    expect(tuples.map((t: unknown) => (Array.isArray(t) ? t[0] : null))).toEqual([T0 + DAY]);
    const h = await rec.toHistory(now);
    expect(h.buckets.filter((b) => b.peak > 0).map((b) => b.peak)).toEqual([4]);
    expect(Date.parse(h.buckets[0]?.t ?? '')).toBeGreaterThan(T0);
  });

  it('ignores malformed stored history', async () => {
    const storage = new FakeStorage();
    storage.data.set(HISTORY_STORAGE_KEY, { savedAt: 'x', b: 'nope' });
    const rec = new PresenceHistoryRecorder(storage);
    const h = await rec.toHistory(now);
    expect(h.buckets.every((b) => b.peak === 0)).toBe(true);
  });
});

describe('PresenceHub history', () => {
  let state: FakeState;
  let hub: PresenceHub;

  function connect(k: string, over: Partial<SessionIdentity> = {}): FakeSocket {
    const id: SessionIdentity = { k, c: true, m: false, o: false, ipHash: `ip-${k}`, ...over };
    const ws = new FakeSocket();
    state.acceptWebSocket(ws, [`ip:${id.ipHash}`, `k:${id.k}`]);
    ws.serializeAttachment(newSession(id, now));
    return ws;
  }
  const send = (ws: FakeSocket, msg: unknown) => hub.webSocketMessage(ws, JSON.stringify(msg));
  async function fireAlarm(): Promise<void> {
    state.storage.alarmAt = null;
    await hub.alarm();
  }
  async function readHistory(h: PresenceHub): Promise<PresenceHistory> {
    const body: unknown = await (await h.fetch(new Request('https://hub/history'))).json();
    if (!isPresenceHistory(body)) throw new Error('not a history');
    return body;
  }

  beforeEach(() => {
    state = new FakeState();
    hub = new PresenceHub(state, ENV);
  });

  it('writes the final peak when activity ends, then arms no alarm while idle', async () => {
    const a = connect('a');
    const b = connect('b');
    await send(a, { t: 'hb', cat: 'reading' });
    expect(state.storage.historyPuts()).toHaveLength(1); // first observation of the bucket is written at once
    tick(10_000);
    await send(b, { t: 'hb', cat: 'reading' }); // peak 2, throttled
    expect(state.storage.historyPuts()).toHaveLength(1);

    tick(5_000);
    await send(a, { t: 'idle' });
    await send(b, { t: 'idle' });
    // Drain alarms the way the runtime would until none is armed.
    for (let i = 0; i < 10 && state.storage.alarmAt !== null; i += 1) {
      tick(Math.max(0, state.storage.alarmAt - now));
      await fireAlarm();
    }
    expect(state.storage.alarmAt).toBeNull();
    expect(state.storage.historyPuts()).toHaveLength(2);
    expect(bucketAt(await readHistory(new PresenceHub(state, ENV)), T0)?.peak).toBe(2);

    // Idle sockets stay open: hours pass with no writes and no alarm.
    tick(3 * 60 * MIN);
    await hub.fetch(new Request('https://hub/snapshot'));
    expect(state.storage.historyPuts()).toHaveLength(2);
    expect(state.storage.alarmAt).toBeNull();
  });

  it('keeps the history across eviction and counts only consented non-owner visitors', async () => {
    connect('w', { c: false });
    const owner = connect('o', { o: true });
    const a = connect('a');
    await send(owner, { t: 'hb', cat: 'ai' });
    await send(a, { t: 'hb', cat: 'courses' });
    tick(2_000);
    await fireAlarm(); // the coalesced refresh observes the second heartbeat
    const revived = new PresenceHub(state, ENV);
    const h = await readHistory(revived);
    expect(h.buckets).toHaveLength(PRESENCE_HISTORY_BUCKETS);
    expect(bucketAt(h, T0)).toMatchObject({ peak: 1, categories: [] });
  });

  it('records the sweep that ends a session without keeping an alarm for history', async () => {
    const a = connect('a');
    await send(a, { t: 'hb', cat: 'reading' });
    tick(PRESENCE_TTL_MS + 1);
    await fireAlarm();
    expect(state.storage.alarmAt).toBeNull();
    expect(state.storage.historyPuts()).toHaveLength(1);
  });
});
