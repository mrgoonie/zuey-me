import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { documentText as aiDocumentText } from '../src/lib/ai/context';
import { documentToMarkdown } from '../src/lib/blocks/markdown';
import { blockSchemas } from '../src/lib/blocks/openapi';
import { blockWeight } from '../src/lib/blocks/paywall';
import { documentTranslatables } from '../src/lib/blocks/read-modes';
import { describeBlockSchema } from '../src/lib/blocks/schema-view';
import { isChartV2 } from '../src/lib/blocks/schema';
import type { Block, ChartBlock } from '../src/lib/blocks/schema';
import { chartConfig } from '../src/lib/blocks/chart-config';
import { axisFields, chartCsv, chartFilename, chartForKind, chartGrid, formatChartLabel, formatChartValue } from '../src/lib/blocks/chart-data';
import { validateDocument } from '../src/lib/blocks/validate';
import { documentText } from '../src/lib/search/text';

// `import.meta.env.SSR` is the live process.env in Bun: the renderer takes the static (server) chart path only when it is set.
const previousSsr = process.env.SSR;
let BlockRenderer: typeof import('../src/components/blocks/BlockRenderer').BlockRenderer;
let ChartV2Fallback: typeof import('../src/components/blocks/BlockRenderer').ChartV2Fallback;
beforeAll(async () => {
  process.env.SSR = 'true';
  ({ BlockRenderer, ChartV2Fallback } = await import('../src/components/blocks/BlockRenderer'));
});
afterAll(() => {
  if (previousSsr === undefined) delete process.env.SSR;
  else process.env.SSR = previousSsr;
});

const REVENUE = {
  type: 'chart', kind: 'combo', title: 'Doanh thu', caption: 'Nguồn: **báo cáo** quý.',
  labels: ['2026-01', '2026-02', '2026-03'],
  series: [
    { name: 'Doanh thu', data: [1200.5, 1500, 1700] },
    { name: 'Biên', type: 'line', axis: 'right', data: [12.5, 14, 13.25] },
  ],
  x: { title: 'Tháng', format: 'date' },
  y: { title: 'Doanh thu', format: 'currency', currency: 'VND' },
  y2: { format: 'percent', decimals: 1 },
  legend: 'bottom', dataLabels: true,
  references: [{ value: 1600, label: 'Mục tiêu' }, { value: 13, axis: 'right' }],
  annotations: [{ index: 2, text: 'Ra mắt Pro' }],
  csv: true, png: true,
};

const LEGACY: ChartBlock = { id: 'c1', type: 'chart', kind: 'bar', title: 'Q', labels: ['A', 'B'], series: [{ name: 'S', data: [1, 2] }] };

function valid(blocks: unknown[]): Block[] {
  const res = validateDocument({ version: 1, blocks });
  if (!res.ok) throw new Error(JSON.stringify(res.errors));
  return res.doc.blocks;
}

function chart(extra: Record<string, unknown> = {}, base: Record<string, unknown> = REVENUE): ChartBlock {
  const [b] = valid([{ ...base, ...extra }]);
  if (b?.type !== 'chart') throw new Error('not a chart');
  return b;
}

function errorsOf(extra: object, base: object = REVENUE): string[] {
  const res = validateDocument({ version: 1, blocks: [{ ...base, ...extra }] });
  return res.ok ? [] : res.errors.map(e => `${e.path}: ${e.message}`);
}

function render(blocks: Block[], locale?: string): string {
  return renderToStaticMarkup(createElement(BlockRenderer, { doc: { version: 1, blocks }, interactive: false, locale }));
}

const SCATTER = {
  type: 'chart', kind: 'scatter', title: 'Giá theo diện tích', labels: ['Căn A', 'Căn B'],
  series: [{ name: 'Căn hộ', x: [45, 70.5], data: [2.1, 3.4] }],
  x: { title: 'm²', unit: 'm²' }, y: { title: 'Giá', unit: 'tỷ', decimals: 1 },
};

