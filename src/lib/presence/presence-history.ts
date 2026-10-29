/**
 * Framework-free loader for the Activity Monitor's 24h chart: `GET {origin}/v1/history` from the same Worker
 * origin as the live feed's snapshot. It runs only between `start()` and `stop()` (the app window is open)
 * and only while the page is visible: a hidden page schedules nothing, and becoming visible again fetches at
 * once when the last attempt is older than the refresh interval. A failure never touches the live feed; it is
 * reported as `error` and retried sooner than the normal refresh.
 */
import type { PresenceHistory } from './contract';
import { isPresenceHistory } from './presence-feed-guards';

export type HistoryLoad = { kind: 'ok'; data: PresenceHistory } | { kind: 'failed'; error: string };

/** Reads and validates one history answer; never throws. */
export async function loadPresenceHistory(
  origin: string,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<HistoryLoad> {
  try {
    const res = await fetchImpl(`${origin}/v1/history`, { headers: { accept: 'application/json' } });
    if (!res.ok) return { kind: 'failed', error: `history_${res.status}` };
    const body: unknown = await res.json();
    return isPresenceHistory(body) ? { kind: 'ok', data: body } : { kind: 'failed', error: 'history_invalid' };
  } catch {
    return { kind: 'failed', error: 'history_network' };
  }
}

export interface HistoryPollerDeps {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  /** Resolved at every fetch, so a newer ticket origin is picked up. */
  origin: () => string;
  now: () => number;
  /** Refresh interval while open and visible. */
  refreshMs: number;
  /** Retry delay after a failed load. */
  retryMs: number;
  /** Defaults to `document.visibilityState === 'visible'` (true without a document). */
  isVisible: () => boolean;
}

export interface HistoryPollerEvents {
  onLoading: () => void;
  onData: (history: PresenceHistory) => void;
  onError: (error: string) => void;
}

export const HISTORY_REFRESH_MS = 5 * 60_000;
export const HISTORY_RETRY_MS = 60_000;

const documentVisible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';

export interface HistoryPoller {
  start: () => void;
  stop: () => void;
}

export function createHistoryPoller(events: HistoryPollerEvents, overrides: Partial<HistoryPollerDeps> & Pick<HistoryPollerDeps, 'origin'>): HistoryPoller {
  const deps: HistoryPollerDeps = {
    fetchImpl: (input, init) => fetch(input, init),
    now: () => Date.now(),
    refreshMs: HISTORY_REFRESH_MS,
    retryMs: HISTORY_RETRY_MS,
    isVisible: documentVisible,
    ...overrides,
  };
  let running = false;
  let gen = 0; // bumps on stop so a late answer is dropped
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  /** Epoch ms the next load is due (0 = at once). */
  let dueAt = 0;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const schedule = () => {
    clear();
    if (!running || inFlight || !deps.isVisible()) return;
    timer = setTimeout(() => void load(), Math.max(0, dueAt - deps.now()));
  };

  async function load(): Promise<void> {
    if (!running || inFlight || !deps.isVisible()) return;
    const g = gen;
    inFlight = true;
    events.onLoading();
    const result = await loadPresenceHistory(deps.origin(), deps.fetchImpl);
    if (g !== gen) return; // stopped meanwhile: `stop()` already cleared `inFlight`
    inFlight = false;
    if (result.kind === 'ok') {
      dueAt = deps.now() + deps.refreshMs;
      events.onData(result.data);
    } else {
      dueAt = deps.now() + deps.retryMs;
      events.onError(result.error);
    }
    schedule();
  }

  const onVisibility = () => (deps.isVisible() ? schedule() : clear());

  return {
    start() {
      if (running) return;
      running = true;
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
      schedule();
    },
    stop() {
      if (!running) return;
      running = false;
      gen++;
      inFlight = false;
      clear();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
