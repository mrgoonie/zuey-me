import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
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

interface RemotePanelProps<T> {
  state: RemoteData<T>;
  onRetry: () => void;
  /** Standalone route with the same content, offered when loading fails. */
  href: string;
  strings: { loading: string; failed: string; retry: string; openPage: string };
  children: (data: T) => ReactNode;
}

/**
 * A remote panel: loading skeleton, error (with retry and a link to the standalone page) or the content.
 * One focusable container stays mounted through every state, so "Try again" moves focus to it (the
 * button itself disappears while loading) instead of dropping focus to <body>, and the reader stays
 * in place when the content arrives.
 */
export function RemotePanel<T>({ state, onRetry, href, strings, children }: RemotePanelProps<T>) {
  const region = useRef<HTMLDivElement>(null);
  const retry = () => {
    onRetry();
    region.current?.focus();
  };
  return (
    <div ref={region} tabIndex={-1} className="min-w-0 focus:outline-none" aria-busy={state.status === 'loading'}>
      {state.status === 'ready' && children(state.data)}
      {state.status === 'loading' && (
        <div className="flex flex-col gap-3 p-4" role="status">
          <span className="sr-only">{strings.loading}</span>
          {[0, 1, 2, 3].map(i => <div key={i} className="h-20 rounded-2xl bg-white/10 animate-pulse" aria-hidden="true" />)}
        </div>
      )}
      {state.status === 'error' && (
        <div className="flex flex-col items-center gap-3 p-8 text-center text-sm text-stone-200" role="alert">
          <p>{strings.failed}</p>
          <div className="flex gap-3">
            <button type="button" onClick={retry} className="rounded-full bg-white/15 px-4 py-1.5 font-semibold hover:bg-white/25">{strings.retry}</button>
            <a href={href} className="rounded-full px-4 py-1.5 font-semibold underline hover:text-white">{strings.openPage}</a>
          </div>
        </div>
      )}
    </div>
  );
}

/** Copy for {@link RemotePanel}; the homepage locale is `vi` or `en`. */
export function remotePanelStrings(locale: string): RemotePanelProps<unknown>['strings'] {
  return locale === 'vi'
    ? { loading: 'Đang tải…', failed: 'Không tải được nội dung.', retry: 'Thử lại', openPage: 'Mở trang riêng' }
    : { loading: 'Loading…', failed: 'Could not load this content.', retry: 'Try again', openPage: 'Open the page' };
}
