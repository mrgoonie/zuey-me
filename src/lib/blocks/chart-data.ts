/**
 * Chart v2 helpers shared by validation, the server and client renderers, Markdown and Studio: value formatting
 * (deterministic like data tables, so the server table and the hydrated one match), the data grid behind the
 * fallback table, Markdown and CSV, and download names. The Chart.js configuration lives in
 * chart-config.ts, which only the lazily loaded chart component imports.
 */
import type { ChartAxis, ChartBlock, ChartKind, ChartSeries } from './schema';
import { NUMBER_RE, csvField, foldText, formatCell } from './table-data';
import type { TableLocale } from './table-data';

/** Series colours, in order (also the legacy chart's palette). */
export const CHART_PALETTE = ['#d97706', '#1c1917', '#0f766e', '#be123c', '#4338ca', '#65a30d', '#c2410c', '#0369a1', '#a21caf', '#57534e', '#ca8a04', '#15803d'];

/** Kinds with an x axis of categories (the labels): stacking, the right-hand axis, annotations, date labels. */
export const CATEGORY_KINDS: readonly ChartKind[] = ['bar', 'line', 'area', 'combo'];
/** Kinds with x and y axes. */
export const CARTESIAN_KINDS: readonly ChartKind[] = [...CATEGORY_KINDS, 'scatter'];
/** Kinds drawn as slices: one colour and one legend entry per label. */
export const CIRCULAR_KINDS: readonly ChartKind[] = ['pie', 'doughnut'];

export const isCircular = (kind: ChartKind): boolean => CIRCULAR_KINDS.includes(kind);

export function paletteColor(i: number): string {
  return CHART_PALETTE[i % CHART_PALETTE.length] ?? '#d97706';
}

// ---------- formatting ----------

/** Axis a series is plotted against. */
export function seriesAxis(b: ChartBlock, s: ChartSeries): ChartAxis | undefined {
  return s.axis === 'right' ? b.y2 : b.y;
}

/**
 * A value as readers see it: fixed decimals when the axis sets them (otherwise at most 12 significant digits, so
 * tick steps such as 0.30000000000000004 read 0,3), the axis format in the edition's style, then the unit.
 */
export function formatChartValue(n: number, axis: ChartAxis | undefined, locale: TableLocale): string {
  if (!Number.isFinite(n)) return String(n);
  let raw = axis?.decimals !== undefined ? n.toFixed(axis.decimals) : String(Number(n.toPrecision(12)));
  // Values below 1e15 can still print with more than 10 decimals (1.23456789012), as exponents (1e-7) or round up
  // to 16 digits (999999999999999): round them to 10 decimals instead. Larger values are shown as written.
  if (!NUMBER_RE.test(raw) && Math.abs(n) < 1e15) raw = n.toFixed(10).replace(/\.?0+$/, '').replace(/^-0$/, '0');
  const format = axis?.format === 'percent' || axis?.format === 'currency' ? axis.format : 'number';
  // Exponent forms (1e+21) do not fit the grouping rules and are shown as written.
  const shown = NUMBER_RE.test(raw) ? formatCell({ type: format, ...(axis?.currency ? { currency: axis.currency } : {}) }, raw, locale).trim() : raw;
  return axis?.unit ? `${shown} ${axis.unit}` : shown;
}

/** A category label as readers see it: ISO dates in the edition's style when the x axis has `format: 'date'`. */
export function formatChartLabel(b: ChartBlock, label: string, locale: TableLocale): string {
  return b.x?.format === 'date' ? formatCell({ type: 'date' }, label, locale) : label;
}

// ---------- data grid (fallback table, Markdown, CSV, AI text) ----------

export interface ChartGrid { headers: string[]; rows: string[][] }

/**
 * The chart's data as a table: one row per label, one column per series (an x and a y column per series for
 * scatter charts). `value` and `label` choose display or canonical text.
 */
export function chartGrid(
  b: ChartBlock,
  labelHeader: string,
  value: (n: number, axis: ChartAxis | undefined) => string,
  label: (l: string) => string,
): ChartGrid {
  const scatter = b.kind === 'scatter';
  const headers = [labelHeader, ...b.series.flatMap(s => (scatter ? [`${s.name} (x)`, `${s.name} (y)`] : [s.name]))];
  const rows = b.labels.map((l, i) => [
    label(l),
    ...b.series.flatMap(s => {
      const y = value(s.data[i] ?? 0, seriesAxis(b, s));
      return scatter ? [value(s.x?.[i] ?? 0, b.x), y] : [y];
    }),
  ]);
  return { headers, rows };
}

