/**
 * Framework-free live feed behind the Activity Monitor. One shared connection serves every
 * subscriber and closes when the last one leaves:
 *
 *   POST /api/v1/presence/ticket (watch-only)  ->  GET {origin}/v1/snapshot  ->  wss (ticket as subprotocol)  ->  {t:'sub'}
 *
 * The Worker origin comes from the ticket answer (the server's runtime PUBLIC_PRESENCE_URL), so the
 * snapshot and the socket always hit the Worker the ticket was signed for. The first snapshot comes
 * from plain HTTP so numbers show before the socket is up; the hub then pushes on every change and a
 * keepalive at least every 45 s, so a quiet healthy socket never turns stale. Failures never
 * invent data: the state keeps the last valid snapshot (or null) and says why it is not live.
 * Reconnects use exponential backoff with jitter and a fresh ticket; a page hidden for a while
 * drops the socket and resumes when it becomes visible again.
 */
import { PRESENCE_SUBPROTOCOL, type PresenceSnapshot } from './contract';
import { isPresenceSnapshot, parseServerFrame, parseTicketGrant, type TicketGrant } from './presence-feed-guards';

export type FeedConnection = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'unavailable';

export interface FeedState {
  snapshot: PresenceSnapshot | null;
  connection: FeedConnection;
  /** Epoch ms of the last valid snapshot (HTTP or socket); null until one arrives. */
  updatedAt: number | null;
  /** Short machine reason for the current non-live state (never shown raw). */
  error?: string;
}

/** A live feed with no update for longer than this is shown as stale. */
export const FEED_STALE_MS = 60_000;

export const isFeedStale = (state: FeedState, now: number): boolean =>
  state.connection === 'live' && state.updatedAt !== null && now - state.updatedAt > FEED_STALE_MS;

export interface SocketHandlers {
  onOpen: () => void;
  onMessage: (data: unknown) => void;
  onClose: () => void;
}

export interface FeedSocket {
  send: (data: string) => void;
  close: () => void;
}

export interface FeedDeps {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  /** Opens `new WebSocket(url, protocols)`; `protocols` is `[PRESENCE_SUBPROTOCOL, ticket]`. */
  openSocket: (url: string, protocols: string[], handlers: SocketHandlers) => FeedSocket;
  now: () => number;
  random: () => number;
  baseDelayMs: number;
  maxDelayMs: number;
  staleMs: number;
  /** How long a hidden page keeps its socket before dropping it. */
  hiddenGraceMs: number;
}

const INITIAL_STATE: FeedState = { snapshot: null, connection: 'connecting', updatedAt: null };

type Loaded = { kind: 'ok'; data: PresenceSnapshot } | { kind: 'unavailable' } | { kind: 'failed'; error: string };

function browserSocket(url: string, protocols: string[], handlers: SocketHandlers): FeedSocket {
  const ws = new WebSocket(url, protocols);
  ws.addEventListener('open', handlers.onOpen);
  ws.addEventListener('message', (e) => handlers.onMessage(e.data));
  ws.addEventListener('close', handlers.onClose);
  return { send: (data) => ws.send(data), close: () => ws.close() };
}

function defaultDeps(): FeedDeps {
  return {
    fetchImpl: (input, init) => fetch(input, init),
    openSocket: browserSocket,
    now: () => Date.now(),
    random: () => Math.random(),
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    staleMs: FEED_STALE_MS,
    hiddenGraceMs: 60_000,
  };
}

export interface PresenceFeed {
  /** Registers a listener (called on every state change, not on subscribe) and returns its unsubscribe. */
  subscribeFeed: (listener: (state: FeedState) => void) => () => void;
  getFeedState: () => FeedState;
}

