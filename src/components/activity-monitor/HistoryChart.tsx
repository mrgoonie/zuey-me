import React, { useId, useMemo, useState } from 'react';
import type { ActivityCategory } from '../../lib/presence/contract';
import { formatHistorySlot, formatHistoryTime, historyTicks, type HistoryPoint, type HistorySeries } from '../../lib/presence/presence-history-chart';
import type { ActivityHistoryStrings } from './activity-history-i18n';

interface HistoryChartProps {
  series: HistorySeries;
  strings: ActivityHistoryStrings;
  categoryNames: Record<ActivityCategory, string>;
  locale: string;
}

const H = 100; // viewBox height; the width is one unit per slot
const STEP = { ArrowLeft: -1, ArrowRight: 1, PageUp: -12, PageDown: 12 } as const;
const isStepKey = (k: string): k is keyof typeof STEP => k in STEP;
const byCount = (p: HistoryPoint) => [...p.categories].sort((a, b) => b.count - a.count);

/**
 * Inline SVG area chart of `peak` per 5-minute slot. Pointer hover and keyboard focus (arrows, Page Up/Down
 * = one hour, Home/End) select a slot; its local time, peak and (when shared) category breakdown are shown in
 * a visual tooltip. Only keyboard focus and keyboard selection update a separate, visually hidden polite live
 * region, so moving the pointer across 288 slots never floods a screen reader. The plot's label is the
 * accessible summary (highest peak and when). Colours come from the Zuey OS theme tokens via CSS.
 */
export const HistoryChart: React.FC<HistoryChartProps> = ({ series, strings, categoryNames, locale }) => {
  const { points, max, maxIndex } = series;
  const n = points.length;
  const [selected, setSelected] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  /** Slot announced to screen readers; changed by focus and keys only, never by the pointer. */
  const [announced, setAnnounced] = useState<number | null>(null);
  const hintId = useId();

  const area = useMemo(() => {
    const y = (peak: number) => (max > 0 ? H - (peak / max) * (H - 4) : H);
    const line = points.map((p, i) => `L${i + 0.5},${y(p.peak).toFixed(2)}`).join(' ');
    return { fill: `M0,${H} ${line} L${n},${H} Z`, stroke: `M${line.slice(1)}` };
  }, [points, max, n]);
  const ticks = useMemo(() => historyTicks(points, locale), [points, locale]);

  const clamp = (i: number) => Math.min(n - 1, Math.max(0, i));
  const fmt = (v: number) => v.toLocaleString(locale);
  const peakAt = maxIndex >= 0 ? formatHistoryTime(points[maxIndex].t, locale) : '';

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width > 0) setSelected(clamp(Math.floor(((e.clientX - rect.left) / rect.width) * n)));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const from = selected ?? n - 1;
    let next: number | null = null;
    if (isStepKey(e.key)) next = clamp(from + STEP[e.key]);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape') {
      setSelected(null);
      setAnnounced(null);
    }
    if (next === null) return;
    e.preventDefault();
    setSelected(next);
    setAnnounced(next);
  };

  const point = selected === null ? null : points[selected];
  const breakdown = point ? byCount(point) : [];
  const announcedPoint = announced === null ? null : points[announced];
  const announcement = announcedPoint
    ? [
      formatHistorySlot(announcedPoint.t, locale),
      announcedPoint.gap ? strings.noBucket : strings.peak(fmt(announcedPoint.peak)),
      announcedPoint.categories.length > 0
        ? `${strings.breakdown}: ${byCount(announcedPoint).map((c) => `${categoryNames[c.id]} ${fmt(c.count)}`).join(', ')}`
        : '',
    ].filter(Boolean).join('. ')
    : '';

  return (
    <div className="am-hist-chart">
      <div
        className="am-hist-plot"
        role="group"
        tabIndex={0}
        aria-label={strings.chartLabel(fmt(max), peakAt)}
        aria-describedby={hintId}
        onPointerMove={onPointerMove}
        onPointerLeave={() => { if (!focused) setSelected(null); }}
        onFocus={() => {
          const at = selected ?? n - 1;
          setFocused(true);
          setSelected(at);
          setAnnounced(at);
        }}
        onBlur={() => { setFocused(false); setSelected(null); setAnnounced(null); }}
        onKeyDown={onKeyDown}
      >
        <svg viewBox={`0 0 ${n} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path className="am-hist-area" d={area.fill} />
          <path className="am-hist-line" d={area.stroke} vectorEffect="non-scaling-stroke" />
          {selected !== null && (
            <line className="am-hist-cursor" x1={selected + 0.5} x2={selected + 0.5} y1={0} y2={H} vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        <ol className="am-hist-ticks" aria-hidden="true">
          {ticks.map((t) => (
            <li key={t.index} style={{ left: `${((t.index + 0.5) / n) * 100}%` }}>{t.label}</li>
          ))}
        </ol>
      </div>
      <p id={hintId} className="am-sr">{strings.keyboardHint}</p>
      <p className="am-sr" role="status" aria-live="polite" aria-atomic="true" data-history-announcement>{announcement}</p>

      {/* Visual only: the live region above carries the same content for keyboard users. */}
      <div className="am-hist-tip" aria-hidden="true">
        {point && (
          <>
            <b>{formatHistorySlot(point.t, locale)}</b>
            <span>{point.gap ? strings.noBucket : strings.peak(fmt(point.peak))}</span>
            {breakdown.length > 0 && (
              <ul aria-label={strings.breakdown}>
                {breakdown.map((c) => (
                  <li key={c.id} data-category={c.id}>{categoryNames[c.id]}: {fmt(c.count)}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
};
