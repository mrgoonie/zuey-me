import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getFeedState, subscribeFeed, type FeedState } from '../../lib/presence/presence-feed';

const SERVER_STATE: FeedState = { snapshot: null, connection: 'connecting', updatedAt: null };

/**
 * Subscribes to the shared presence feed while `enabled` (the window is open and visible); the
 * shared connection closes when the last consumer disables itself.
 */
export function useActivityFeed(enabled: boolean): FeedState {
  // `subscribe` must keep its identity per `enabled`, or React would resubscribe (and reset the feed) every render.
  const subscribe = useCallback((onChange: () => void) => (enabled ? subscribeFeed(onChange) : () => undefined), [enabled]);
  const live = useSyncExternalStore(subscribe, getFeedState, () => SERVER_STATE);
  return enabled ? live : SERVER_STATE;
}

/** Epoch ms that ticks every second while `enabled`, to render "updated Xs ago". */
export function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

/** Follows `value`, but updates at most once per `ms`; used for screen-reader announcements. */
export function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const latest = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  latest.current = value;
  useEffect(() => {
    if (Object.is(shown, value) || timer.current) return;
    // One pending timer at a time, so a busy feed still announces every `ms` instead of never.
    timer.current = setTimeout(() => {
      timer.current = null;
      setShown(latest.current);
    }, ms);
  }, [value, shown, ms]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return shown;
}