describe('chart v2 validation', () => {
  it('keeps legacy charts exactly as before', () => {
    const [b] = valid([{ ...LEGACY, title: '  Q  ' }]);
    expect(b).toEqual({ ...LEGACY, title: '  Q  ' });
    expect(isChartV2(LEGACY)).toBe(false);
  });

  it('accepts every v2 option and normalises defaults away', () => {
    const b = chart({ series: [{ name: 'Doanh thu', type: 'bar', data: [1, 2, 3] }, { name: 'Biên', type: 'line', axis: 'right', data: [1, 2, 3] }], stacked: false });
    expect(b.series[0]).toEqual({ name: 'Doanh thu', data: [1, 2, 3] });
    expect(b.series[1]).toEqual({ name: 'Biên', type: 'line', axis: 'right', data: [1, 2, 3] });
    expect('stacked' in b).toBe(false);
    expect(b.references).toEqual([{ value: 1600, label: 'Mục tiêu' }, { value: 13, axis: 'right' }]);
    expect(isChartV2(b)).toBe(true);
    expect(isChartV2({ ...LEGACY, kind: 'area' })).toBe(true);
  });

  it('accepts scatter, radar and area charts', () => {
    expect(chart({}, SCATTER).series[0]?.x).toEqual([45, 70.5]);
    expect(chart({}, { type: 'chart', kind: 'radar', labels: ['A', 'B', 'C'], series: [{ name: 'S', data: [1, 2, 3] }], y: { min: 0, max: 5 } }).y).toEqual({ min: 0, max: 5 });
    expect(chart({}, { type: 'chart', kind: 'area', stacked: true, labels: ['A'], series: [{ name: 'S', data: [1] }, { name: 'T', data: [2] }] }).stacked).toBe(true);
  });

  it('rejects options the kind does not use', () => {
    const pie = { type: 'chart', kind: 'pie', labels: ['A', 'B'], series: [{ name: 'S', data: [1, 2] }] };
    expect(errorsOf({ stacked: true }, pie)).toEqual(['$.blocks[0].stacked: only bar, line, area and combo charts stack']);
    expect(errorsOf({ references: [{ value: 1 }] }, pie)[0]).toContain('reference lines');
    expect(errorsOf({ annotations: [{ index: 0, text: 'x' }] }, pie)[0]).toContain('annotations');
    expect(errorsOf({ x: { title: 'x' } }, pie)).toEqual(['$.blocks[0].x: pie charts have no x axis']);
    expect(errorsOf({ y: { title: 'Tổng' } }, pie)[0]).toContain('$.blocks[0].y.title: is not used');
    expect(errorsOf({ series: [{ name: 'S', type: 'line', data: [1, 2] }] }, pie)[0]).toContain('only combo charts');
    expect(errorsOf({ series: [{ name: 'S', data: [1, 2], x: [1, 2] }] }, pie)[0]).toContain('only scatter series');
    expect(errorsOf({ series: [{ name: 'S', data: [1, 2] }] }, { ...SCATTER })[0]).toContain('scatter series need x');
  });

  it('rejects invalid axes, dates, references and annotations', () => {
    expect(errorsOf({ y: { min: 5, max: 5 } })).toContain('$.blocks[0].y.max: must be greater than min');
    expect(errorsOf({ y: { format: 'currency' } })).toContain('$.blocks[0].y.currency: currency format needs an ISO 4217 code such as VND or USD');
    expect(errorsOf({ y: { decimals: 7 } })).toContain('$.blocks[0].y.decimals: must be an integer from 0 to 6');
    expect(errorsOf({ y: { format: 'date' } })[0]).toContain("'date' is for the category labels");
    expect(errorsOf({ labels: ['2026-01', 'Tháng 2', '2026-03'] })).toContain('$.blocks[0].labels[1]: must be an ISO date (YYYY, YYYY-MM or YYYY-MM-DD) when x.format is date');
    expect(errorsOf({ series: [{ name: 'S', data: [1, 2, 3] }], references: undefined })).toContain("$.blocks[0].y2: is used only by series with axis 'right'");
    expect(errorsOf({ annotations: [{ index: 3, text: 'x' }] })).toContain('$.blocks[0].annotations[0].index: must be the index of a label, 0 to 2');
    expect(errorsOf({ annotations: [{ index: 0, text: '  ' }] })).toContain('$.blocks[0].annotations[0].text: is required');
    expect(errorsOf({ references: [{ value: Number.NaN }] })).toContain('$.blocks[0].references[0].value: must be a finite number');
    expect(errorsOf({ legend: 'left' })).toContain('$.blocks[0].legend: must be one of top, bottom, none');
    expect(errorsOf({ caption: 'a\nb' })).toContain('$.blocks[0].caption: must be one line');
  });
});

