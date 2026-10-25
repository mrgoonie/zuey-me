/** Chart block: the original bar/line/pie/doughnut payload plus the optional v2 kinds and options. */
import type { BlockDefinition, BlockValidator, RawBlock } from '../block-definition';
import { CHART_FORMATS, CHART_KINDS, CHART_LEGENDS, CHART_SERIES_TYPES, LIMITS, isChartV2 } from '../schema';
import type { ChartAnnotation, ChartAxis, ChartBlock, ChartKind, ChartReference, ChartSeries } from '../schema';
import { gfmTable, mdCaption } from '../markdown-format';
import { CARTESIAN_KINDS, CATEGORY_KINDS, axisFields, canonicalGrid } from '../chart-data';
import { CURRENCY_RE, canonicalCell } from '../table-data';
import { short } from './schema-fragments';
import { flag, isInt, isObj, isOneOf, plain, plainLength } from './shared';

const S = LIMITS.shortText;
const CT = LIMITS.chartText;

/** Example chart using the v2 options (also returned by the block_schema MCP tool). */
export const CHART_EXAMPLE = {
  type: 'chart', kind: 'combo', title: 'Doanh thu và biên lợi nhuận', caption: 'Nguồn: báo cáo quý.',
  labels: ['2026-01', '2026-02', '2026-03', '2026-04'],
  series: [
    { name: 'Doanh thu', data: [120, 150, 170, 210] },
    { name: 'Biên lợi nhuận', type: 'line', axis: 'right', data: [12.5, 14, 13.2, 16.8] },
  ],
  x: { title: 'Tháng', format: 'date' },
  y: { title: 'Doanh thu', unit: 'triệu ₫' },
  y2: { title: 'Biên', format: 'percent', decimals: 1, min: 0 },
  legend: 'bottom',
  references: [{ value: 160, label: 'Mục tiêu' }],
  annotations: [{ index: 3, text: 'Ra mắt gói Pro' }],
  csv: true, png: true,
} as const;

