import { describe, expect, it } from 'bun:test';
import { ACTIVITY_CATEGORIES, PRESENCE_HEARTBEAT_MS, PRESENCE_TICKET_TTL_MS, type ActivityCategory } from '../src/lib/presence/contract';
import {
  HIDDEN_GRACE_MS, IDLE_AFTER_MS, MAX_FAILED_SOCKETS, MAX_UNAVAILABLE_TICKETS, MIN_MESSAGE_GAP_MS, PRESENCE_APP_FOCUS_EVENT,
  PRESENCE_ID_STORAGE_KEY, PRESENCE_TICKET_STORAGE_KEY, TICKET_REUSE_MARGIN_MS, TICK_MS,
  createPresenceBeacon, type PresenceEventTarget, type PresenceSocketHandlers,
} from '../src/lib/presence/presence-beacon';
import { presenceAllowedOn } from '../src/lib/presence/presence-beacon-boot';
import { categoryFor } from '../src/lib/presence/presence-category';
import { PRESENCE_CONSENT_EVENT } from '../src/lib/presence/presence-consent-event';

describe('categoryFor', () => {
  const table: Array<[string, string | null, ActivityCategory]> = [
    ['/articles', null, 'reading'],
    ['/articles/some-slug', null, 'reading'],
    ['/articles/page/2', null, 'reading'],
    ['/videos', null, 'zueytube'],
    ['/reads', null, 'reads'],
    ['/chat', null, 'ai'],
    ['/courses', null, 'courses'],
    ['/courses/ai-basics/lesson-1', null, 'courses'],
    ['/certificates/abc', null, 'courses'],
    ['/', null, 'exploring'],
    ['', null, 'exploring'],
    ['/', 'knowledges', 'reading'],
    ['/', 'zueytube', 'zueytube'],
    ['/', 'reads', 'reads'],
    ['/', 'ai', 'ai'],
    ['/', 'about', 'exploring'],
    ['/', 'constructor', 'exploring'],
    ['/', '__proto__', 'exploring'],
    ['/pricing', 'ai', 'other'],
    ['/account', null, 'other'],
    ['/privacy', null, 'other'],
    ['/articlesX', null, 'other'],
    ['/index.md', null, 'other'],
  ];
  for (const [path, app, expected] of table) {
    it(`${path} + ${app} → ${expected}`, () => {
      const cat = categoryFor(path, app);
      expect(cat).toBe(expected);
      expect(ACTIVITY_CATEGORIES).toContain(cat);
    });
  }
});

describe('presenceAllowedOn', () => {
  it('runs on production hosts, elsewhere only in debug', () => {
    expect(presenceAllowedOn('zuey.me', false)).toBe(true);
    expect(presenceAllowedOn('WWW.ZUEY.ME', false)).toBe(true);
    expect(presenceAllowedOn('localhost', false)).toBe(false);
    expect(presenceAllowedOn('preview.zuey-me.pages.dev', false)).toBe(false);
    expect(presenceAllowedOn('localhost', true)).toBe(true);
  });
});