export function createPresenceFeed(overrides: Partial<FeedDeps> = {}): PresenceFeed {
  const deps: FeedDeps = { ...defaultDeps(), ...overrides };
  const listeners = new Set<(state: FeedState) => void>();
  let state: FeedState = INITIAL_STATE;
  let gen = 0; // bumps on stop/pause/resume so stale async work stops
  let sockSeq = 0; // bumps per socket so a closed socket's late events are ignored
  let socket: FeedSocket | null = null;
  let attempt = 0;
  let everLive = false;
  let paused = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  /** Worker origin learned from the latest ticket grant; null until one arrives. */
  let origin: string | null = null;

  const set = (next: FeedState) => {
    state = next;
    for (const l of [...listeners]) l(state);
  };

  const clearRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const closeSocket = () => {
    sockSeq++;
    const s = socket;
    socket = null;
    if (s) {
      try {
        s.close();
      } catch {
        /* already closing */
      }
    }
  };

  const applySnapshot = (snapshot: PresenceSnapshot, live: boolean) => {
    const keep = state.connection === 'live' || state.connection === 'connecting' || state.connection === 'reconnecting';
    const connection: FeedConnection = live ? 'live' : keep ? state.connection : everLive ? 'reconnecting' : 'connecting';
    set({ snapshot, connection, updatedAt: deps.now() });
  };

  /** Records a failure and schedules the next attempt with exponential backoff + jitter. */
  const fail = (g: number, unavailable: boolean, error: string, delayOverrideMs?: number) => {
    if (g !== gen) return;
    closeSocket();
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const connection: FeedConnection = unavailable ? 'unavailable' : offline || (!everLive && !state.snapshot) ? 'offline' : 'reconnecting';
    set({ snapshot: state.snapshot, updatedAt: state.updatedAt, connection, error });
    const backoff = Math.min(deps.maxDelayMs, deps.baseDelayMs * 2 ** attempt) * (0.5 + deps.random() * 0.5);
    attempt++;
    clearRetry();
    retryTimer = setTimeout(() => void run(g), delayOverrideMs ?? backoff);
  };

  async function loadSnapshot(from: string): Promise<Loaded> {
    try {
      const res = await deps.fetchImpl(`${from}/v1/snapshot`, { headers: { accept: 'application/json' } });
      if (res.status === 503) return { kind: 'unavailable' };
      if (!res.ok) return { kind: 'failed', error: `snapshot_${res.status}` };
      const body: unknown = await res.json();
      return isPresenceSnapshot(body) ? { kind: 'ok', data: body } : { kind: 'failed', error: 'snapshot_invalid' };
    } catch {
      return { kind: 'failed', error: 'snapshot_network' };
    }
  }

  async function run(g: number): Promise<void> {
    if (g !== gen) return;
    const grant = await requestTicket(g);
    if (!grant || g !== gen) return;
    origin = grant.origin;
    const snap = await loadSnapshot(grant.origin);
    if (g !== gen) return;
    if (snap.kind === 'unavailable') return fail(g, true, 'snapshot_503');
    if (snap.kind === 'failed') return fail(g, false, snap.error);
    applySnapshot(snap.data, false);
    openSocket(g, grant);
  }

  /** A watch-only ticket grant, or null after recording the failure. */
  async function requestTicket(g: number): Promise<TicketGrant | null> {
    let res: Response;
    try {
      res = await deps.fetchImpl('/api/v1/presence/ticket', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ count: false }),
      });
    } catch {
      fail(g, false, 'ticket_network');
      return null;
    }
    if (g !== gen) return null;
    if (res.status === 503) {
      fail(g, true, 'ticket_503');
      return null;
    }
    if (!res.ok) {
      fail(g, false, res.status === 429 ? 'ticket_rate_limited' : `ticket_${res.status}`);
      return null;
    }
    let grant: TicketGrant | null;
    try {
      grant = parseTicketGrant(await res.json());
    } catch {
      grant = null;
    }
    if (g !== gen) return null;
    if (!grant) fail(g, false, 'ticket_invalid');
    return grant;
  }

  function openSocket(g: number, grant: TicketGrant): void {
    const sid = ++sockSeq;
    const live = () => g === gen && sid === sockSeq;
    try {
      socket = deps.openSocket(grant.url, [PRESENCE_SUBPROTOCOL, grant.ticket], {
        onOpen: () => {
          if (live()) socket?.send(JSON.stringify({ t: 'sub' }));
        },
        onMessage: (data) => {
          if (!live()) return;
          const frame = parseServerFrame(data);
          if (!frame) return; // malformed frames are ignored, never rendered
          if (frame.t === 'snapshot') {
            attempt = 0;
            everLive = true;
            applySnapshot(frame.data, true);
          } else if (frame.code === 'ticket_expired') {
            fail(g, false, 'ticket_expired', 0);
          } else if (frame.code === 'rate_limited') {
            fail(g, false, 'rate_limited');
          }
        },
        onClose: () => {
          if (live()) fail(g, false, 'socket_closed');
        },
      });
    } catch {
      fail(g, false, 'socket_open');
    }
  }

  /** While live, a feed with no frames for `staleMs` re-reads the snapshot over HTTP so freshness stays honest. */
  const watchStale = () => {
    if (state.connection !== 'live' || state.updatedAt === null || deps.now() - state.updatedAt <= deps.staleMs || origin === null) return;
    const g = gen;
    void loadSnapshot(origin).then((r) => {
      if (g === gen && r.kind === 'ok' && state.connection === 'live') applySnapshot(r.data, true);
    });
  };

  const startCycle = () => {
    paused = false;
    gen++;
    attempt = 0;
    clearRetry();
    closeSocket();
    set(everLive || state.snapshot ? { ...state, connection: 'connecting', error: undefined } : INITIAL_STATE);
    void run(gen);
  };

  const pause = () => {
    paused = true;
    gen++;
    clearRetry();
    closeSocket();
  };

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      if (!hiddenTimer) hiddenTimer = setTimeout(pause, deps.hiddenGraceMs);
      return;
    }
    if (hiddenTimer) clearTimeout(hiddenTimer);
    hiddenTimer = null;
    if (paused) startCycle();
  };

  const start = () => {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    watchdog = setInterval(watchStale, Math.max(1_000, Math.floor(deps.staleMs / 3)));
    startCycle();
  };

  const stop = () => {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    if (watchdog) clearInterval(watchdog);
    if (hiddenTimer) clearTimeout(hiddenTimer);
    watchdog = null;
    hiddenTimer = null;
    gen++;
    paused = false;
    everLive = false;
    clearRetry();
    closeSocket();
    state = INITIAL_STATE; // the next subscriber starts honest, not with a stale number
  };

  return {
    getFeedState: () => state,
    subscribeFeed(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
  };
}

/** Shared app-wide feed: every Activity Monitor view uses this one connection. */
const shared = createPresenceFeed();
export const subscribeFeed = shared.subscribeFeed;
export const getFeedState = shared.getFeedState;
