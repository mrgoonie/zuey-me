import { describe, expect, it } from 'bun:test';
import { ACTIVITY_CATEGORIES, PRESENCE_HEARTBEAT_MS, type ActivityCategory } from '../src/lib/presence/contract';
import {
  IDLE_AFTER_MS, MAX_UNAVAILABLE_TICKETS, MIN_MESSAGE_GAP_MS, PRESENCE_APP_FOCUS_EVENT, PRESENCE_ID_STORAGE_KEY, TICK_MS,
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
  constructor(public url: string, public handlers: PresenceSocketHandlers) {}
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

function harness(opts: { consent?: boolean; ticketStatus?: number } = {}) {
  let now = 1_000_000;
  let nextId = 1;
  let timers: Timer[] = [];
  const store = new Map<string, string>();
  const state = { consent: opts.consent ?? true, visible: true, ticketStatus: opts.ticketStatus ?? 200, pathname: '/articles/x', hash: '' };
  const sockets: FakeSocket[] = [];
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const win = new FakeTarget();
  const doc = new FakeTarget();

  const beacon = createPresenceBeacon({
    consentGranted: () => state.consent,
    storage: () => ({ getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }),
    fetch: async (url, init) => {
      fetches.push({ url, init });
      if (state.ticketStatus !== 200) {
        return new Response(JSON.stringify({ success: false, error: { code: 'x', message: 'x' } }), { status: state.ticketStatus });
      }
      return new Response(JSON.stringify({ success: true, data: { ticket: 'tkt.sig', url: 'wss://presence.zuey.me/v1/connect', expiresAt: '' } }));
    },
    openSocket: (url, handlers) => {
      const s = new FakeSocket(url, handlers);
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
    beacon, state, store, sockets, fetches, win, doc, flush, advance, last,
    activity: () => win.emit(new Event('pointermove')),
    setVisible: (v: boolean) => {
      state.visible = v;
      doc.emit(new Event('visibilitychange'));
    },
    timerCount: () => timers.length,
    allSent: () => sockets.flatMap(s => s.sent),
  };
}

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
    expect(s.url).toBe('wss://presence.zuey.me/v1/connect?ticket=tkt.sig');
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
    await h.advance(PRESENCE_HEARTBEAT_MS * 3);
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

  it('reconnects with backoff and a fresh ticket after the socket drops', async () => {
    const h = harness();
    const s = await connected(h);
    s.serverClose();
    expect(h.fetches).toHaveLength(1);
    await h.advance(60_000);
    expect(h.fetches).toHaveLength(2);
    expect(h.sockets).toHaveLength(2);
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