/** Optional one-line text: undefined when absent or blank, null when invalid (error recorded). */
function optText(v: BlockValidator, o: RawBlock, key: string, path: string, max: number): string | undefined | null {
  if (o[key] === undefined || o[key] === null) return undefined;
  const s = v.str(o, key, path, max);
  if (s === undefined) return null;
  const t = s.trim();
  if (/[\r\n]/.test(t)) { v.err(`${path}.${key}`, 'must be one line'); return null; }
  return t || undefined;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const isIsoDate = (l: string): boolean => l !== '' && canonicalCell('date', l) !== null;

/** An axis object holding only the fields its kind uses; undefined when absent or empty, null when invalid. */
function axis(v: BlockValidator, raw: RawBlock, key: 'x' | 'y' | 'y2', path: string, kind: ChartKind): ChartAxis | undefined | null {
  const a = raw[key];
  if (a === undefined || a === null) return undefined;
  const p = `${path}.${key}`;
  const allowed = axisFields(kind, key);
  if (!isObj(a)) { v.err(p, 'must be an object {title?, min?, max?, format?, currency?, decimals?, unit?}'); return null; }
  if (!allowed.length) { v.err(p, key === 'y2' ? 'only bar, line, area and combo charts have a right-hand axis' : `${kind} charts have no ${key} axis`); return null; }
  let ok = true;
  const out: ChartAxis = {};
  for (const field of Object.keys(a)) {
    if (a[field] === undefined || a[field] === null) continue;
    if (!(['title', 'min', 'max', 'format', 'currency', 'decimals', 'unit'] as const).some(f => f === field)) continue;
    if (!allowed.some(f => f === field)) { v.err(`${p}.${field}`, `is not used by the ${key} axis of a ${kind} chart (allowed: ${allowed.join(', ')})`); ok = false; }
  }
  const title = optText(v, a, 'title', p, CT);
  const unit = optText(v, a, 'unit', p, CT);
  if (title === null || unit === null) ok = false;
  if (title) out.title = title;
  for (const bound of ['min', 'max'] as const) {
    const n = a[bound];
    if (n === undefined || n === null) continue;
    if (!finite(n)) { v.err(`${p}.${bound}`, 'must be a finite number'); ok = false; } else out[bound] = n;
  }
  if (out.min !== undefined && out.max !== undefined && out.min >= out.max) { v.err(`${p}.max`, 'must be greater than min'); ok = false; }
  const format = a.format ?? undefined;
  if (format !== undefined) {
    const dateAxis = key === 'x' && kind !== 'scatter';
    if (!isOneOf(CHART_FORMATS, format)) { v.err(`${p}.format`, `must be one of ${CHART_FORMATS.join(', ')}`); ok = false; }
    else if (dateAxis && format !== 'date') { v.err(`${p}.format`, "category x axes take only 'date' (labels are ISO dates)"); ok = false; }
    else if (!dateAxis && format === 'date') { v.err(`${p}.format`, "'date' is for the category labels of the x axis only"); ok = false; }
    else out.format = format;
  }
  if (out.format === 'currency') {
    if (typeof a.currency !== 'string' || !CURRENCY_RE.test(a.currency)) { v.err(`${p}.currency`, 'currency format needs an ISO 4217 code such as VND or USD'); ok = false; }
    else out.currency = a.currency;
  } else if (a.currency !== undefined && a.currency !== null) { v.err(`${p}.currency`, "only format 'currency' takes currency"); ok = false; }
  if (a.decimals !== undefined && a.decimals !== null) {
    if (!isInt(a.decimals, 0, LIMITS.chartDecimalsMax)) { v.err(`${p}.decimals`, `must be an integer from 0 to ${LIMITS.chartDecimalsMax}`); ok = false; }
    else out.decimals = a.decimals;
  }
  if (unit) out.unit = unit;
  if (!ok) return null;
  return Object.keys(out).length ? out : undefined;
}

function references(v: BlockValidator, raw: RawBlock, path: string, kind: ChartKind, right: boolean): ChartReference[] | undefined | null {
  if (raw.references === undefined || raw.references === null) return undefined;
  const p = `${path}.references`;
  if (!CARTESIAN_KINDS.includes(kind)) { v.err(p, 'only bar, line, area, combo and scatter charts take reference lines'); return null; }
  if (!Array.isArray(raw.references) || raw.references.length > LIMITS.chartReferences) { v.err(p, `must be an array of at most ${LIMITS.chartReferences} {value, label?, axis?}`); return null; }
  const out: ChartReference[] = [];
  raw.references.forEach((r: unknown, i: number) => {
    const q = `${p}[${i}]`;
    if (!isObj(r)) { v.err(q, 'must be an object {value, label?, axis?}'); return; }
    if (!finite(r.value)) { v.err(`${q}.value`, 'must be a finite number'); return; }
    const label = optText(v, r, 'label', q, CT);
    if (label === null) return;
    const ref: ChartReference = { value: r.value, ...(label ? { label } : {}) };
    if (r.axis !== undefined && r.axis !== null) {
      if (r.axis !== 'right') { v.err(`${q}.axis`, "must be 'right' (or absent for the main y axis)"); return; }
      if (!right) { v.err(`${q}.axis`, "needs a series with axis 'right'"); return; }
      ref.axis = 'right';
    }
    out.push(ref);
  });
  return out.length === raw.references.length ? (out.length ? out : undefined) : null;
}

function annotations(v: BlockValidator, raw: RawBlock, path: string, kind: ChartKind, labelCount: number): ChartAnnotation[] | undefined | null {
  if (raw.annotations === undefined || raw.annotations === null) return undefined;
  const p = `${path}.annotations`;
  if (!CATEGORY_KINDS.includes(kind)) { v.err(p, 'only bar, line, area and combo charts take annotations'); return null; }
  if (!Array.isArray(raw.annotations) || raw.annotations.length > LIMITS.chartAnnotations) { v.err(p, `must be an array of at most ${LIMITS.chartAnnotations} {index, text}`); return null; }
  const out: ChartAnnotation[] = [];
  raw.annotations.forEach((a: unknown, i: number) => {
    const q = `${p}[${i}]`;
    if (!isObj(a)) { v.err(q, 'must be an object {index, text}'); return; }
    if (!isInt(a.index, 0, labelCount - 1)) { v.err(`${q}.index`, `must be the index of a label, 0 to ${labelCount - 1}`); return; }
    const text = optText(v, a, 'text', q, CT);
    if (text === null) return;
    if (!text) { v.err(`${q}.text`, 'is required'); return; }
    out.push({ index: a.index, text });
  });
  return out.length === raw.annotations.length ? (out.length ? out : undefined) : null;
}

/** The v2 series fields (type, axis, x) of one series; false when one is invalid. */
function seriesOptions(v: BlockValidator, s: RawBlock, out: ChartSeries, p: string, kind: ChartKind, labelCount: number): boolean {
  let ok = true;
  if (s.type !== undefined && s.type !== null) {
    if (kind !== 'combo') { v.err(`${p}.type`, 'only combo charts set a type per series'); ok = false; }
    else if (!isOneOf(CHART_SERIES_TYPES, s.type)) { v.err(`${p}.type`, `must be one of ${CHART_SERIES_TYPES.join(', ')}`); ok = false; }
    else if (s.type !== 'bar') out.type = s.type;
  }
  if (s.axis !== undefined && s.axis !== null) {
    if (!CATEGORY_KINDS.includes(kind)) { v.err(`${p}.axis`, 'only bar, line, area and combo charts have a right-hand axis'); ok = false; }
    else if (s.axis !== 'right') { v.err(`${p}.axis`, "must be 'right' (or absent for the main y axis)"); ok = false; }
    else out.axis = 'right';
  }
  if (kind === 'scatter') {
    if (!Array.isArray(s.x) || !s.x.every(finite)) { v.err(`${p}.x`, 'scatter series need x: an array of finite numbers'); ok = false; }
    else if (s.x.length !== labelCount) { v.err(`${p}.x`, `length ${s.x.length} must equal labels length ${labelCount}`); ok = false; }
    else out.x = s.x.map(Number);
  } else if (s.x !== undefined && s.x !== null) { v.err(`${p}.x`, 'only scatter series take x values'); ok = false; }
  return ok;
}

/** Charts of the v2 renderer: the label column of their table and Markdown (the x axis title, else Label). */
const labelHeader = (b: ChartBlock) => b.x?.title ?? 'Label';

function kindName(b: ChartBlock): string {
  return `${b.stacked ? 'stacked ' : ''}${b.kind} chart`;
}

/** Markdown lines of the axes, reference lines and annotations of a v2 chart. */
function v2Notes(b: ChartBlock): string[] {
  const axisLine = (name: string, a: ChartAxis | undefined) => {
    if (!a) return '';
    const parts = [a.title, a.format && a.format !== 'number' ? (a.format === 'currency' ? a.currency : a.format) : '', a.unit ? `unit: ${a.unit}` : '',
      a.min !== undefined || a.max !== undefined ? `range ${a.min ?? '…'} to ${a.max ?? '…'}` : ''].filter(Boolean);
    return parts.length ? `- ${name}: ${parts.join(', ')}` : '';
  };
  return [
    axisLine('X axis', b.x), axisLine('Y axis', b.y), axisLine('Right axis', b.y2),
    ...b.series.filter(s => s.type || s.axis).map(s => `- ${s.name}: ${[s.type ?? '', s.axis === 'right' ? 'right axis' : ''].filter(Boolean).join(', ')}`),
    ...(b.references ?? []).map(r => `- Reference line${r.axis === 'right' ? ' (right axis)' : ''}: ${r.label ? `${r.label} = ` : ''}${r.value}`),
    ...(b.annotations ?? []).map(a => `- Note at ${b.labels[a.index] ?? a.index}: ${a.text}`),
  ].filter(Boolean);
}

/** Extra text of a v2 chart: caption, axis titles and units, reference labels and annotations. */
function v2Text(b: ChartBlock): string[] {
  return [
    ...[b.x, b.y, b.y2].flatMap(a => [a?.title ?? '', a?.unit ?? '']),
    ...(b.references ?? []).map(r => r.label ?? ''),
    ...(b.annotations ?? []).map(a => a.text),
    plain(b.caption),
  ].filter(Boolean);
}

export const chart: BlockDefinition<ChartBlock> = {
  type: 'chart',
  validate(v, raw, { id, path }) {
    if (!isOneOf(CHART_KINDS, raw.kind)) { v.err(`${path}.kind`, `must be one of ${CHART_KINDS.join(', ')}`); return undefined; }
    const kind = raw.kind;
    const title = v.str(raw, 'title', path, S, { optional: true });
    const labels = v.strArray(raw, 'labels', path, LIMITS.chartLabels, 120, 1);
    if (!labels) return undefined;
    if (!Array.isArray(raw.series) || raw.series.length < 1 || raw.series.length > LIMITS.chartSeries) {
      v.err(`${path}.series`, `must contain 1–${LIMITS.chartSeries} series`);
      return undefined;
    }
    const series: ChartSeries[] = [];
    raw.series.forEach((s: unknown, i: number) => {
      const p = `${path}.series[${i}]`;
      if (!isObj(s)) { v.err(p, 'must be an object {name, data}'); return; }
      const name = v.str(s, 'name', p, 120);
      const data = s.data;
      if (!Array.isArray(data) || !data.every(n => typeof n === 'number' && Number.isFinite(n))) {
        v.err(`${p}.data`, 'must be an array of finite numbers');
        return;
      }
      if (data.length !== labels.length) {
        v.err(`${p}.data`, `length ${data.length} must equal labels length ${labels.length}`);
        return;
      }
      const out: ChartSeries = { name: name ?? '', data: data.map(Number) };
      if (seriesOptions(v, s, out, p, kind, labels.length) && name !== undefined) series.push(out);
    });
    if (series.length !== raw.series.length) return undefined;
    const right = series.some(s => s.axis === 'right');

    const caption = optText(v, raw, 'caption', path, S);
    const x = axis(v, raw, 'x', path, kind);
    const y = axis(v, raw, 'y', path, kind);
    let y2 = axis(v, raw, 'y2', path, kind);
    if (y2 && !right) { v.err(`${path}.y2`, "is used only by series with axis 'right'"); y2 = null; }
    if (x?.format === 'date') {
      labels.forEach((l, i) => { if (!isIsoDate(l)) v.err(`${path}.labels[${i}]`, 'must be an ISO date (YYYY, YYYY-MM or YYYY-MM-DD) when x.format is date'); });
    }
    const datesOk = x?.format !== 'date' || labels.every(isIsoDate);
    const stacked = flag(v, raw, 'stacked', path);
    const stackOk = !stacked || CATEGORY_KINDS.includes(kind);
    if (!stackOk) v.err(`${path}.stacked`, 'only bar, line, area and combo charts stack');
    const legend = raw.legend ?? undefined;
    const legendOk = legend === undefined || isOneOf(CHART_LEGENDS, legend);
    if (!legendOk) v.err(`${path}.legend`, `must be one of ${CHART_LEGENDS.join(', ')}`);
    const dataLabels = flag(v, raw, 'dataLabels', path);
    const csv = flag(v, raw, 'csv', path);
    const png = flag(v, raw, 'png', path);
    const refs = references(v, raw, path, kind, right);
    const notes = annotations(v, raw, path, kind, labels.length);
    if ([caption, x, y, y2, stacked, dataLabels, csv, png, refs, notes].includes(null) || !datesOk || !stackOk || !legendOk) return undefined;

    const block: ChartBlock = {
      id, type: 'chart', kind, labels, series, ...(title ? { title } : {}),
      ...(caption ? { caption } : {}),
      ...(stacked ? { stacked } : {}),
      ...(x ? { x } : {}),
      ...(y ? { y } : {}),
      ...(y2 ? { y2 } : {}),
      ...(legend !== undefined && isOneOf(CHART_LEGENDS, legend) ? { legend } : {}),
      ...(dataLabels ? { dataLabels } : {}),
      ...(refs ? { references: refs } : {}),
      ...(notes ? { annotations: notes } : {}),
      ...(csv ? { csv } : {}),
      ...(png ? { png } : {}),
    };
    return block;
  },
  markdown(b) {
    if (!isChartV2(b)) {
      const title = b.title ? `**${b.title}** (${b.kind} chart)` : `*${b.kind} chart*`;
      const headers = ['Label', ...b.series.map(s => s.name)];
      const rows = b.labels.map((label, i) => [label, ...b.series.map(s => String(s.data[i]))]);
      return `${title}\n\n${gfmTable(headers, rows)}`;
    }
    const title = b.title ? `**${b.title}** (${kindName(b)})` : `*${kindName(b)}*`;
    const grid = canonicalGrid(b, labelHeader(b));
    const notes = v2Notes(b);
    return `${title}\n\n${gfmTable(grid.headers, grid.rows)}${notes.length ? `\n\n${notes.join('\n')}` : ''}${mdCaption(b.caption)}`;
  },
  searchText: b => [b.title ?? '', ...b.labels, ...b.series.map(s => s.name), ...(isChartV2(b) ? v2Text(b) : [])],
  aiText: b => {
    if (!isChartV2(b)) return [b.title ?? '', b.labels.join(', ')].join(' ');
    // Zuey AI gets the data too, so it can answer questions about the figures.
    const grid = canonicalGrid(b, labelHeader(b));
    return [b.title ?? '', `(${kindName(b)})`, ...[grid.headers, ...grid.rows].map(r => r.map(plain).join(' | ')), ...v2Notes(b), plain(b.caption)].filter(Boolean).join('\n');
  },
  weight: b => 40 + b.labels.join('').length + b.series.length * b.labels.length * 3 + (isChartV2(b) ? v2Text(b).reduce((n, t) => n + plainLength(t), 0) : 0),
  schema: {
    properties: {
      kind: {
        type: 'string', enum: [...CHART_KINDS],
        description: 'bar, line, pie and doughnut as before; area (filled line), scatter (series need x), radar, combo (bars and lines, series.type)',
      },
      title: short,
      labels: { type: 'array', minItems: 1, maxItems: LIMITS.chartLabels, items: { type: 'string', maxLength: 120 }, description: 'Categories (point names for scatter); ISO dates when x.format is date' },
      series: {
        type: 'array', minItems: 1, maxItems: LIMITS.chartSeries,
        items: {
          type: 'object', required: ['name', 'data'],
          properties: {
            name: { type: 'string', maxLength: 120 },
            data: { type: 'array', items: { type: 'number' }, description: 'Same length as labels' },
            type: { type: 'string', enum: [...CHART_SERIES_TYPES], default: 'bar', description: 'combo only: how this series is drawn' },
            axis: { type: 'string', enum: ['right'], description: 'bar, line, area and combo: plot against the right-hand axis (y2)' },
            x: { type: 'array', items: { type: 'number' }, description: 'scatter only (required there): one x value per label; data holds the y values' },
          },
        },
      },
      caption: { ...short, description: 'Inline text under the chart (source, notes)' },
      stacked: { type: 'boolean', default: false, description: 'bar, line, area and combo: stack the series' },
      x: chartAxisSchema('x axis. Category charts: title, and format "date" when labels are ISO dates (shown in the edition style). Scatter: every value field'),
      y: chartAxisSchema('y axis (radial scale for radar without title; only the value format for pie and doughnut)'),
      y2: chartAxisSchema("Right-hand axis of bar, line, area and combo charts, used by series with axis 'right'"),
      legend: { type: 'string', enum: [...CHART_LEGENDS], description: 'Legend under or over the chart, or none. Default: shown when there is more than one series, and for pie and doughnut. Readers toggle series (slices) with its buttons' },
      dataLabels: { type: 'boolean', default: false, description: 'Write the formatted values on bars, points and slices' },
      references: {
        type: 'array', maxItems: LIMITS.chartReferences, description: 'Bar, line, area, combo and scatter: dashed horizontal lines (target, average, threshold)',
        items: {
          type: 'object', required: ['value'],
          properties: { value: { type: 'number' }, label: { type: 'string', maxLength: CT }, axis: { type: 'string', enum: ['right'], description: 'Measure against y2' } },
        },
      },
      annotations: {
        type: 'array', maxItems: LIMITS.chartAnnotations, description: 'Bar, line, area and combo: a marker and note at one category',
        items: {
          type: 'object', required: ['index', 'text'],
          properties: { index: { type: 'integer', minimum: 0, description: 'Index of the label it marks' }, text: { type: 'string', maxLength: CT } },
        },
      },
      csv: { type: 'boolean', default: false, description: 'A button downloads the data as CSV (UTF-8, formula-safe)' },
      png: { type: 'boolean', default: false, description: 'A button downloads the drawn chart as a PNG image' },
    },
    required: ['kind', 'labels', 'series'],
    extra: { examples: [CHART_EXAMPLE] },
  },
};

function chartAxisSchema(description: string) {
  return {
    type: 'object', description,
    properties: {
      title: { type: 'string', maxLength: CT },
      min: { type: 'number' },
      max: { type: 'number', description: 'Greater than min' },
      format: { type: 'string', enum: [...CHART_FORMATS], default: 'number', description: 'Values in the edition style (vi: 1.234,5 · 12,5% · 490.000 ₫; others: 1,234.5); date only for category x axes' },
      currency: { type: 'string', pattern: CURRENCY_RE.source, description: 'Required with format currency: ISO 4217 code such as VND or USD' },
      decimals: { type: 'integer', minimum: 0, maximum: LIMITS.chartDecimalsMax },
      unit: { type: 'string', maxLength: CT, description: 'Shown after each value, such as kg' },
    },
  };
}
