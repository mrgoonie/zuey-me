/**
 * Chart.js configuration of v2 charts: datasets, scales with formatted ticks, tooltips and the plugin that draws
 * reference lines, annotations and data labels. Used only by the client chart component; Chart.js is referenced
 * by type only, so this module never pulls it into a bundle.
 */
import type { Chart, ChartConfiguration, ChartDataset, ChartTypeRegistry, Plugin, TooltipItem } from 'chart.js';
import type { ChartAxis, ChartBlock, ChartKind, ChartSeries } from './schema';
import type { TableLocale } from './table-data';
import { CATEGORY_KINDS, formatChartLabel, formatChartValue, isCircular, paletteColor, seriesAxis } from './chart-data';
// ---------- Chart.js ----------

type AnyChart = Chart;
type Tip = TooltipItem<keyof ChartTypeRegistry>;
type AnyDataset = ChartDataset;

/** The Chart.js chart type a kind is drawn with (area is a filled line, combo mixes bar and line datasets). */
function baseType(kind: ChartKind): 'bar' | 'line' | 'pie' | 'doughnut' | 'scatter' | 'radar' {
  switch (kind) {
    case 'area': return 'line';
    case 'combo': return 'bar';
    default: return kind;
  }
}

/** How one series is drawn: its own type in a combo chart, the chart's kind otherwise. */
function drawnAs(b: ChartBlock, s: ChartSeries): ChartKind {
  return b.kind === 'combo' ? (s.type ?? 'bar') : b.kind;
}

function translucent(hex: string, alpha: string): string {
  return `${hex}${alpha}`;
}

function dataset(b: ChartBlock, s: ChartSeries, i: number): AnyDataset {
  const color = paletteColor(i);
  const yAxisID = CATEGORY_KINDS.includes(b.kind) ? (s.axis === 'right' ? 'y2' : 'y') : undefined;
  const common = { label: s.name, ...(yAxisID ? { yAxisID } : {}) };
  switch (drawnAs(b, s)) {
    case 'pie': case 'doughnut':
      return { ...common, data: s.data, backgroundColor: b.labels.map((_, j) => paletteColor(j)), borderColor: '#fffdf9', borderWidth: 2 };
    case 'scatter':
      return { ...common, data: s.data.map((y, j) => ({ x: s.x?.[j] ?? 0, y })), backgroundColor: color, borderColor: color, pointRadius: 4, pointHoverRadius: 6 };
    case 'radar':
      return { ...common, data: s.data, borderColor: color, backgroundColor: translucent(color, '33'), pointBackgroundColor: color, borderWidth: 2, fill: true };
    case 'line': case 'area': {
      const area = drawnAs(b, s) === 'area';
      return {
        ...common, type: 'line', data: s.data, borderColor: color, backgroundColor: area ? translucent(color, '40') : color, borderWidth: 2, tension: 0.3,
        pointRadius: 3, fill: area ? (b.stacked ? 'stack' : 'origin') : false, order: 1,
      };
    }
    default:
      return { ...common, type: 'bar', data: s.data, backgroundColor: color, borderColor: color, borderWidth: 2, order: 2 };
  }
}

function axisTitle(axis: ChartAxis | undefined) {
  return axis?.title ? { display: true, text: axis.title } : { display: false };
}

/**
 * A value axis. `marks` are the reference values drawn against it: the automatic range is widened to include
 * them (a target above the data would otherwise fall outside the plot and not be drawn), unless the author set
 * that end of the range.
 */
function valueScale(axis: ChartAxis | undefined, locale: TableLocale, stacked: boolean, beginAtZero = false, marks: readonly number[] = []) {
  return {
    stacked,
    ...(beginAtZero ? { beginAtZero } : {}),
    title: axisTitle(axis),
    ...(axis?.min !== undefined ? { min: axis.min } : marks.length ? { suggestedMin: Math.min(...marks) } : {}),
    ...(axis?.max !== undefined ? { max: axis.max } : marks.length ? { suggestedMax: Math.max(...marks) } : {}),
    ticks: { callback: (value: number | string) => formatChartValue(Number(value), axis, locale) },
  };
}

const MARK_FONT = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';

/** Values on bars, points and slices (only for shown series and slices). */
function drawDataLabels(chart: AnyChart, b: ChartBlock, locale: TableLocale): void {
  const { ctx } = chart;
  const circular = isCircular(b.kind);
  ctx.save();
  ctx.font = MARK_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = circular ? 'middle' : 'bottom';
  b.series.forEach((s, ds) => {
    if (!chart.isDatasetVisible(ds)) return;
    const axis = seriesAxis(b, s);
    chart.getDatasetMeta(ds).data.forEach((el, j) => {
      if (circular && !chart.getDataVisibility(j)) return;
      const value = s.data[j];
      if (value === undefined) return;
      const { x, y } = el.tooltipPosition(true);
      if (x === null || y === null) return;
      ctx.fillStyle = circular ? '#fffdf9' : '#44403c';
      ctx.fillText(formatChartValue(value, axis, locale), x, circular ? y : y - 4);
    });
  });
  ctx.restore();
}