class FakeTarget implements PresenceEventTarget {
  listeners = new Map<string, Set<(ev: Event) => void>>();
  addEventListener(type: string, listener: (ev: Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }
  removeEventListener(type: string, listener: (ev: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(ev: Event): void {
    for (const l of [...(this.listeners.get(ev.type) ?? [])]) l(ev);
  }
  count(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

class FakeSocket {
  sent: unknown[] = [];
  open = false;
  closed = false;
  constructor(public url: string, public protocols: string[], public handlers: PresenceSocketHandlers) {}
  send(data: string): boolean {
    if (!this.open) return false;
    this.sent.push(JSON.parse(data));
    return true;
  }
  close(): void {
    this.closed = true;
    this.open = false;
  }
  serverOpen(): void {
    this.open = true;
    this.handlers.onOpen();
  }
  serverClose(): void {
    this.open = false;
    this.handlers.onClose();
  }
}

interface Timer { id: number; at: number; fn: () => void; every: number | null }

function harness(opts: { consent?: boolean; ticketStatus?: number; session?: Map<string, string>; store?: Map<string, string>; now?: number } = {}) {
  let now = opts.now ?? 1_000_000;
  let nextId = 1;
  let timers: Timer[] = [];
  const store = opts.store ?? new Map<string, string>();
  const session = opts.session ?? new Map<string, string>();
  let ticketSeq = 0;
  const state = { consent: opts.consent ?? true, visible: true, ticketStatus: opts.ticketStatus ?? 200, pathname: '/articles/x', hash: '' };
  const sockets: FakeSocket[] = [];
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const win = new FakeTarget();
  const doc = new FakeTarget();

  const beacon = createPresenceBeacon({
    consentGranted: () => state.consent,
    storage: () => ({ getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }),
    sessionStorage: () => ({
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => void session.set(k, v),
      removeItem: (k: string) => void session.delete(k),
    }),
    fetch: async (url, init) => {
      fetches.push({ url, init });
      if (state.ticketStatus !== 200) {
        return new Response(JSON.stringify({ success: false, error: { code: 'x', message: 'x' } }), { status: state.ticketStatus });
      }
      ticketSeq += 1;
      const ticket = ticketSeq === 1 ? 'tkt.sig' : `tkt${ticketSeq}.sig`;
      return new Response(JSON.stringify({ success: true, data: { ticket, url: 'wss://presence.zuey.me/v1/connect', expiresAt: '' } }));
    },
    openSocket: (url, protocols, handlers) => {
      const s = new FakeSocket(url, protocols, handlers);
      sockets.push(s);
      return s;
    },
    win,
    doc,
    visible: () => state.visible,
    location: () => ({ pathname: state.pathname, hash: state.hash }),
    now: () => now,
    random: () => 0.5,
    setTimer: (fn, ms) => {
      const t = { id: nextId++, at: now + ms, fn, every: null };
      timers.push(t);
      return t.id;
    },
    clearTimer: id => { timers = timers.filter(t => t.id !== id); },
    setTicker: (fn, ms) => {
      const t = { id: nextId++, at: now + ms, fn, every: ms };
      timers.push(t);
      return t.id;
    },
    clearTicker: id => { timers = timers.filter(t => t.id !== id); },
    randomId: () => 'RandomPresenceId_1234567',
    debug: () => {},
  });

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  const advance = async (ms: number): Promise<void> => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      if (due.every === null) timers = timers.filter(t => t !== due);
      else due.at += due.every;
      due.fn();
      await flush();
    }
    now = end;
    await flush();
  };

  const last = (): FakeSocket => {
    const s = sockets[sockets.length - 1];
    if (!s) throw new Error('no socket');
    return s;
  };

  return {
    beacon, state, store, session, sockets, fetches, win, doc, flush, advance, last,
    now: () => now,
    activity: () => win.emit(new Event('pointermove')),
    setVisible: (v: boolean) => {
      state.visible = v;
      doc.emit(new Event('visibilitychange'));
    },
    timerCount: () => timers.length,
    allSent: () => sockets.flatMap(s => s.sent),
  };
}

/** Longer than any reconnect delay (cap 60 s), so each loop step reaches the next attempt. */
const RECONNECT_WAIT = 61_000;

async function connected(h: ReturnType<typeof harness>): Promise<FakeSocket> {
  h.beacon.start();
  await h.flush();
  const s = h.last();
  s.serverOpen();
  return s;
}

describe('presence beacon', () => {
  it('does nothing without consent: no id, no ticket, no socket', async () => {
    const h = harness({ consent: false });
    h.beacon.start();
    await h.advance(PRESENCE_HEARTBEAT_MS * 3);
    expect(h.fetches).toHaveLength(0);
    expect(h.sockets).toHaveLength(0);
    expect(h.store.has(PRESENCE_ID_STORAGE_KEY)).toBe(false);
  });

  it('creates the browser id, requests a counting ticket as JSON and sends hb on open', async () => {
    const h = harness();
    const s = await connected(h);
    expect(h.store.get(PRESENCE_ID_STORAGE_KEY)).toBe('RandomPresenceId_1234567');
    const { url, init } = h.fetches[0];
    expect(url).toBe('/api/v1/presence/ticket');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ count: true, browserId: 'RandomPresenceId_1234567' });
    expect(s.url).toBe('wss://presence.zuey.me/v1/connect');
    expect(s.protocols).toEqual(['zuey-presence.v1', 'tkt.sig']);
    expect(s.sent).toEqual([{ t: 'hb', cat: 'reading' }]);
  });

  it('heartbeats on schedule while active, goes idle after inactivity and resumes on input', async () => {
    const h = harness();
    const s = await connected(h);
    await h.advance(PRESENCE_HEARTBEAT_MS + TICK_MS);
    expect(s.sent.filter(m => JSON.stringify(m).includes('"hb"')).length).toBe(2);
    await h.advance(IDLE_AFTER_MS);
    expect(s.sent[s.sent.length - 1]).toEqual({ t: 'idle' });
    const before = s.sent.length;
    await h.advance(PRESENCE_HEARTBEAT_MS * 2);
    expect(s.sent.length).toBe(before);
    h.activity();
    await h.advance(MIN_MESSAGE_GAP_MS);
    expect(s.sent[s.sent.length - 1]).toEqual({ t: 'hb', cat: 'reading' });
  });

  it('sends idle when hidden, pauses, and heartbeats again when shown', async () => {
    const h = harness();
    const s = await connected(h);
    await h.advance(MIN_MESSAGE_GAP_MS);
    h.setVisible(false);
    expect(s.sent[s.sent.length - 1]).toEqual({ t: 'idle' });
    const before = s.sent.length;
    await h.advance(PRESENCE_HEARTBEAT_MS * 2); // within the hidden grace: the socket stays
    expect(s.sent.length).toBe(before);
    h.setVisible(true);
    expect(s.sent[s.sent.length - 1]).toEqual({ t: 'hb', cat: 'reading' });
  });

  it('keeps messages at least the minimum gap apart', async () => {
    const h = harness();
    h.state.pathname = '/';
    const s = await connected(h);
    h.win.emit(new CustomEvent(PRESENCE_APP_FOCUS_EVENT, { detail: { app: 'ai' } }));
    expect(s.sent).toEqual([{ t: 'hb', cat: 'exploring' }]);
    h.win.emit(new CustomEvent(PRESENCE_APP_FOCUS_EVENT, { detail: { app: 'zueytube' } }));
    await h.advance(MIN_MESSAGE_GAP_MS);
    expect(s.sent).toEqual([{ t: 'hb', cat: 'exploring' }, { t: 'hb', cat: 'zueytube' }]);
  });

  it('closes and stops at once when consent is withdrawn in this tab or another', async () => {
    const h = harness();
    const s = await connected(h);
    h.state.consent = false;
    h.win.emit(new CustomEvent(PRESENCE_CONSENT_EVENT, { detail: { granted: false } }));
    expect(s.closed).toBe(true);
    await h.advance(PRESENCE_HEARTBEAT_MS * 4);
    expect(h.sockets).toHaveLength(1);
    expect(h.fetches).toHaveLength(1);

    h.state.consent = true;
    h.win.emit(new CustomEvent(PRESENCE_CONSENT_EVENT, { detail: { granted: true } }));
    await h.flush();
    const again = h.last();
    expect(again).not.toBe(s);
    again.serverOpen();
    h.state.consent = false;
    h.win.emit(new Event('storage'));
    expect(again.closed).toBe(true);
  });

  it('stops even if the opt-out could not be stored (consent still reads granted)', async () => {
    const h = harness();
    const s = await connected(h);
    h.win.emit(new CustomEvent(PRESENCE_CONSENT_EVENT, { detail: { granted: false } }));
    expect(s.closed).toBe(true);
  });

  it('reconnects with backoff after the socket drops, reusing the still-valid ticket', async () => {
    const h = harness();
    const s = await connected(h);
    s.serverClose();
    await h.advance(30_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.fetches).toHaveLength(1);
    expect(h.last().protocols).toEqual(['zuey-presence.v1', 'tkt.sig']);
  });

  it('reuses a cached ticket on the next page load in the same tab until 15 s before it expires', async () => {
    const session = new Map<string, string>();
    const store = new Map<string, string>();
    const first = harness({ session, store });
    await connected(first);
    first.win.emit(new Event('pagehide'));
    expect(session.has(PRESENCE_TICKET_STORAGE_KEY)).toBe(true);

    const second = harness({ session, store, now: first.now() + 60_000 });
    await connected(second);
    expect(second.fetches).toHaveLength(0);
    expect(second.last().protocols).toEqual(['zuey-presence.v1', 'tkt.sig']);
    second.beacon.stop();

    const late = harness({ session, store, now: first.now() + PRESENCE_TICKET_TTL_MS - TICKET_REUSE_MARGIN_MS });
    await connected(late);
    expect(late.fetches).toHaveLength(1);
  });

  it('does not reuse a ticket issued for another browser id, or one that is malformed', async () => {
    const session = new Map<string, string>();
    const first = harness({ session });
    await connected(first);
    first.beacon.stop();
    const otherBrowser = harness({ session, store: new Map([[PRESENCE_ID_STORAGE_KEY, 'AnotherPresenceId_987654']]) });
    await connected(otherBrowser);
    expect(otherBrowser.fetches).toHaveLength(1);
    otherBrowser.beacon.stop();

    session.set(PRESENCE_TICKET_STORAGE_KEY, '{"ticket":"bad ticket","url":"wss://x/v1/connect"}');
    const garbled = harness({ session });
    await connected(garbled);
    expect(garbled.fetches).toHaveLength(1);
  });

  it('withdrawing consent forgets the cached ticket', async () => {
    const h = harness();
    await connected(h);
    expect(h.session.has(PRESENCE_TICKET_STORAGE_KEY)).toBe(true);
    h.state.consent = false;
    h.win.emit(new CustomEvent(PRESENCE_CONSENT_EVENT, { detail: { granted: false } }));
    expect(h.session.has(PRESENCE_TICKET_STORAGE_KEY)).toBe(false);
  });

  it('gives up for the page after consecutive sockets that never open, and never throws', async () => {
    const h = harness();
    h.beacon.start();
    await h.flush();
    for (let i = 0; i < MAX_FAILED_SOCKETS + 3; i++) {
      const s = h.sockets[h.sockets.length - 1];
      if (s && !s.closed) s.serverClose(); // upgrade refused or Worker down: close without open
      await h.advance(RECONNECT_WAIT);
    }
    expect(h.sockets).toHaveLength(MAX_FAILED_SOCKETS);
    expect(h.timerCount()).toBe(0);
    // Each refused socket dropped its cached ticket, so every retry asked for a new one.
    expect(h.fetches).toHaveLength(MAX_FAILED_SOCKETS);
    expect(h.session.has(PRESENCE_TICKET_STORAGE_KEY)).toBe(false);
  });

  it('a socket that opens resets the failed-socket count', async () => {
    const h = harness();
    h.beacon.start();
    await h.flush();
    for (let i = 0; i < MAX_FAILED_SOCKETS - 1; i++) {
      h.last().serverClose();
      await h.advance(RECONNECT_WAIT);
    }
    h.last().serverOpen();
    h.last().serverClose();
    await h.advance(RECONNECT_WAIT);
    for (let i = 0; i < MAX_FAILED_SOCKETS - 1; i++) {
      h.last().serverClose();
      await h.advance(RECONNECT_WAIT);
    }
    expect(h.sockets).toHaveLength(2 * MAX_FAILED_SOCKETS);
    expect(h.timerCount()).toBeGreaterThan(0);
  });

  it('closes the socket after 60 s hidden and reconnects when shown again', async () => {
    const h = harness();
    const s = await connected(h);
    h.setVisible(false);
    await h.advance(HIDDEN_GRACE_MS - 1);
    expect(s.closed).toBe(false);
    await h.advance(1);
    expect(s.closed).toBe(true);
    await h.advance(10 * 60_000);
    expect(h.sockets).toHaveLength(1);

    h.setVisible(true);
    await h.flush();
    expect(h.sockets).toHaveLength(2);
    h.last().serverOpen();
    expect(h.last().sent).toEqual([{ t: 'hb', cat: 'reading' }]);
  });

  it('a short hide keeps the socket', async () => {
    const h = harness();
    const s = await connected(h);
    h.setVisible(false);
    await h.advance(HIDDEN_GRACE_MS / 2);
    h.setVisible(true);
    await h.advance(HIDDEN_GRACE_MS);
    expect(s.closed).toBe(false);
    expect(h.sockets).toHaveLength(1);
  });

  it('gives up for the page after repeated 503 tickets', async () => {
    const h = harness({ ticketStatus: 503 });
    h.beacon.start();
    await h.advance(10 * 60_000);
    expect(h.fetches).toHaveLength(MAX_UNAVAILABLE_TICKETS);
    expect(h.sockets).toHaveLength(0);
    expect(h.timerCount()).toBe(0);
  });

  it('closes on pagehide and only ever sends t/cat', async () => {
    const h = harness();
    const s = await connected(h);
    await h.advance(PRESENCE_HEARTBEAT_MS * 2);
    h.win.emit(new Event('pagehide'));
    expect(s.closed).toBe(true);
    await h.advance(PRESENCE_HEARTBEAT_MS * 2);
    expect(h.sockets).toHaveLength(1);
    for (const msg of h.allSent()) {
      if (typeof msg !== 'object' || msg === null) throw new Error('message is not an object');
      expect(Object.keys(msg).every(k => k === 't' || k === 'cat')).toBe(true);
    }
    h.beacon.stop();
    expect(h.win.count() + h.doc.count()).toBe(0);
  });
});
