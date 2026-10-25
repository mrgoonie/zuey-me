/**
 * Number formatting for the composition widgets (stat, progress). Deterministic on purpose: the server and
 * the browser produce byte-identical text (no Intl differences between runtimes), and the module stays tiny
 * so the article renderer does not pull in the data-table formatters.
 */
import type { ProgressBlock, ProgressItem, ProgressState, StatItem, StatState, StatTrend } from './schema';
import { DEFAULT_PROGRESS_SEGMENTS, DEFAULT_RATING_MAX } from './schema';

/** Most decimals a widget number may carry (the `decimals` limit in validation). */
const MAX_DECIMALS = 4;

/**
 * Canonical value for Markdown, AI text and search: `.` separator, no grouping. With `decimals` the value is
 * fixed to that many places; without, it keeps its own precision (up to four places) so 4.5 never reads as 5.
 * Rounding to four places and back to the shortest round-trip form drops the binary float digits that
 * `toFixed` would print for large fractional values (123456789012345.67 stays `.67`, not `.6719`).
 */
export function canonicalNumber(value: number, decimals?: number): string {
  const s = decimals === undefined ? String(Number(value.toFixed(MAX_DECIMALS))) : value.toFixed(decimals);
  return /^-0(?:\.0+)?$/.test(s) ? s.slice(1) : s;
}

/** Edition style: Vietnamese (default) groups with `.` and uses `,` for decimals; English the reverse. */
export function localeNumber(value: number, decimals?: number, locale?: string): string {
  const en = locale !== undefined && locale !== 'vi';
  const s = canonicalNumber(value, decimals);
  const negative = s.startsWith('-');
  const [int, frac] = (negative ? s.slice(1) : s).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, en ? ',' : '.');
  return `${negative ? '-' : ''}${grouped}${frac !== undefined ? `${en ? '.' : ','}${frac}` : ''}`;
}

type Formatter = (value: number, decimals?: number) => string;

/** A stat value with its prefix, suffix and unit. */
export function statValue(item: StatItem, format: Formatter): string {
  return `${item.prefix ?? ''}${format(item.value, item.decimals)}${item.suffix ?? ''}${item.unit ? ` ${item.unit}` : ''}`;
}

/** A stat delta with an explicit sign (+12%, -3). */
export function statDelta(item: StatItem, format: Formatter): string | undefined {
  const d = item.delta;
  if (!d) return undefined;
  const shown = format(d.value, d.decimals);
  return `${d.value > 0 && !/^0(?:[.,]0+)?$/.test(shown) ? '+' : ''}${shown}${d.suffix ?? ''}`;
}

export function statTrend(item: StatItem): StatTrend | undefined {
  if (item.trend) return item.trend;
  if (!item.delta) return undefined;
  return item.delta.value > 0 ? 'up' : item.delta.value < 0 ? 'down' : 'flat';
}

export function statState(item: StatItem): StatState {
  if (item.state) return item.state;
  const trend = statTrend(item);
  return trend === 'up' ? 'positive' : trend === 'down' ? 'negative' : 'neutral';
}

/** Scale of a progress block: ratings run from 0 to their star count. */
export function progressScale(block: ProgressBlock): { min: number; max: number } {
  if (block.variant === 'rating') return { min: 0, max: block.max ?? DEFAULT_RATING_MAX };
  return { min: block.min ?? 0, max: block.max ?? 100 };
}

/** Share of the scale an item fills, 0–1. */
export function progressRatio(block: ProgressBlock, item: ProgressItem): number {
  const { min, max } = progressScale(block);
  return max > min ? Math.min(1, Math.max(0, (item.value - min) / (max - min))) : 0;
}

export function progressSegments(block: ProgressBlock): number {
  return block.segments ?? DEFAULT_PROGRESS_SEGMENTS;
}

/** State of the highest threshold the value reaches; neutral without thresholds. */
export function progressState(block: ProgressBlock, item: ProgressItem): ProgressState {
  let state: ProgressState = 'neutral';
  for (const t of block.thresholds ?? []) if (item.value >= t.at) state = t.state;
  return state;
}

/** Visible value of an item: `72%` on the default 0–100 scale, otherwise `value / max` (`4.5 / 5` for a rating). */
export function progressText(block: ProgressBlock, item: ProgressItem, format: Formatter): string {
  const { min, max } = progressScale(block);
  const suffix = block.suffix ?? '';
  const value = format(item.value, block.decimals);
  if (block.variant !== 'rating' && min === 0 && max === 100 && (suffix === '' || suffix === '%')) return `${value}%`;
  const end = format(max, Number.isInteger(max) ? 0 : block.decimals);
  return block.variant === 'rating' ? `${value} / ${end}` : `${value}${suffix} / ${end}${suffix}`;
}
