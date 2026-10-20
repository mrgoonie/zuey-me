/**
 * Browser presence beacon: while analytics consent is granted, keeps one WebSocket to the presence
 * Worker and reports only `{ t: 'hb', cat }` / `{ t: 'idle' }` (no URL, title, query or id).
 *
 * - Heartbeat on connect and every PRESENCE_HEARTBEAT_MS while the tab is visible and the visitor is
 *   not idle (no pointer/key/scroll/touch input for IDLE_AFTER_MS); idle or hidden sends `idle` once.
 * - At most one message per MIN_MESSAGE_GAP_MS per socket (the Worker drops faster ones); a message
 *   that has to wait is replaced by a newer one.
 * - Reconnects with capped exponential backoff and full jitter, fetching a fresh ticket each time;
 *   repeated 401/503 ticket answers (or a 400) stop it for the page lifetime.
 * - Consent withdrawn (this tab or another) closes the socket at once.
 *
 * Every browser surface is injected, so tests drive it with fakes. Nothing here throws into the page.
 */
import { PRESENCE_HEARTBEAT_MS, type ActivityCategory, type PresenceClientMessage } from './contract';
import { categoryFor } from './presence-category';
import { PRESENCE_CONSENT_EVENT, presenceConsentFrom } from './presence-consent-event';

export const PRESENCE_ID_STORAGE_KEY = 'zuey_presence_id';
export const PRESENCE_TICKET_ENDPOINT = '/api/v1/presence/ticket';
export const PRESENCE_APP_FOCUS_EVENT = 'zuey:app-focus';
export const IDLE_AFTER_MS = 120_000;
export const MIN_MESSAGE_GAP_MS = 5_000;
export const TICK_MS = 5_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 60_000;
/** A socket that stayed open this long counts as healthy: the backoff starts over. */
export const HEALTHY_SOCKET_MS = 30_000;
/** Consecutive 401/503 ticket answers after which the beacon gives up for this page. */
export const MAX_UNAVAILABLE_TICKETS = 3;

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'wheel', 'touchstart'] as const;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export interface PresenceEventTarget {
  addEventListener(type: string, listener: (ev: Event) => void, options?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, listener: (ev: Event) => void, options?: EventListenerOptions | boolean): void;
}

export interface PresenceSocket {
  /** Returns false when the socket is not open (nothing was sent). */
  send(data: string): boolean;
  close(): void;
}

export interface PresenceSocketHandlers {
  onOpen(): void;
  onClose(): void;
}

export interface PresenceBeaconDeps {
  consentGranted: () => boolean;
  storage: () => StorageLike | null;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  openSocket: (url: string, handlers: PresenceSocketHandlers) => PresenceSocket;
  /** Window-like target: pagehide/pageshow, storage, consent, app-focus and input events. */
  win: PresenceEventTarget;
  /** Document-like target for `visibilitychange`. */
  doc: PresenceEventTarget;
  visible: () => boolean;
  location: () => { pathname: string; hash: string };
  now: () => number;
  random: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  setTicker: (fn: () => void, ms: number) => unknown;
  clearTicker: (handle: unknown) => void;
  randomId: () => string;
  debug: (message: string) => void;
}

export interface PresenceBeacon {
  start(): void;
  /** Closes everything and ignores later events (page teardown). */
  stop(): void;
}

interface TicketData {
  ticket: string;
  url: string;
}