describe('chart v2 formatting and data', () => {
  it('formats values and date labels in the edition style', () => {
    expect(formatChartValue(1200.5, { format: 'currency', currency: 'VND' }, 'vi')).toBe('1.200,5 ₫');
    expect(formatChartValue(12.5, { format: 'percent', decimals: 1 }, 'vi')).toBe('12,5%');
    expect(formatChartValue(12.5, { format: 'percent', decimals: 1 }, 'en')).toBe('12.5%');
    expect(formatChartValue(1234.5, { unit: 'kg' }, 'en')).toBe('1,234.5 kg');
    expect(formatChartValue(0.1 + 0.2, undefined, 'vi')).toBe('0,3');
    expect(formatChartValue(1e21, undefined, 'vi')).toBe('1e+21');
    // Tiny values: at most 10 decimals, in the edition style rather than as written.
    expect(formatChartValue(0.000123456789012, undefined, 'vi')).toBe('0,0001234568');
    expect(formatChartValue(-1e-7, { unit: 'mm' }, 'vi')).toBe('-0,0000001 mm');
    expect(formatChartValue(1e-12, undefined, 'en')).toBe('0');
    const b = chart();
    expect(formatChartLabel(b, '2026-01', 'en')).not.toBe('2026-01');
    expect(formatChartLabel(LEGACY, 'A', 'vi')).toBe('A');
  });

  it('exports formula-safe CSV with canonical values and x/y columns for scatter', () => {
    const b = chart({ labels: ['2026-01', '2026-02', '2026-03'], series: [{ name: '=cmd', data: [1, -2, 3] }], y2: undefined, references: [{ value: 1 }] });
    const csv = chartCsv(b, 'Tháng');
    expect(csv.startsWith('﻿Tháng,')).toBe(true);
    expect(csv).toContain("'=cmd");
    expect(csv).toContain('2026-02,-2\r\n');
    // Long and exponent-form negatives are numbers too: no formula guard.
    const tiny = chartCsv(chart({}, { type: 'chart', kind: 'bar', labels: ['a', 'b'], series: [{ name: 'S', data: [0.1 - 0.4, -1e-7] }] }), 'L');
    expect(tiny).toBe('﻿L,S\r\na,-0.30000000000000004\r\nb,-1e-7\r\n');
    expect(chartGrid(chart({}, SCATTER), 'Căn', n => String(n), l => l)).toEqual({
      headers: ['Căn', 'Căn hộ (x)', 'Căn hộ (y)'],
      rows: [['Căn A', '45', '2.1'], ['Căn B', '70.5', '3.4']],
    });
    expect(chartFilename(b, 'png')).toBe('doanh-thu.png');
    expect(chartFilename({ ...LEGACY, title: undefined }, 'csv')).toBe('chart-c1.csv');
  });

  it('re-shapes a chart for another kind, dropping what that kind cannot use', () => {
    const b = chart();
    const pie = chartForKind(b, 'pie');
    expect(errorsOf(pie, {})).toEqual([]);
    expect(pie.references).toBeUndefined();
    expect(pie.annotations).toBeUndefined();
    expect(pie.x).toBeUndefined();
    expect(pie.y2).toBeUndefined();
    expect(pie.series.every(s => !s.type && !s.axis)).toBe(true);
    const scatter = chartForKind(b, 'scatter');
    expect(scatter.series[0]?.x).toEqual([1, 2, 3]);
    expect(errorsOf(scatter, {})).toEqual([]);
    const bar = chartForKind(b, 'bar');
    expect(bar.series[1]).toEqual({ name: 'Biên', axis: 'right', data: [12.5, 14, 13.25] });
    expect(errorsOf(bar, {})).toEqual([]);
    for (const kind of ['line', 'area', 'radar', 'doughnut', 'combo'] as const) {
      expect(errorsOf(chartForKind(b, kind), {})).toEqual([]);
    }
    expect(axisFields('radar', 'x')).toEqual([]);
  });

  it('builds a Chart.js config with mixed datasets, a right axis and formatted ticks', () => {
    const config = chartConfig(chart(), { locale: 'vi', reducedMotion: true });
    expect(config.type).toBe('bar');
    expect(config.options?.animation).toBe(false);
    expect(config.options?.plugins?.legend?.display).toBe(false);
    const sets = config.data.datasets;
    expect(sets.map(d => d.type)).toEqual(['bar', 'line']);
    expect(sets.map(d => ('yAxisID' in d ? d.yAxisID : undefined))).toEqual(['y', 'y2']);
    const scales = config.options?.scales;
    const y2 = scales?.y2;
    expect(y2 && 'position' in y2 ? y2.position : undefined).toBe('right');
    const tick = scales?.y?.ticks?.callback;
    expect(typeof tick).toBe('function');
    expect(config.plugins?.map(p => p.id)).toEqual(['zueyChartMarks']);
    const area = chartConfig(chart({}, { type: 'chart', kind: 'area', stacked: true, labels: ['A'], series: [{ name: 'S', data: [1] }, { name: 'T', data: [2] }] }), { locale: 'en', reducedMotion: false });
    expect(area.type).toBe('line');
    expect(area.data.datasets.map(d => ('fill' in d ? d.fill : undefined))).toEqual(['stack', 'stack']);
    const ay = area.options?.scales?.y;
    expect(ay && 'beginAtZero' in ay ? ay.beginAtZero : undefined).toBe(true);
    expect(area.options?.aspectRatio).toBe(2);
    const scatter = chartConfig(chart({}, SCATTER), { locale: 'en', reducedMotion: false });
    expect(scatter.data.datasets[0]?.data).toEqual([{ x: 45, y: 2.1 }, { x: 70.5, y: 3.4 }]);
    const sx = scatter.options?.scales?.x;
    expect(sx && 'type' in sx ? sx.type : undefined).toBe('linear');
  });

  it('widens the automatic value range to include reference lines unless the author set it', () => {
    const range = (b: ChartBlock, axis: 'y' | 'y2') => {
      const s = chartConfig(b, { locale: 'vi', reducedMotion: true }).options?.scales?.[axis];
      return s ? Object.fromEntries(Object.entries(s).filter(([k]) => /^(suggested)?(min|max)$/i.test(k))) : undefined;
    };
    // Data peaks at 1700 and the target sits above it; the right-axis line at 13 is within its data.
    const b = chart({ references: [{ value: 2500, label: 'Mục tiêu' }, { value: -100 }, { value: 13, axis: 'right' }] });
    expect(range(b, 'y')).toEqual({ suggestedMin: -100, suggestedMax: 2500 });
    expect(range(b, 'y2')).toEqual({ suggestedMin: 13, suggestedMax: 13 });
    expect(range(chart({ references: [{ value: 2500 }], y: { min: 0, max: 2000 } }), 'y')).toEqual({ min: 0, max: 2000 });
    expect(range(chart({ references: [{ value: 2500 }], y: { max: 2000 } }), 'y')).toEqual({ suggestedMin: 2500, max: 2000 });
    expect(range(chart({ references: undefined }), 'y')).toEqual({});
    const scatter = chartConfig(chart({ references: [{ value: 9 }] }, SCATTER), { locale: 'en', reducedMotion: false }).options?.scales?.y;
    expect(scatter && 'suggestedMax' in scatter ? scatter.suggestedMax : undefined).toBe(9);
  });
});

