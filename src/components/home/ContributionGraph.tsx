import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CalendarDay, ContributionCalendar } from '../../lib/experience/github-calendar';
import type { Locale } from '../../lib/i18n/locales';
import { LOCALE_LABELS } from '../../lib/i18n/locales';
import type { ApiResult } from './api-client';
import { apiFetch, parseCalendar } from './api-client';
import { fmt } from './home-i18n';
import './contribution-graph.css';

export interface ContributionGraphStrings {
  /** Accessible name of the grid. */
  label: string;
  /** '{count} contributions in the last year' */
  total: string;
  totalUnknown: string;
  dayNone: string;
  dayOne: string;
  dayMany: string;
  /** Used when GitHub exposed only the intensity level: '{level}', '{date}'. */
  dayLevel: string;
  less: string;
  more: string;
}

export interface ContributionGraphProps {
  days: CalendarDay[];
  total: number | null;
  locale: Locale;
  /** Fits the width with no labels, legend or interaction; the grid is hidden from assistive tech. */
  compact?: boolean;
  selected?: string | null;
  onSelect?: (date: string | null) => void;
  strings: ContributionGraphStrings;
  className?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const LEVELS: CalendarDay['level'][] = [0, 1, 2, 3, 4];
const toMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const toDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Layout {
  /** 7 rows (Sun..Sat) × week columns; null = outside the calendar. */
  rows: (CalendarDay | null)[][];
  weeks: number;
  months: { key: string; label: string; span: number }[];
  byDate: Map<string, CalendarDay>;
  first: string | null;
  last: string | null;
}

function buildLayout(days: CalendarDay[], monthFmt: Intl.DateTimeFormat): Layout {
  const byDate = new Map(days.map(d => [d.date, d]));
  const rows: (CalendarDay | null)[][] = Array.from({ length: 7 }, () => []);
  if (days.length === 0) return { rows, weeks: 0, months: [], byDate, first: null, last: null };
  const first = days[0].date;
  const last = days[days.length - 1].date;
  const start = toMs(first) - new Date(toMs(first)).getUTCDay() * DAY_MS;
  const end = toMs(last) + (6 - new Date(toMs(last)).getUTCDay()) * DAY_MS;
  const weekMonths: string[] = [];
  for (let ms = start, i = 0; ms <= end; ms += DAY_MS, i += 1) {
    const date = toDate(ms);
    rows[i % 7].push(byDate.get(date) ?? null);
    if (i % 7 === 0) weekMonths.push((date < first ? first : date).slice(0, 7));
  }
  const months: Layout['months'] = [];
  weekMonths.forEach((m, c) => {
    const prev = months[months.length - 1];
    if (prev && weekMonths[c - 1] === m) prev.span += 1;
    else months.push({ key: `${m}-${c}`, label: monthFmt.format(new Date(`${m}-01T00:00:00Z`)), span: 1 });
  });
  // GitHub drops a leading month label that would collide with the next one.
  if (months.length > 1 && months[0].span < 3) months[0].label = '';
  return { rows, weeks: weekMonths.length, months, byDate, first, last };
}

/**
 * GitHub-profile style contribution heatmap: 7 rows × up to 53 week columns, month and weekday
 * labels, Less–More legend and a yearly total. Non-compact cells form an ARIA grid with a roving
 * tabindex (arrows move by day/week, Enter/Space toggles the selected day).
 */
export const ContributionGraph: React.FC<ContributionGraphProps> = ({
  days, total, locale, compact = false, selected = null, onSelect, strings, className,
}) => {
  const lang = LOCALE_LABELS[locale].htmlLang;
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);