/** Dashed horizontal lines with their label and value, clipped to the plot area. */
function drawReferences(chart: AnyChart, b: ChartBlock, locale: TableLocale): void {
  const { ctx, chartArea } = chart;
  for (const r of b.references ?? []) {
    const scale = chart.scales[r.axis === 'right' ? 'y2' : 'y'];
    if (!scale) continue;
    const y = scale.getPixelForValue(r.value);
    if (!Number.isFinite(y) || y < chartArea.top || y > chartArea.bottom) continue;
    const text = [r.label, formatChartValue(r.value, r.axis === 'right' ? b.y2 : b.y, locale)].filter(Boolean).join(' · ');
    ctx.save();
    ctx.strokeStyle = '#b91c1c';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(chartArea.left, y);
    ctx.lineTo(chartArea.right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = MARK_FONT;
    ctx.fillStyle = '#b91c1c';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(text, chartArea.right - 4, y - 3);
    ctx.restore();
  }
}

/** Dotted vertical marker at an annotated category with its note at the top of the plot area. */
function drawAnnotations(chart: AnyChart, b: ChartBlock): void {
  const { ctx, chartArea } = chart;
  const scale = chart.scales.x;
  if (!scale) return;
  for (const a of b.annotations ?? []) {
    const x = scale.getPixelForValue(a.index);
    if (!Number.isFinite(x) || x < chartArea.left || x > chartArea.right) continue;
    ctx.save();
    ctx.strokeStyle = '#4338ca';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = MARK_FONT;
    ctx.fillStyle = '#4338ca';
    // Notes near the right edge read leftwards so they stay inside the chart.
    ctx.textAlign = x > (chartArea.left + chartArea.right) / 2 ? 'right' : 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(a.text, ctx.textAlign === 'right' ? x - 4 : x + 4, chartArea.top + 2);
    ctx.restore();
  }
}

/** Reference lines, annotations and data labels, drawn over the datasets. Work is linear in the points shown. */
export function chartMarksPlugin(b: ChartBlock, locale: TableLocale): Plugin {
  return {
    id: 'zueyChartMarks',
    afterDatasetsDraw(chart) {
      drawReferences(chart, b, locale);
      drawAnnotations(chart, b);
      if (b.dataLabels) drawDataLabels(chart, b, locale);
    },
  };
}

function tooltipLabel(b: ChartBlock, item: Tip, locale: TableLocale): string {
  const s = b.series[item.datasetIndex];
  if (!s) return '';
  const value = s.data[item.dataIndex] ?? 0;
  const shown = formatChartValue(value, seriesAxis(b, s), locale);
  if (isCircular(b.kind)) {
    const total = s.data.reduce((n, v, j) => n + (item.chart.getDataVisibility(j) ? Math.abs(v) : 0), 0);
    const share = total > 0 ? formatChartValue((Math.abs(value) / total) * 100, { format: 'percent', decimals: 1 }, locale) : '';
    const label = formatChartLabel(b, b.labels[item.dataIndex] ?? '', locale);
    return `${b.series.length > 1 ? `${s.name} · ` : ''}${label}: ${shown}${share ? ` (${share})` : ''}`;
  }
  if (b.kind === 'scatter') return `${s.name}: ${formatChartValue(s.x?.[item.dataIndex] ?? 0, b.x, locale)} · ${shown}`;
  return `${s.name}: ${shown}`;
}

export interface ChartConfigOptions {
  locale: TableLocale;
  reducedMotion: boolean;
}

/**
 * Chart.js configuration of a v2 chart. The canvas legend is off: the component renders a keyboard-operable
 * legend that toggles series (slices for pie and doughnut). Hover reads every series at a category (a crosshair
 * on line, area and combo charts).
 */
export function chartConfig(b: ChartBlock, { locale, reducedMotion }: ChartConfigOptions): ChartConfiguration {
  const category = CATEGORY_KINDS.includes(b.kind);
  const stacked = Boolean(b.stacked) && category;
  const right = category && b.series.some(s => s.axis === 'right');
  // Filled areas and stacks are read from zero.
  const zero = stacked || b.series.some(s => drawnAs(b, s) === 'area');
  const marks = (side: 'left' | 'right') => (b.references ?? []).filter(r => (r.axis === 'right') === (side === 'right')).map(r => r.value);
  const scales = category
    ? {
      x: { stacked, title: axisTitle(b.x) },
      y: valueScale(b.y, locale, stacked, zero, marks('left')),
      ...(right ? { y2: { ...valueScale(b.y2, locale, stacked, zero, marks('right')), position: 'right' as const, grid: { drawOnChartArea: false } } } : {}),
    }
    : b.kind === 'scatter'
      ? { x: { type: 'linear' as const, ...valueScale(b.x, locale, false) }, y: valueScale(b.y, locale, false, false, marks('left')) }
      : b.kind === 'radar'
        ? {
          r: {
            ...(b.y?.min !== undefined ? { min: b.y.min } : {}),
            ...(b.y?.max !== undefined ? { max: b.y.max } : {}),
            ticks: { backdropColor: 'transparent', callback: (value: number | string) => formatChartValue(Number(value), b.y, locale) },
          },
        }
        : undefined;
  return {
    type: baseType(b.kind),
    data: {
      labels: b.labels.map(l => formatChartLabel(b, l, locale)),
      datasets: b.series.map((s, i) => dataset(b, s, i)),
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      // Axis charts are 2:1 by default, too flat on a phone: narrow ones get taller (pie, doughnut, radar stay square).
      ...(scales && b.kind !== 'radar' ? {
        aspectRatio: 2,
        onResize: (chart: AnyChart, size: { width: number }) => {
          const ratio = size.width < 480 ? 1.25 : 2;
          if (chart.options.aspectRatio === ratio) return;
          chart.options.aspectRatio = ratio;
          chart.resize();
        },
      } : {}),
      animation: reducedMotion ? false : undefined,
      ...(category ? { interaction: { mode: 'index' as const, intersect: false } } : {}),
      ...(scales ? { scales } : {}),
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            ...(b.kind === 'scatter' ? { title: (items: Tip[]) => b.labels[items[0]?.dataIndex ?? 0] ?? '' } : {}),
            label: (item: Tip) => tooltipLabel(b, item, locale),
          },
        },
      },
    },
    plugins: [chartMarksPlugin(b, locale)],
  };
}