function parseTicket(body: unknown): TicketData | null {
  if (typeof body !== 'object' || body === null || !('data' in body)) return null;
  const data: unknown = body.data;
  if (typeof data !== 'object' || data === null) return null;
  if (!('ticket' in data) || typeof data.ticket !== 'string' || !('url' in data) || typeof data.url !== 'string') return null;
  if (!/^wss?:\/\//.test(data.url)) return null;
  return { ticket: data.ticket, url: data.url };
}

function focusedAppFrom(ev: Event): string | null | undefined {
  if (!('detail' in ev)) return undefined;
  const detail: unknown = ev.detail;
  if (typeof detail !== 'object' || detail === null || !('app' in detail)) return undefined;
  const app: unknown = detail.app;
  if (app === null) return null;
  return typeof app === 'string' && app.length <= 40 ? app : undefined;
}

export function createPresenceBeacon(deps: PresenceBeaconDeps): PresenceBeacon {
  // `off`: not allowed to count (no consent) or not started; `dead`: gave up or torn down for good.
  let state: 'off' | 'running' | 'dead' = 'off';
  let generation = 0;
  let socket: PresenceSocket | null = null;
  let socketOpen = false;
  let openedAt = 0;
  let connecting = false;
  let reconnectTimer: unknown = null;
  let waitingForVisible = false;
  let attempts = 0;
  let unavailable = 0;
  let ticker: unknown = null;
  let lastActivity = deps.now();
  let lastSentAt = 0;
  let lastHbAt = 0;
  let reportedIdle = false;
  let pending: PresenceClientMessage | null = null;
  let lastCat: ActivityCategory | null = null;
  const initialHash = deps.location().hash.replace(/^#/, '');
  let focusedApp: string | null = initialHash.length > 0 ? initialHash : null;

  const log = (message: string): void => {
    try {
      deps.debug(`presence: ${message}`);
    } catch {
      // Logging never matters more than the page.
    }
  };

  const category = (): ActivityCategory => categoryFor(deps.location().pathname, focusedApp);
  const isIdle = (): boolean => deps.now() - lastActivity >= IDLE_AFTER_MS;
  const active = (): boolean => deps.visible() && !isIdle();

  const transmit = (msg: PresenceClientMessage): void => {
    if (!socket || !socketOpen) return;
    if (deps.now() - lastSentAt < MIN_MESSAGE_GAP_MS) {
      pending = msg;
      return;
    }
    pending = null;
    if (!socket.send(JSON.stringify(msg))) return;
    lastSentAt = deps.now();
    if (msg.t === 'hb') {
      lastHbAt = lastSentAt;
      lastCat = msg.cat;
      reportedIdle = false;
    } else if (msg.t === 'idle') {
      reportedIdle = true;
    }
  };

  const heartbeat = (): void => transmit({ t: 'hb', cat: category() });
  const goIdle = (): void => {
    if (!reportedIdle) transmit({ t: 'idle' });
  };

  const tick = (): void => {
    try {
      if (state !== 'running') return;
      if (!deps.consentGranted()) {
        consentWithdrawn();
        return;
      }
      if (!socketOpen) return;
      if (pending && deps.now() - lastSentAt >= MIN_MESSAGE_GAP_MS) {
        transmit(pending);
        return;
      }
      if (!active()) {
        // An `hb` still waiting would wrongly report activity: replace it with `idle`.
        if (pending?.t === 'hb') pending = null;
        goIdle();
        return;
      }
      if (reportedIdle || category() !== lastCat || deps.now() - lastHbAt >= PRESENCE_HEARTBEAT_MS) heartbeat();
    } catch (err) {
      log(`tick failed ${err instanceof Error ? err.message : ''}`);
    }
  };

  const browserId = (): string => {
    const storage = deps.storage();
    try {
      const existing = storage?.getItem(PRESENCE_ID_STORAGE_KEY);
      if (existing && /^[A-Za-z0-9_-]{16,64}$/.test(existing)) return existing;
    } catch {
      // Unreadable storage: fall through to a fresh id.
    }
    const id = deps.randomId();
    try {
      storage?.setItem(PRESENCE_ID_STORAGE_KEY, id);
    } catch {
      // Not persisted: this page still counts once, other tabs simply get their own id.
    }
    return id;
  };

  const closeSocket = (): void => {
    const s = socket;
    socket = null;
    socketOpen = false;
    pending = null;
    if (s) {
      try {
        s.close();
      } catch {
        // Already closed.
      }
    }
  };

  const clearReconnect = (): void => {
    if (reconnectTimer !== null) deps.clearTimer(reconnectTimer);
    reconnectTimer = null;
    waitingForVisible = false;
  };

  const scheduleReconnect = (): void => {
    if (state !== 'running' || reconnectTimer !== null) return;
    const ceiling = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempts);
    attempts = Math.min(attempts + 1, 16);
    const delay = Math.max(RECONNECT_BASE_MS, Math.round(deps.random() * ceiling));
    log(`reconnect in ${delay}ms`);
    reconnectTimer = deps.setTimer(() => {
      reconnectTimer = null;
      // A hidden tab waits until it is shown again instead of reconnecting in the background.
      if (!deps.visible()) {
        waitingForVisible = true;
        return;
      }
      void connect();
    }, delay);
  };

  const giveUp = (reason: string): void => {
    log(`stopped: ${reason}`);
    teardown();
    state = 'dead';
  };

  async function connect(): Promise<void> {
    if (state !== 'running' || socket || connecting) return;
    connecting = true;
    const gen = generation;
    try {
      const res = await deps.fetch(PRESENCE_TICKET_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ count: true, browserId: browserId() }),
      });
      if (gen !== generation || state !== 'running') return;
      if (res.status === 401 || res.status === 503) {
        unavailable += 1;
        if (unavailable >= MAX_UNAVAILABLE_TICKETS) giveUp(`ticket ${res.status}`);
        else scheduleReconnect();
        return;
      }
      if (res.status === 400 || res.status === 403) {
        giveUp(`ticket ${res.status}`);
        return;
      }
      const ticket = res.ok ? parseTicket(await res.json()) : null;
      if (gen !== generation || state !== 'running') return;
      if (!ticket) {
        scheduleReconnect();
        return;
      }
      unavailable = 0;
      const url = `${ticket.url}${ticket.url.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket.ticket)}`;
      const s = deps.openSocket(url, {
        onOpen: () => {
          if (socket !== s) return;
          socketOpen = true;
          openedAt = deps.now();
          lastSentAt = 0;
          lastCat = null;
          reportedIdle = false;
          if (active()) heartbeat();
        },
        onClose: () => {
          if (socket !== s) return;
          const lived = socketOpen ? deps.now() - openedAt : 0;
          socket = null;
          socketOpen = false;
          pending = null;
          if (lived >= HEALTHY_SOCKET_MS) attempts = 0;
          scheduleReconnect();
        },
      });
      socket = s;
    } catch (err) {
      if (gen === generation && state === 'running') {
        log(`connect failed ${err instanceof Error ? err.message : ''}`);
        scheduleReconnect();
      }
    } finally {
      if (gen === generation) connecting = false;
    }
  }

  function teardown(): void {
    generation += 1;
    connecting = false;
    clearReconnect();
    closeSocket();
    if (ticker !== null) deps.clearTicker(ticker);
    ticker = null;
  }

  function consentWithdrawn(): void {
    if (state !== 'running') return;
    log('consent withdrawn');
    teardown();
    state = 'off';
  }

  const begin = (): void => {
    if (state !== 'off' || !deps.consentGranted()) return;
    state = 'running';
    attempts = 0;
    lastActivity = deps.now();
    ticker = deps.setTicker(tick, TICK_MS);
    void connect();
  };

  const onActivity = (): void => {
    const wasIdle = isIdle();
    lastActivity = deps.now();
    if (wasIdle && state === 'running' && deps.visible()) heartbeat();
  };

  const onVisibility = (): void => {
    try {
      if (state !== 'running') return;
      if (deps.visible()) {
        lastActivity = deps.now();
        if (waitingForVisible || (!socket && !connecting && reconnectTimer === null)) {
          waitingForVisible = false;
          void connect();
        } else if (socketOpen) heartbeat();
      } else {
        if (pending?.t === 'hb') pending = null;
        goIdle();
      }
    } catch (err) {
      log(`visibility failed ${err instanceof Error ? err.message : ''}`);
    }
  };

  const onConsentEvent = (ev: Event): void => {
    try {
      const granted = presenceConsentFrom(ev);
      if (granted === false || !deps.consentGranted()) consentWithdrawn();
      else if (granted === true) begin();
    } catch {
      consentWithdrawn();
    }
  };

  const onStorage = (): void => {
    try {
      // Another tab changed the opt-out flag (or cleared storage): re-read consent.
      if (deps.consentGranted()) begin();
      else consentWithdrawn();
    } catch {
      consentWithdrawn();
    }
  };

  const onAppFocus = (ev: Event): void => {
    try {
      const app = focusedAppFrom(ev);
      if (app === undefined) return;
      focusedApp = app;
      if (state === 'running' && socketOpen && active() && category() !== lastCat) heartbeat();
    } catch (err) {
      log(`app focus failed ${err instanceof Error ? err.message : ''}`);
    }
  };

  const onPageHide = (): void => {
    if (state !== 'running') return;
    teardown();
    state = 'off';
  };

  const onPageShow = (ev: Event): void => {
    // Restored from the back/forward cache: the earlier pagehide closed the socket.
    if ('persisted' in ev && ev.persisted === true) begin();
  };

  const listeners: Array<[PresenceEventTarget, string, (ev: Event) => void, boolean]> = [
    ...ACTIVITY_EVENTS.map((type): [PresenceEventTarget, string, (ev: Event) => void, boolean] => [deps.win, type, onActivity, true]),
    [deps.doc, 'visibilitychange', onVisibility, false],
    [deps.win, PRESENCE_CONSENT_EVENT, onConsentEvent, false],
    [deps.win, 'storage', onStorage, false],
    [deps.win, PRESENCE_APP_FOCUS_EVENT, onAppFocus, false],
    [deps.win, 'pagehide', onPageHide, false],
    [deps.win, 'pageshow', onPageShow, false],
  ];

  const listen = (add: boolean): void => {
    for (const [target, type, handler, capture] of listeners) {
      if (add) target.addEventListener(type, handler, capture ? { capture: true, passive: true } : false);
      else target.removeEventListener(type, handler, capture);
    }
  };

  let listening = false;
  return {
    start() {
      try {
        if (state === 'dead') return;
        if (!listening) {
          listening = true;
          listen(true);
        }
        begin();
      } catch (err) {
        log(`start failed ${err instanceof Error ? err.message : ''}`);
      }
    },
    stop() {
      try {
        teardown();
        state = 'dead';
        if (listening) {
          listening = false;
          listen(false);
        }
      } catch {
        // Nothing left to clean up.
      }
    },
  };
}