/** Canonical grid: values as stored (machine-readable), labels as written. */
export function canonicalGrid(b: ChartBlock, labelHeader: string): ChartGrid {
  return chartGrid(b, labelHeader, n => String(n), l => l);
}

/**
 * RFC 4180 CSV of the canonical data (CRLF, UTF-8 BOM for spreadsheets); labels and names are formula-guarded.
 * Values are validated finite numbers printed by String(), so they stay numeric even when negative, long
 * (-0.30000000000000004) or in exponent form (-1e-7).
 */
export function chartCsv(b: ChartBlock, labelHeader: string): string {
  const grid = canonicalGrid(b, labelHeader);
  const value = (v: string) => (Number.isFinite(Number(v)) ? v : csvField(v));
  const lines = [grid.headers.map(h => csvField(h)), ...grid.rows.map(([l = '', ...values]) => [csvField(l), ...values.map(value)])];
  return `﻿${lines.map(l => l.join(',')).join('\r\n')}\r\n`;
}

/** Download name from the title (ASCII slug), else the block id. */
export function chartFilename(b: ChartBlock, ext: 'csv' | 'png'): string {
  const slug = foldText(b.title ?? '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${slug || `chart-${b.id}`}.${ext}`;
}

// ---------- Studio ----------

/**
 * The chart re-shaped for another kind, dropping what the new kind cannot use: scatter series get x values
 * (1, 2, 3, … when they had none), combo keeps series types, slices drop axes, stacking and marks.
 */
export function chartForKind(b: ChartBlock, kind: ChartKind): ChartBlock {
  const next: ChartBlock = { ...b, kind };
  const category = CATEGORY_KINDS.includes(kind);
  next.series = b.series.map(s => {
    const out: ChartSeries = { name: s.name, data: s.data };
    if (kind === 'combo' && s.type) out.type = s.type;
    if (category && s.axis) out.axis = s.axis;
    if (kind === 'scatter') out.x = s.x ?? s.data.map((_, i) => i + 1);
    return out;
  });
  if (!category) { delete next.stacked; delete next.annotations; }
  if (!CARTESIAN_KINDS.includes(kind)) delete next.references;
  for (const key of ['x', 'y', 'y2'] as const) {
    const axis = keepAxisFields(b[key], axisFields(kind, key), key === 'x' ? kind : undefined);
    if (axis) next[key] = axis;
    else delete next[key];
  }
  if (!next.series.some(s => s.axis === 'right')) {
    delete next.y2;
    // Reference lines measured on the removed right axis move to the main one.
    if (next.references) next.references = next.references.map(({ axis: _right, ...r }) => r);
  }
  return next;
}

const VALUE_FIELDS: readonly (keyof ChartAxis)[] = ['format', 'currency', 'decimals', 'unit'];

/**
 * Axis fields a kind uses. Category charts: an x title and date labels, every y field; scatter: every field on
 * both axes (number formats only on x); radar: the radial value range and format; pie and doughnut: the value
 * format of their tooltips and labels. y2 exists on category charts only.
 */
export function axisFields(kind: ChartKind, key: 'x' | 'y' | 'y2'): readonly (keyof ChartAxis)[] {
  const all: readonly (keyof ChartAxis)[] = ['title', 'min', 'max', ...VALUE_FIELDS];
  if (kind === 'scatter') return key === 'y2' ? [] : all;
  if (CATEGORY_KINDS.includes(kind)) return key === 'x' ? ['title', 'format'] : all;
  if (key !== 'y') return [];
  return kind === 'radar' ? ['min', 'max', ...VALUE_FIELDS] : VALUE_FIELDS;
}

function keepAxisFields(axis: ChartAxis | undefined, fields: readonly (keyof ChartAxis)[], xKind?: ChartKind): ChartAxis | undefined {
  if (!axis) return undefined;
  const out: ChartAxis = {};
  for (const f of fields) {
    if (axis[f] === undefined) continue;
    if (f === 'format') {
      // Category x axes take only date labels; value axes never do.
      const format = axis.format;
      const dateAxis = xKind !== undefined && xKind !== 'scatter';
      if ((format === 'date') === dateAxis && format) out.format = format;
    } else if (f === 'currency') {
      if (axis.format === 'currency' && axis.currency) out.currency = axis.currency;
    } else if (f === 'title' || f === 'unit') {
      const text = axis[f];
      if (text) out[f] = text;
    } else {
      const n = axis[f];
      if (n !== undefined) out[f] = n;
    }
  }
  return Object.keys(out).length ? out : undefined;
}
