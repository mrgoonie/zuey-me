import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import {
  OWNER_STATUS_TEXT_MAX, PRESENCE_INTERNAL_HEADER, PRESENCE_INTERNAL_LABEL, PRESENCE_INTERNAL_MAX_SKEW_MS, PRESENCE_TTL_MS,
  type OwnerStatusState, type PresenceServerMessage, type PresenceSnapshot, type PresenceTicketPayload,
} from '../src/lib/presence/contract';
import { hmacBase64Url, signPresenceTicket } from '../src/lib/presence/ticket';
import { signPresenceInternal } from '../src/lib/presence/internal-auth';
import { handleRequest } from '../workers/presence/src/index';
import { INTERNAL_MAX_BODY_BYTES } from '../workers/presence/src/internal-owner-route';
import { BROADCAST_MIN_INTERVAL_MS, PresenceHub } from '../workers/presence/src/presence-hub';
import { newSession, type SessionIdentity } from '../workers/presence/src/presence-state';
import { isPresenceSnapshot, resetSnapshotCache } from '../workers/presence/src/snapshot-cache';
import type { DurableObjectStateLike, HubWebSocket, PresenceEnv } from '../workers/presence/src/runtime-types';

const SECRET = 'test-presence-secret';
const T0 = Date.parse('2026-10-20T04:00:00.000Z');
const URL_OWNER = 'https://presence.zuey.me/internal/owner';

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
  snapshots(): PresenceSnapshot[] {
    return this.sent.flatMap((m) => (m.t === 'snapshot' ? [m.data] : []));
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
let env: PresenceEnv;
let internalToken: string;

function tick(ms: number): void {
  now += ms;
  setSystemTime(new Date(now));
}

/** The Worker wired to a real PresenceHub over the fake DO state. */
function makeEnv(over: Partial<PresenceEnv> = {}): PresenceEnv {
  return {
    PRESENCE_HUB: { idFromName: (n) => ({ toString: () => n }), get: () => ({ fetch: (req) => hub.fetch(req) }) },
    PRESENCE_TICKET_SECRET: SECRET,
    ...over,
  };
}

function socket(k: string, over: Partial<SessionIdentity> = {}): FakeSocket {
  const id: SessionIdentity = { k, c: true, m: false, o: false, ipHash: `ip-${k}`, ...over };
  const ws = new FakeSocket();
  state.acceptWebSocket(ws, [`ip:${id.ipHash}`, `k:${id.k}`]);
  ws.serializeAttachment(newSession(id, now));
  return ws;
}

const message = (ws: FakeSocket, msg: unknown) => hub.webSocketMessage(ws, JSON.stringify(msg));

async function fireAlarm(): Promise<void> {
  state.alarmAt = null;
  await hub.alarm();
}

function ownerRequest(method: 'GET' | 'PUT' | 'POST' | 'OPTIONS', body?: unknown, headers: Record<string, string> = { [PRESENCE_INTERNAL_HEADER]: internalToken }): Request {
  return new Request(URL_OWNER, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function isOwnerState(v: unknown): v is OwnerStatusState {
  return typeof v === 'object' && v !== null && 'mode' in v && 'public' in v && 'connected' in v && 'updatedAt' in v && 'text' in v;
}

async function put(body: unknown): Promise<OwnerStatusState> {
  const res = await handleRequest(ownerRequest('PUT', body), env);
  expect(res.status).toBe(200);
  const json: unknown = await res.json();
  if (!isOwnerState(json)) throw new Error('not an owner state');
  return json;
}

async function getState(): Promise<OwnerStatusState> {
  const res = await handleRequest(ownerRequest('GET'), env);
  expect(res.status).toBe(200);
  const json: unknown = await res.json();
  if (!isOwnerState(json)) throw new Error('not an owner state');
  return json;
}

async function hubSnapshot(): Promise<PresenceSnapshot> {
  const res = await hub.fetch(new Request('https://presence-hub.internal/snapshot'));
  const json: unknown = await res.json();
  if (!isPresenceSnapshot(json)) throw new Error('not a snapshot');
  return json;
}

async function errorCode(res: Response): Promise<string> {
  const body: unknown = await res.json();
  if (typeof body === 'object' && body !== null && 'success' in body && body.success === false && 'error' in body
    && typeof body.error === 'object' && body.error !== null && 'code' in body.error && typeof body.error.code === 'string') {
    return body.error.code;
  }
  throw new Error('not an error envelope');
}

beforeEach(async () => {
  now = T0;
  setSystemTime(new Date(now));
  resetSnapshotCache();
  state = new FakeState();
  env = makeEnv();
  hub = new PresenceHub(state, env);
  internalToken = await signPresenceInternal(SECRET, now);
});

afterEach(() => {
  setSystemTime();
});

describe('/internal/owner authentication', () => {
  it('answers 404 without the internal header, with a wrong one, or one signed with another secret; state stays unchanged', async () => {
    const seconds = Math.floor(now / 1000);
    const forged = await signPresenceInternal('another-secret', now);
    const wrongLabel = `${seconds}.${await hmacBase64Url(SECRET, `presence-internal:v0:${seconds}`)}`;
    const legacyStatic = await hmacBase64Url(SECRET, PRESENCE_INTERNAL_LABEL);
    const sig = internalToken.split('.')[1] ?? '';
    const attempts: Record<string, string>[] = [{}, { [PRESENCE_INTERNAL_HEADER]: forged }, { [PRESENCE_INTERNAL_HEADER]: wrongLabel },
      { [PRESENCE_INTERNAL_HEADER]: legacyStatic }, { [PRESENCE_INTERNAL_HEADER]: `${seconds + 1}.${sig}` },
      { [PRESENCE_INTERNAL_HEADER]: `${internalToken}x` }, { [PRESENCE_INTERNAL_HEADER]: internalToken.slice(0, -1) },
      { [PRESENCE_INTERNAL_HEADER]: `-${internalToken}` }, { [PRESENCE_INTERNAL_HEADER]: `${seconds}.${sig}.x` },
      { [PRESENCE_INTERNAL_HEADER]: 'x'.repeat(5000) }, { Authorization: `Bearer ${internalToken}` }];
    for (const headers of attempts) {
      for (const method of ['GET', 'PUT', 'OPTIONS'] as const) {
        const res = await handleRequest(ownerRequest(method, method === 'PUT' ? { mode: 'busy', text: 'pwned' } : undefined, headers), env);
        expect(res.status).toBe(404);
        expect(await errorCode(res)).toBe('not_found');
        expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
      }
    }
    expect(state.data.has('ownerSetting')).toBe(false);
    const s = await getState();
    expect(s.mode).toBe('auto');
    expect(s.text).toBeNull();
  });

  it('accepts the header only within the allowed clock skew, in either direction', async () => {
    const at = async (offsetMs: number) => {
      const headers = { [PRESENCE_INTERNAL_HEADER]: await signPresenceInternal(SECRET, now + offsetMs) };
      return (await handleRequest(ownerRequest('GET', undefined, headers), env)).status;
    };
    expect(await at(0)).toBe(200);
    expect(await at(-PRESENCE_INTERNAL_MAX_SKEW_MS + 1_000)).toBe(200);
    expect(await at(PRESENCE_INTERNAL_MAX_SKEW_MS - 1_000)).toBe(200);
    expect(await at(-PRESENCE_INTERNAL_MAX_SKEW_MS - 1_000)).toBe(404);
    expect(await at(PRESENCE_INTERNAL_MAX_SKEW_MS + 1_000)).toBe(404);
    // A once-valid header replayed after the window is refused.
    const captured = await signPresenceInternal(SECRET, now);
    setSystemTime(new Date(now + PRESENCE_INTERNAL_MAX_SKEW_MS + 2_000));
    expect((await handleRequest(ownerRequest('GET', undefined, { [PRESENCE_INTERNAL_HEADER]: captured }), env)).status).toBe(404);
  });

  it('answers 503 when the ticket secret is missing, even with a header', async () => {
    env = makeEnv({ PRESENCE_TICKET_SECRET: undefined });
    const res = await handleRequest(ownerRequest('PUT', { mode: 'busy' }), env);
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe('unavailable');
    expect(state.data.has('ownerSetting')).toBe(false);
  });

  it('sends no CORS headers and is not cacheable', async () => {
    const res = await handleRequest(new Request(URL_OWNER, { headers: { [PRESENCE_INTERNAL_HEADER]: internalToken, Origin: 'https://zuey.me' } }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('refuses other methods once authenticated', async () => {
    const res = await handleRequest(ownerRequest('POST', { mode: 'busy' }), env);
    expect(res.status).toBe(405);
  });
});

describe('/internal/owner validation', () => {
  it('rejects invalid modes, text and JSON with 400 and leaves state unchanged', async () => {
    for (const body of [{ mode: 'online' }, { mode: 'invisible ' }, { text: 'hi' }, { mode: 'away', text: 7 },
      { mode: 'away', text: 'x'.repeat(OWNER_STATUS_TEXT_MAX + 1) }, '{"mode":', '[]', 'null', '']) {
      const res = await handleRequest(ownerRequest('PUT', body), env);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('bad_request');
    }
    expect(state.data.has('ownerSetting')).toBe(false);
  });

  it('rejects bodies over 1 KB with 413', async () => {
    const res = await handleRequest(ownerRequest('PUT', { mode: 'away', text: 'x', pad: 'y'.repeat(INTERNAL_MAX_BODY_BYTES) }), env);
    expect(res.status).toBe(413);
    expect(state.data.has('ownerSetting')).toBe(false);
  });

  it('stores sanitized text and returns the owner state', async () => {
    const s = await put({ mode: 'busy', text: '  Recording\na video  ' });
    expect(s).toEqual({
      mode: 'busy', text: 'Recording a video', updatedAt: new Date(T0).toISOString(), connected: false,
      public: { status: 'busy', onSite: false, text: 'Recording a video', since: new Date(T0).toISOString() },
    });
    tick(1_000);
    expect(await getState()).toEqual(s);
  });
});

describe('owner status through the hub', () => {
  it('auto flips online/offline with the owner connection and its TTL expiry, pushing each change', async () => {
    const watcher = socket('w', { c: false });
    await message(watcher, { t: 'sub' });
    expect(watcher.snapshots().at(-1)?.owner.status).toBe('offline');

    tick(BROADCAST_MIN_INTERVAL_MS);
    const owner = socket('owner', { o: true, m: true });
    await message(owner, { t: 'hb', cat: 'exploring' });
    expect(watcher.snapshots().at(-1)?.owner).toEqual({ status: 'online', onSite: true, since: new Date(now).toISOString() });
    expect(watcher.snapshots().at(-1)?.active).toBe(0); // the owner is never a visitor
    expect((await getState()).connected).toBe(true);

    tick(PRESENCE_TTL_MS + 1);
    await fireAlarm();
    expect(watcher.snapshots().at(-1)?.owner).toEqual({ status: 'offline', onSite: false, since: new Date(now).toISOString() });
    expect((await getState()).connected).toBe(false);
  });

  it('a non-owner (o=false) or non-consenting owner connection cannot affect the owner status', async () => {
    await put({ mode: 'auto', text: 'Here' });
    const visitor = socket('visitor', { m: true });
    await message(visitor, { t: 'hb', cat: 'exploring' });
    const watchOnlyOwner = socket('owner', { o: true, c: false });
    await message(watchOnlyOwner, { t: 'hb', cat: 'exploring' });
    const snap = await hubSnapshot();
    expect(snap.owner).toEqual({ status: 'offline', onSite: false, since: new Date(T0).toISOString() });
    expect(snap.active).toBe(1);
    expect((await getState()).connected).toBe(false);
  });

  it('pushes a manual change to subscribers immediately', async () => {
    const watcher = socket('w', { c: false });
    await message(watcher, { t: 'sub' });
    tick(BROADCAST_MIN_INTERVAL_MS);
    await put({ mode: 'away', text: 'Lunch' });
    expect(watcher.snapshots().at(-1)?.owner).toEqual({ status: 'away', onSite: false, text: 'Lunch', since: new Date(now).toISOString() });
  });

  it('invisible and offline are indistinguishable publicly, including `since`, and switching between them pushes nothing', async () => {
    const owner = socket('owner', { o: true, m: true });
    await message(owner, { t: 'hb', cat: 'reading' });
    const watcher = socket('w', { c: false });
    await message(watcher, { t: 'sub' });

    tick(BROADCAST_MIN_INTERVAL_MS);
    await put({ mode: 'offline', text: 'Secret plans' });
    const offlineSince = new Date(now).toISOString();
    const offlineSnap = await hubSnapshot();
    const pushes = watcher.snapshots().length;

    tick(BROADCAST_MIN_INTERVAL_MS);
    const invisibleState = await put({ mode: 'invisible', text: 'Secret plans' });
    const invisibleSnap = await hubSnapshot();
    expect(JSON.stringify(invisibleSnap.owner)).toBe(JSON.stringify(offlineSnap.owner));
    expect(invisibleSnap.owner).toEqual({ status: 'offline', onSite: false, since: offlineSince });
    expect(invisibleState.public).toEqual(invisibleSnap.owner);
    await fireAlarm();
    expect(watcher.snapshots()).toHaveLength(pushes);

    // The private view still knows the truth.
    expect(invisibleState).toMatchObject({ mode: 'invisible', text: 'Secret plans', connected: true });

    for (const snap of [...watcher.snapshots(), offlineSnap, invisibleSnap]) {
      const text = JSON.stringify(snap);
      for (const banned of ['mode', 'invisible', 'connected', 'Secret plans', 'updatedAt']) expect(text).not.toContain(banned);
    }
  });

  it('keeps text out of the public snapshot whenever the status is offline', async () => {
    await put({ mode: 'auto', text: 'Only when online' });
    expect(JSON.stringify(await hubSnapshot())).not.toContain('Only when online');
    const owner = socket('owner', { o: true, m: true });
    await message(owner, { t: 'hb', cat: 'reading' });
    expect((await hubSnapshot()).owner.text).toBe('Only when online');
  });

  it('clears the text with an empty or omitted value', async () => {
    await put({ mode: 'busy', text: 'Call' });
    expect((await put({ mode: 'busy', text: '   ' })).text).toBeNull();
    await put({ mode: 'busy', text: 'Call' });
    const s = await put({ mode: 'busy' });
    expect(s.text).toBeNull();
    expect('text' in s.public).toBe(false);
  });

  it('survives a fresh hub instance (setting and `since` persisted)', async () => {
    await put({ mode: 'away', text: 'Back soon' });
    const before = await getState();
    tick(10_000);
    hub = new PresenceHub(state, env);
    expect(await getState()).toEqual(before);
  });

  it('keeps `since` from the earlier stored owner shape after an upgrade', async () => {
    state.data.set('owner', { status: 'offline', since: T0 - 3_600_000 });
    expect((await hubSnapshot()).owner.since).toBe(new Date(T0 - 3_600_000).toISOString());
  });
});

describe('owner tickets at /v1/connect', () => {
  it('rejects a forged ticket claiming o=true before any upgrade', async () => {
    const payload: PresenceTicketPayload = { k: 'attacker', c: true, m: true, o: true, exp: now + 60_000, n: 'n1' };
    for (const ticket of [await signPresenceTicket('guessed-secret', payload), await signPresenceTicket(internalToken, payload)]) {
      const res = await handleRequest(new Request('https://presence.zuey.me/v1/connect', {
        headers: { Origin: 'https://zuey.me', Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `zuey-presence.v1, ${ticket}` },
      }), env);
      expect(res.status).toBe(401);
    }
    expect(state.sockets).toHaveLength(0);
    expect((await getState()).connected).toBe(false);
  });

  it('the internal header value is not accepted as a ticket', async () => {
    const res = await handleRequest(new Request('https://presence.zuey.me/v1/connect', {
      headers: { Origin: 'https://zuey.me', Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `zuey-presence.v1, ${internalToken}` },
    }), env);
    expect(res.status).toBe(401);
  });
});
