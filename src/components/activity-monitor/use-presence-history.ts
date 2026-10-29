import { useEffect, useState } from 'react';
import type { PresenceHistory } from '../../lib/presence/contract';
import { getFeedOrigin } from '../../lib/presence/presence-feed';
import { createHistoryPoller } from '../../lib/presence/presence-history';

export interface HistoryState {
  /** Last valid history (kept through a failed refresh); null until one arrives. */
  history: PresenceHistory | null;
  loading: boolean;
  /** Machine reason of the latest failed load; cleared by the next success. */
  error: string | null;
}

const INITIAL: HistoryState = { history: null, loading: false, error: null };

/**
 * 24h history for the Activity Monitor, loaded only while `enabled` (the window is open) and the page is
 * visible, refreshed about every 5 minutes from the live feed's Worker origin. Closing the window stops it.
 */
export function usePresenceHistory(enabled: boolean): HistoryState {
  const [state, setState] = useState<HistoryState>(INITIAL);
  useEffect(() => {
    if (!enabled) return;
    const poller = createHistoryPoller(
      {
        onLoading: () => setState((s) => ({ ...s, loading: true })),
        onData: (history) => setState({ history, loading: false, error: null }),
        onError: (error) => setState((s) => ({ ...s, loading: false, error })),
      },
      { origin: getFeedOrigin },
    );
    poller.start();
    return () => {
      poller.stop();
      setState((s) => ({ ...s, loading: false }));
    };
  }, [enabled]);
  return state;
}
