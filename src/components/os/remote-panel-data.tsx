import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../home/api-client';

/**
 * Data for a Zuey OS window panel, fetched when the panel hydrates instead of being serialized
 * into the homepage HTML. Panels hydrate `client:visible`, so a closed (hidden) window never
 * fetches; the request starts the first time the window is shown.
 */
export type RemoteData<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; message: string };

export function useRemoteData<T>(url: string, parse: (data: unknown) => T | null): { state: RemoteData<T>; retry: () => void } {
  const [state, setState] = useState<RemoteData<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void apiFetch(url, parse).then(res => {
      if (cancelled) return;
      setState(res.ok ? { status: 'ready', data: res.data } : { status: 'error', message: res.message });
    });
    return () => { cancelled = true; };
  }, [url, parse, attempt]);

  const retry = useCallback(() => setAttempt(n => n + 1), []);
  return { state, retry };
}

interface RemotePanelStatusProps {
  state: { status: 'loading' } | { status: 'error'; message: string };
  onRetry: () => void;
  /** Standalone route with the same content, offered when loading fails. */
  href: string;
  strings: { loading: string; failed: string; retry: string; openPage: string };
}

/** Loading skeleton or error (with retry and a link to the standalone page) for a remote panel. */
export const RemotePanelStatus: React.FC<RemotePanelStatusProps> = ({ state, onRetry, href, strings }) => {
  if (state.status === 'loading') {
    return (
      <div className="flex flex-col gap-3 p-4" role="status" aria-busy="true">
        <span className="sr-only">{strings.loading}</span>
        {[0, 1, 2, 3].map(i => <div key={i} className="h-20 rounded-2xl bg-white/10 animate-pulse" aria-hidden="true" />)}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 p-8 text-center text-sm text-stone-200" role="alert">
      <p>{strings.failed}</p>
      <div className="flex gap-3">
        <button type="button" onClick={onRetry} className="rounded-full bg-white/15 px-4 py-1.5 font-semibold hover:bg-white/25">{strings.retry}</button>
        <a href={href} className="rounded-full px-4 py-1.5 font-semibold underline hover:text-white">{strings.openPage}</a>
      </div>
    </div>
  );
};

/** Copy for {@link RemotePanelStatus}; the homepage locale is `vi` or `en`. */
export function remotePanelStrings(locale: string): RemotePanelStatusProps['strings'] {
  return locale === 'vi'
    ? { loading: 'Đang tải…', failed: 'Không tải được nội dung.', retry: 'Thử lại', openPage: 'Mở trang riêng' }
    : { loading: 'Loading…', failed: 'Could not load this content.', retry: 'Try again', openPage: 'Open the page' };
}
