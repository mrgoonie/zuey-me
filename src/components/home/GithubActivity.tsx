import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, GitBranch, RefreshCw } from 'lucide-react';
import type { ActivityResult } from '../../lib/experience/github-activity';
import { countEventsByDay, localDate } from '../../lib/experience/activity-days';
import type { Locale } from '../../lib/i18n/locales';
import { LOCALE_LABELS } from '../../lib/i18n/locales';
import type { HomeStrings } from './home-i18n';
import { fmt } from './home-i18n';
import { apiFetch, parseActivity } from './api-client';
import { loadGsap, prefersReducedMotion } from './motion';

interface GithubActivityProps {
  strings: HomeStrings['activity'];
  locale: Locale;
}

type LoadState =
  | { kind: 'idle' | 'loading' }
  | { kind: 'ready'; result: ActivityResult }
  | { kind: 'rateLimited'; retryAfter: number | null }
  | { kind: 'offline' }
  | { kind: 'failed' };

const TIME_ZONE = 'Asia/Saigon';
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

/**
 * "What Zuey is doing": public GitHub events of @mrgoonie as a per-day bar graph (public events
 * only, not a contribution calendar) plus a dated event list. Loads when scrolled near.
 */
export const GithubActivity: React.FC<GithubActivityProps> = ({ strings, locale }) => {
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const lang = LOCALE_LABELS[locale].htmlLang;

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

  // Lazy: fetch once the section is near the viewport (or immediately via the #activity hash).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const start = () => {
      if (startedRef.current) return;
      startedRef.current = true;
      void load();
    };
    if (!('IntersectionObserver' in window) || window.location.hash === '#activity') {
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
  }, [load]);

  useEffect(() => {
    if (state.kind !== 'offline') return;
    const onOnline = () => void load();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [state.kind, load]);

  const result = state.kind === 'ready' ? state.result : null;
  const days = useMemo(
    () => (result ? countEventsByDay(result.snapshot.events, TIME_ZONE, result.snapshot.fetched_at) : []),
    [result],
  );
  const max = Math.max(1, ...days.map(d => d.count));

  // Bars grow in once per load.
  useEffect(() => {
    if (!result || prefersReducedMotion()) return;
    let cancelled = false;
    void loadGsap().then(gsap => {
      const bars = graphRef.current?.querySelectorAll('.home-bar span');
      if (cancelled || !gsap || !bars || bars.length === 0) return;
      gsap.from(bars, { scaleY: 0, duration: 0.5, ease: 'power2.out', stagger: { amount: 0.5 } });
    });
    return () => { cancelled = true; };
  }, [result]);

  const dateFmt = useMemo(() => new Intl.DateTimeFormat(lang, { timeZone: TIME_ZONE, day: 'numeric', month: 'short' }), [lang]);
  const timeFmt = useMemo(() => new Intl.DateTimeFormat(lang, { timeZone: TIME_ZONE, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), [lang]);
  const dayLabel = (date: string) => dateFmt.format(new Date(`${date}T12:00:00+07:00`));

  const events = result
    ? result.snapshot.events.filter(e => !selected || localDate(e.created_at, TIME_ZONE) === selected)
    : [];
  const shown = selected || expanded ? events : events.slice(0, LIST_LIMIT);

  const onGraphKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || days.length === 0) return;
    e.preventDefault();
    const current = selected ? days.findIndex(d => d.date === selected) : days.length - 1;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? days.length - 1
      : Math.max(0, Math.min(days.length - 1, current + (e.key === 'ArrowRight' ? 1 : -1)));
    setSelected(days[next].date);
    graphRef.current?.querySelector<HTMLButtonElement>(`[data-day="${days[next].date}"]`)?.focus();
  };

  const focusDay = selected ?? days[days.length - 1]?.date ?? null;

  return (
    <section ref={rootRef} id="activity" className="home-side-card home-card home-reveal" aria-labelledby="activity-title" tabIndex={-1} data-mascot-avoid>
      <div className="home-activity-head">
        <div>
          <p className="home-eyebrow flex items-center gap-1.5"><GitBranch aria-hidden="true" className="w-3.5 h-3.5" />{strings.subtitle}</p>
          <h2 id="activity-title" className="mt-1">{strings.title}</h2>
        </div>
        {result && (
          <p className="home-activity-meta">
            {fmt(strings.fetched, { time: timeFmt.format(new Date(result.snapshot.fetched_at)) })}
          </p>
        )}
      </div>

      <div aria-live="polite" aria-busy={state.kind === 'loading' || state.kind === 'idle'}>
        {(state.kind === 'idle' || state.kind === 'loading') && (
          <div aria-label={strings.loading} role="status">
            <div className="home-skeleton mt-[18px] h-[112px]" />
            <div className="home-skeleton mt-4 h-5 w-2/3" />
            <div className="home-skeleton mt-2 h-5 w-1/2" />
            <span className="sr-only">{strings.loading}</span>
          </div>
        )}

        {(state.kind === 'rateLimited' || state.kind === 'offline' || state.kind === 'failed') && (
          <div className="home-notice-line">
            <span>
              {state.kind === 'rateLimited'
                ? fmt(strings.rateLimited, { min: Math.max(1, Math.ceil((state.retryAfter ?? 900) / 60)) })
                : state.kind === 'offline' ? strings.offline : strings.failed}
            </span>
            {state.kind !== 'offline' && (
              <button type="button" className="home-cta home-cta--ghost !min-h-[36px]" onClick={() => void load()} data-press>
                <RefreshCw aria-hidden="true" className="w-4 h-4" />{strings.retry}
              </button>
            )}
          </div>
        )}

        {result && (
          <>
            {result.error && (
              <div className="home-notice-line">
                <span>{fmt(strings.stale, { time: timeFmt.format(new Date(result.snapshot.fetched_at)) })}</span>
                <button type="button" className="home-cta home-cta--ghost !min-h-[36px]" onClick={() => void load()} data-press>
                  <RefreshCw aria-hidden="true" className="w-4 h-4" />{strings.retry}
                </button>
              </div>
            )}

            {days.length > 0 ? (
              <>
                <p className="mt-4 text-[13px] text-stone-600">
                  {fmt(strings.window, { count: result.snapshot.events.length, from: dayLabel(days[0].date), to: dayLabel(days[days.length - 1].date) })}
                </p>
                <div
                  ref={graphRef}
                  className="home-graph"
                  data-sparse={days.length <= 21}
                  role="radiogroup"
                  aria-label={strings.graphLabel}
                  onKeyDown={onGraphKey}
                >
                  {days.map(d => (
                    <button
                      key={d.date}
                      type="button"
                      role="radio"
                      className="home-bar"
                      data-day={d.date}
                      data-zero={d.count === 0}
                      aria-checked={selected === d.date}
                      tabIndex={d.date === focusDay ? 0 : -1}
                      aria-label={fmt(strings.dayEvents, { count: d.count, date: dayLabel(d.date) })}
                      title={fmt(strings.dayEvents, { count: d.count, date: dayLabel(d.date) })}
                      onClick={() => setSelected(cur => (cur === d.date ? null : d.date))}
                    >
                      <span style={{ height: `${Math.max(3, (d.count / max) * 100)}%` }} />
                    </button>
                  ))}
                </div>
                <div className="home-graph-axis" aria-hidden="true">
                  <span>{dayLabel(days[0].date)}</span>
                  <span>{dayLabel(days[days.length - 1].date)}</span>
                </div>
              </>
            ) : (
              <p className="mt-4 text-sm text-stone-600">{strings.empty}</p>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[13px]">
              <span className="font-semibold text-stone-700" role="status">
                {selected
                  ? fmt(strings.dayEvents, { count: events.length, date: dayLabel(selected) })
                  : fmt(strings.showing, { count: shown.length })}
              </span>
              {selected && (
                <button type="button" className="home-cta home-cta--ghost !min-h-[36px]" onClick={() => setSelected(null)} data-press>
                  {strings.allDays}
                </button>
              )}
            </div>

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
