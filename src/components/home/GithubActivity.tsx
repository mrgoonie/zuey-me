import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ExternalLink, GitBranch, RefreshCw, X } from 'lucide-react';
import type { ActivityResult } from '../../lib/experience/github-activity';
import { localDate } from '../../lib/experience/activity-days';
import type { Locale } from '../../lib/i18n/locales';
import { LOCALE_LABELS } from '../../lib/i18n/locales';
import type { HomeStrings } from './home-i18n';
import { fmt } from './home-i18n';
import { apiFetch, parseActivity } from './api-client';
import { ContributionGraph, useContributionCalendar } from './ContributionGraph';

interface GithubActivityProps {
  strings: HomeStrings['activity'];
  locale: Locale;
  /** `window`: no card chrome and loads immediately (hosted in a Zuey OS window). Default `section`. */
  variant?: 'section' | 'window';
}

type LoadState =
  | { kind: 'idle' | 'loading' }
  | { kind: 'ready'; result: ActivityResult }
  | { kind: 'rateLimited'; retryAfter: number | null }
  | { kind: 'offline' }
  | { kind: 'failed' };

const LIST_LIMIT = 12;

function eventTitle(e: ActivityResult['snapshot']['events'][number], s: HomeStrings['activity']): string {
  if (e.title) return e.number ? `#${e.number} ${e.title}` : e.title;
  if (e.type === 'PushEvent') {
    const branch = e.ref ? e.ref.replace(/^refs\/heads\//, '') : '';
    const commits = e.commits ? fmt(s.commits, { n: e.commits }) : '';
    return [branch, commits].filter(Boolean).join(' · ') || e.repo;
  }
  if ((e.type === 'CreateEvent' || e.type === 'DeleteEvent') && e.ref_type) return e.ref ? `${e.ref_type} ${e.ref}` : e.ref_type;
  return e.repo;
}

const rateLimitedMinutes = (retryAfter: number | null) => Math.max(1, Math.ceil((retryAfter ?? 900) / 60));

/**
 * "What Zuey is doing": the GitHub contribution calendar of @mrgoonie (53 weeks) above the list of
 * recent public events. Picking a day filters the list to that date in the viewer's time zone.
 * The section variant loads when scrolled near.
 */
export const GithubActivity: React.FC<GithubActivityProps> = ({ strings, locale, variant = 'section' }) => {
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [started, setStarted] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const startedRef = useRef(false);
  const titleId = useId();
  const lang = LOCALE_LABELS[locale].htmlLang;
  const calendar = useContributionCalendar(started);

  const load = useCallback(async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setState({ kind: 'offline' });
      return;
    }
    setState({ kind: 'loading' });
    const res = await apiFetch('/api/v1/github/activity', parseActivity);
    if (res.ok) setState({ kind: 'ready', result: res.data });
    else if (res.status === 0) setState({ kind: 'offline' });
    else if (res.code === 'github_rate_limited' || res.status === 429) setState({ kind: 'rateLimited', retryAfter: res.retryAfter });
    else setState({ kind: 'failed' });
  }, []);

  // Lazy: fetch once the section is near the viewport (or immediately via #activity / in a window).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const start = () => {
      if (startedRef.current) return;
      startedRef.current = true;
      setStarted(true);
      void load();
    };
    if (variant === 'window' || !('IntersectionObserver' in window) || window.location.hash === '#activity') {
      start();
      return;
    }
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        start();
        io.disconnect();
      }
    }, { rootMargin: '400px 0px' });
    io.observe(el);
    const onHash = () => { if (window.location.hash === '#activity') start(); };
    window.addEventListener('hashchange', onHash);
    return () => {
      io.disconnect();
      window.removeEventListener('hashchange', onHash);
    };
  }, [load, variant]);

  const calendarOffline = calendar.error?.status === 0 && !calendar.data;
  const reloadCalendar = calendar.reload;
  useEffect(() => {
    if (state.kind !== 'offline' && !calendarOffline) return;
    const onOnline = () => {
      if (state.kind === 'offline') void load();
      if (calendarOffline) reloadCalendar();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [state.kind, calendarOffline, load, reloadCalendar]);

  const result = state.kind === 'ready' ? state.result : null;
  // The viewer's own zone: calendar days are compared with event times as the viewer sees them.
  const viewerTz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const dayFmt = useMemo(() => new Intl.DateTimeFormat(lang, { timeZone: 'UTC', day: 'numeric', month: 'short' }), [lang]);
  const shortFmt = useMemo(() => new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short' }), [lang]);
  const timeFmt = useMemo(() => new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), [lang]);
  const dayLabel = (date: string) => dayFmt.format(new Date(`${date}T00:00:00Z`));

  const allEvents = result ? result.snapshot.events : [];
  const events = selected ? allEvents.filter(e => localDate(e.created_at, viewerTz) === selected) : allEvents;
  const shown = selected || expanded ? events : events.slice(0, LIST_LIMIT);
  const calendarDays = calendar.data?.days ?? [];

  const retryButton = (onClick: () => void) => (
    <button type="button" className="home-cta home-cta--ghost !min-h-[36px]" onClick={onClick} data-press>
      <RefreshCw aria-hidden="true" className="w-4 h-4" />{strings.retry}
    </button>
  );

  return (
    <section
      ref={rootRef}
      id={variant === 'section' ? 'activity' : undefined}
      className={variant === 'section' ? 'home-side-card home-card home-reveal' : 'p-4 sm:p-5'}
      aria-labelledby={titleId}
      tabIndex={-1}
      data-mascot-avoid
    >
      <div className="home-activity-head">
        <div>
          <p className="home-eyebrow flex items-center gap-1.5"><GitBranch aria-hidden="true" className="w-3.5 h-3.5" />{strings.subtitle}</p>
          <h2 id={titleId} className="mt-1">{strings.title}</h2>
        </div>
        {result && (
          <p className="home-activity-meta">
            {fmt(strings.fetched, { time: timeFmt.format(new Date(result.snapshot.fetched_at)) })}
          </p>
        )}
      </div>

      <div className="mt-4" aria-busy={!calendar.data && !calendar.error}>
        {calendar.data && calendarDays.length > 0 ? (
          <>
            {calendar.data.error && (
              <div className="home-notice-line !mt-0 mb-3">
                <span>{fmt(strings.calendar.stale, { time: timeFmt.format(new Date(calendar.data.fetched_at)) })}</span>
                {retryButton(calendar.reload)}
              </div>
            )}
            <ContributionGraph
              days={calendarDays}
              total={calendar.data.total}
              locale={locale}
              strings={strings.calendar}
              selected={selected}
              onSelect={date => { setSelected(date); setExpanded(false); }}
            />
          </>
        ) : calendar.error ? (
          <div className="home-notice-line !mt-0">
            <span>
              {calendar.error.status === 0 ? strings.offline
                : calendar.error.code === 'github_rate_limited' ? fmt(strings.rateLimited, { min: rateLimitedMinutes(calendar.error.retryAfter) })
                : strings.calendar.failed}
            </span>
            {calendar.error.status !== 0 && retryButton(calendar.reload)}
          </div>
        ) : (
          <div role="status" aria-label={strings.loading}>
            <div className="home-skeleton h-[112px]" />
          </div>
        )}
      </div>

      <div aria-live="polite" aria-busy={state.kind === 'loading' || state.kind === 'idle'}>
        {(state.kind === 'idle' || state.kind === 'loading') && (
          <div aria-label={strings.loading} role="status">
            <div className="home-skeleton mt-4 h-5 w-2/3" />
            <div className="home-skeleton mt-2 h-5 w-1/2" />
            <span className="sr-only">{strings.loading}</span>
          </div>
        )}

        {(state.kind === 'rateLimited' || state.kind === 'offline' || state.kind === 'failed') && (
          <div className="home-notice-line">
            <span>
              {state.kind === 'rateLimited'
                ? fmt(strings.rateLimited, { min: rateLimitedMinutes(state.retryAfter) })
                : state.kind === 'offline' ? strings.offline : strings.failed}
            </span>
            {state.kind !== 'offline' && retryButton(() => void load())}
          </div>
        )}

        {result && (
          <>
            {result.error && (
              <div className="home-notice-line">
                <span>{fmt(strings.stale, { time: timeFmt.format(new Date(result.snapshot.fetched_at)) })}</span>
                {retryButton(() => void load())}
              </div>
            )}

            {allEvents.length > 0 && !selected && (
              <p className="mt-4 text-[13px] text-stone-600">
                {fmt(strings.window, {
                  count: allEvents.length,
                  from: shortFmt.format(new Date(allEvents[allEvents.length - 1].created_at)),
                  to: shortFmt.format(new Date(allEvents[0].created_at)),
                })}
              </p>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[13px]">
              <span className="font-semibold text-stone-700" role="status">
                {selected
                  ? fmt(strings.dayEvents, { count: events.length, date: dayLabel(selected) })
                  : fmt(strings.showing, { count: shown.length })}
              </span>
              {selected && (
                <button
                  type="button"
                  className="home-cta home-cta--ghost !min-h-[36px]"
                  onClick={() => setSelected(null)}
                  aria-label={`${strings.calendar.clear}: ${dayLabel(selected)}`}
                  data-press
                >
                  {dayLabel(selected)}
                  <X aria-hidden="true" className="w-4 h-4" />
                </button>
              )}
            </div>

            {allEvents.length === 0 && <p className="mt-4 text-sm text-stone-600">{strings.empty}</p>}
            {selected && events.length === 0 && allEvents.length > 0 && (
              <p className="mt-3 text-sm text-stone-600">{strings.calendar.noEventsDay}</p>
            )}

            <ol className="home-events">
              {shown.map(e => (
                <li key={e.id} className="home-event">
                  <time dateTime={e.created_at}>{timeFmt.format(new Date(e.created_at))}</time>
                  <div className="min-w-0">
                    <span className="home-event-type">{strings.types[e.type] ?? e.type.replace(/Event$/, '')}</span>
                    <a href={e.url} target="_blank" rel="noopener noreferrer">
                      {eventTitle(e, strings)}
                      <ExternalLink aria-hidden="true" className="ml-1 inline w-3 h-3 align-[-1px]" />
                    </a>
                    <span className="block truncate text-[12px] text-stone-500">{e.repo}</span>
                  </div>
                </li>
              ))}
            </ol>
            {shown.length < events.length && (
              <button type="button" className="home-cta home-cta--ghost mt-3 w-full" onClick={() => setExpanded(true)} data-press>
                {fmt(strings.showMore, { count: events.length })}
              </button>
            )}

            <p className="mt-4 text-[12px] leading-relaxed text-stone-500">
              {strings.disclaimer}{' '}
              <a className="underline underline-offset-2 hover:text-stone-900" href={`https://github.com/${result.snapshot.user}`} target="_blank" rel="noopener noreferrer">
                github.com/{result.snapshot.user}
              </a>
            </p>
          </>
        )}
      </div>
    </section>
  );
};