  const { dateFmt, monthFmt, weekdayShort, weekdayLong, numFmt } = useMemo(() => {
    const weekday = (style: 'short' | 'long') => {
      const f = new Intl.DateTimeFormat(lang, { timeZone: 'UTC', weekday: style });
      // 2023-01-01 was a Sunday.
      return Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2023, 0, 1 + i))));
    };
    return {
      dateFmt: new Intl.DateTimeFormat(lang, { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' }),
      monthFmt: new Intl.DateTimeFormat(lang, { timeZone: 'UTC', month: 'short' }),
      weekdayShort: weekday('short'),
      weekdayLong: weekday('long'),
      numFmt: new Intl.NumberFormat(lang),
    };
  }, [lang]);

  const layout = useMemo(() => buildLayout(days, monthFmt), [days, monthFmt]);

  const describe = useCallback((d: CalendarDay) => {
    const date = dateFmt.format(new Date(toMs(d.date)));
    if (d.count === null) return fmt(strings.dayLevel, { level: d.level, date });
    if (d.count === 0) return fmt(strings.dayNone, { date });
    if (d.count === 1) return fmt(strings.dayOne, { date });
    return fmt(strings.dayMany, { count: numFmt.format(d.count), date });
  }, [dateFmt, numFmt, strings]);

  // Show the most recent weeks first when the grid has to scroll (like github.com).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && !compact) el.scrollLeft = el.scrollWidth;
  }, [compact, layout.weeks]);

  const focusDate = focus && layout.byDate.has(focus) ? focus
    : selected && layout.byDate.has(selected) ? selected
    : layout.last;

  const showTip = (el: HTMLElement, d: CalendarDay) => {
    const root = rootRef.current;
    if (!root) return;
    const r = el.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    const x = Math.min(Math.max(r.left - box.left + r.width / 2, 72), Math.max(72, box.width - 72));
    setTip({ text: describe(d), x, y: r.top - box.top });
  };

  const toggle = (date: string) => onSelect?.(selected === date ? null : date);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTableElement>) => {
    if (!(e.target instanceof HTMLElement)) return;
    const date = e.target.dataset.date;
    if (!date || !layout.first || !layout.last) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle(date);
      return;
    }
    const step: Record<string, number> = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
    let next: string;
    if (e.key === 'Home') next = layout.first;
    else if (e.key === 'End') next = layout.last;
    else if (e.key in step) next = toDate(toMs(date) + step[e.key] * DAY_MS);
    else return;
    e.preventDefault();
    if (!layout.byDate.has(next)) return;
    setFocus(next);
    rootRef.current?.querySelector<HTMLElement>(`[data-date="${next}"]`)?.focus();
  };

  const totalText = total !== null ? fmt(strings.total, { count: numFmt.format(total) }) : strings.totalUnknown;

  return (
    <div
      ref={rootRef}
      className={['cg', compact ? 'cg--compact' : '', className ?? ''].filter(Boolean).join(' ')}
      data-has-selection={!compact && selected !== null && layout.byDate.has(selected)}
    >
      <div ref={scrollRef} className="cg-scroll" data-no-swipe={compact ? undefined : true}>
        <table
          className="cg-table"
          role={compact ? 'presentation' : 'grid'}
          aria-label={compact ? undefined : strings.label}
          aria-hidden={compact || undefined}
          aria-readonly={compact ? undefined : true}
          onKeyDown={compact ? undefined : onKeyDown}
        >
          <colgroup>
            {!compact && <col className="cg-col-label" />}
            {Array.from({ length: layout.weeks }, (_, i) => <col key={i} />)}
          </colgroup>
          {!compact && (
            <thead>
              <tr>
                <td aria-hidden="true" />
                {layout.months.map(m => (
                  <th key={m.key} scope="colgroup" colSpan={m.span} className="cg-month">{m.label}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {layout.rows.map((row, r) => (
              <tr key={r}>
                {!compact && (
                  <th scope="row" className="cg-wd">
                    {r % 2 === 1 && <span className="cg-wd-text" aria-hidden="true">{weekdayShort[r]}</span>}
                    <span className="sr-only">{weekdayLong[r]}</span>
                  </th>
                )}
                {row.map((d, c) => {
                  if (!d) return <td key={`pad-${c}`} className="cg-pad" aria-hidden="true" />;
                  if (compact) return <td key={d.date} data-level={d.level}><span className="cg-sq" /></td>;
                  return (
                    <td
                      key={d.date}
                      role="gridcell"
                      className="cg-cell"
                      data-date={d.date}
                      data-level={d.level}
                      tabIndex={d.date === focusDate ? 0 : -1}
                      aria-selected={selected === d.date}
                      aria-label={describe(d)}
                      onClick={() => { setFocus(d.date); toggle(d.date); }}
                      onMouseEnter={e => showTip(e.currentTarget, d)}
                      onMouseLeave={() => setTip(null)}
                      onFocus={e => { setFocus(d.date); showTip(e.currentTarget, d); }}
                      onBlur={() => setTip(null)}
                    >
                      <span className="cg-sq" />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="cg-foot">
        <p className="cg-total">{totalText}</p>
        {!compact && (
          <div className="cg-legend" aria-hidden="true">
            <span>{strings.less}</span>
            {LEVELS.map(l => <span key={l} className="cg-sq" data-level={l} />)}
            <span>{strings.more}</span>
          </div>
        )}
      </div>
      {tip && !compact && (
        <div className="cg-tip" aria-hidden="true" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>
      )}
    </div>
  );
};

export interface ContributionCalendarState {
  data: ContributionCalendar | null;
  /** Last failure; status 0 means the network request itself failed (offline). */
  error: { status: number; code: string; retryAfter: number | null } | null;
  loading: boolean;
  /** Refetches, bypassing the shared in-page cache. */
  reload: () => void;
}

const SHARED_TTL_MS = 5 * 60 * 1000;
let shared: { at: number; promise: Promise<ApiResult<ContributionCalendar>> } | null = null;

/** One request per page for every mounted graph (window, widget); failures are never reused. */
function fetchShared(force: boolean): Promise<ApiResult<ContributionCalendar>> {
  if (!force && shared && Date.now() - shared.at < SHARED_TTL_MS) return shared.promise;
  const promise = apiFetch('/api/v1/github/calendar', parseCalendar);
  const entry = { at: Date.now(), promise };
  shared = entry;
  void promise.then(res => {
    if (!res.ok && shared === entry) shared = null;
  });
  return promise;
}

/** Loads `/api/v1/github/calendar` once `enabled` is true (default: on mount). */
export function useContributionCalendar(enabled = true): ContributionCalendarState {
  const [state, setState] = useState<Omit<ContributionCalendarState, 'reload'>>({ data: null, error: null, loading: false });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState(s => ({ ...s, loading: true }));
    void fetchShared(nonce > 0).then(res => {
      if (cancelled) return;
      setState(s => (res.ok
        ? { data: res.data, error: null, loading: false }
        : { data: s.data, error: { status: res.status, code: res.code, retryAfter: res.retryAfter }, loading: false }));
    });
    return () => { cancelled = true; };
  }, [enabled, nonce]);

  const reload = useCallback(() => setNonce(n => n + 1), []);
  return { ...state, reload };
}