describe('chart v2 surfaces', () => {
  const doc = { version: 1 as const, blocks: [chart()] };

  it('renders the server fallback table with formatted values, title, caption and toolbar-free markup', () => {
    const html = render(doc.blocks, 'vi');
    expect(html).toContain('zb-chart-v2');
    expect(html).toContain('<div class="zb-frame-title">Doanh thu</div>');
    expect(html).toContain('<caption class="zb-sr-only">Doanh thu</caption>');
    expect(html).toContain('<th scope="col">Tháng</th>');
    expect(html).toContain('1.200,5 ₫');
    expect(html).toContain('12,5%');
    expect(html).toContain('<strong>báo cáo</strong>');
    expect(html).toContain('<canvas aria-hidden="true" style="display:none"></canvas>');
    expect(html).not.toContain('zb-chart-legend');
    expect(render(doc.blocks, 'en')).toContain('1,200.5 ₫');
  });

  it('gives table readers the reference lines and notes the canvas draws', () => {
    const marks = (html: string) => html.match(/<ul class="zb-chart-marks">(.*?)<\/ul>/)?.[1]?.split(/<\/?li>/).filter(Boolean);
    // Inside the table's wrapper: visible without script, screen-reader-only (with the table) once drawn.
    expect(render(doc.blocks, 'vi')).toMatch(/<div class="zb-scroll"><table[\s\S]*?<\/table><ul class="zb-chart-marks">/);
    const vi = marks(render(doc.blocks, 'vi'));
    expect(vi?.slice(0, 2)).toEqual(['Đường mốc: Mục tiêu · 1.600 ₫', 'Đường mốc: 13,0%']);
    expect(vi?.[2]).toMatch(/^Ghi chú tại .+: Ra mắt Pro$/);
    expect(vi?.[2]).not.toContain('2026-03');
    expect(marks(render(doc.blocks, 'en'))?.[0]).toBe('Reference line: Mục tiêu · 1,600 ₫');
    expect(render([chart({ references: undefined, annotations: undefined })])).not.toContain('zb-chart-marks');
  });

  it('shows labelled, formatted values and the marks while the chart chunk loads on the client', () => {
    const fallback = (b: ChartBlock, locale: string) =>
      renderToStaticMarkup(createElement(ChartV2Fallback, { block: b, locale, renderInline: (t: string) => createElement('span', null, t) }));
    let html = fallback(chart({ caption: 'Nguồn' }), 'en');
    expect(html).not.toContain('<canvas');
    expect(html).toContain('<th scope="col">Tháng</th>');
    expect(html).toContain('<th scope="row">2026-01</th><td class="zb-num">1,200.5 VND</td><td class="zb-num">12.5%</td>');
    expect(html).toContain('<li>Reference line: Mục tiêu · 1,600 VND</li>');
    expect(html).toContain('<li>Note at 2026-03: Ra mắt Pro</li>');
    expect(html).toContain('<figcaption><span>Nguồn</span></figcaption>');
    html = fallback(chart({ x: undefined, labels: ['a', 'b', 'c'] }), 'vi');
    expect(html).toContain('<th scope="col">Nhãn</th>');
    expect(html).toContain('1.200,5 VND');
  });

  it('renders legacy charts with the original component', () => {
    const html = render([LEGACY]);
    expect(html).not.toContain('zb-chart-v2');
    expect(html).toContain('zb-chart');
  });

  it('writes Markdown, search and AI text with the data and marks', () => {
    const md = documentToMarkdown(doc);
    expect(md).toContain('**Doanh thu** (combo chart)');
    expect(md).toContain('| Tháng | Doanh thu | Biên |');
    expect(md).toContain('| 2026-01 | 1200.5 | 12.5 |');
    expect(md).toContain('- Reference line: Mục tiêu = 1600');
    expect(md).toContain('- Reference line (right axis): 13');
    expect(md).toContain('- Note at 2026-03: Ra mắt Pro');
    expect(md).toContain('Nguồn: **báo cáo** quý.');
    expect(documentToMarkdown({ version: 1, blocks: [LEGACY] })).toBe('**Q** (bar chart)\n\n| Label | S |\n| --- | --- |\n| A | 1 |\n| B | 2 |');
    const search = documentText(doc);
    for (const t of ['Mục tiêu', 'Ra mắt Pro', 'Tháng', 'báo cáo']) expect(search).toContain(t);
    const ai = aiDocumentText(doc);
    expect(ai).toContain('2026-02 | 1500 | 14');
    expect(ai).toContain('Ra mắt Pro');
  });

  it('weighs the extra text for the paywall', () => {
    const b = chart({ caption: undefined, references: undefined, annotations: undefined, x: { format: 'date' }, y: undefined, y2: undefined });
    const base = blockWeight(b);
    expect(blockWeight({ ...b, caption: 'Nguồn' })).toBe(base + 'Nguồn'.length);
  });

  it('offers titles, units, reference labels, notes and the caption for translation but not date labels', async () => {
    const texts = (await documentTranslatables(doc)).map(e => e.source_text);
    for (const t of ['Doanh thu', 'Biên', 'Tháng', 'Mục tiêu', 'Ra mắt Pro', 'Nguồn: **báo cáo** quý.']) expect(texts).toContain(t);
    expect(texts).not.toContain('2026-01');
  });
});

describe('chart v2 schema', () => {
  it('documents every new field in the OpenAPI schema', () => {
    const schema = JSON.stringify(blockSchemas.BlockChart);
    for (const key of ['caption', 'stacked', 'x', 'y', 'y2', 'legend', 'dataLabels', 'references', 'annotations', 'csv', 'png', 'axis', 'decimals', 'unit', 'scatter', 'radar', 'combo', 'area']) {
      expect(schema).toContain(`"${key}"`);
    }
  });

  it('ships a valid chart_v2 example in the MCP block schema', async () => {
    const answer = await describeBlockSchema({ types: ['chart'] });
    const examples = answer.examples;
    const example = examples && typeof examples === 'object' && 'chart_v2' in examples ? examples.chart_v2 : null;
    expect(example).not.toBeNull();
    expect(validateDocument({ version: 1, blocks: [example] }).ok).toBe(true);
  });
});
