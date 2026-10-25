import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Root } from 'react-dom/client';
import type { ChartConfiguration } from 'chart.js';
import type { Block, ChartBlock } from '../src/lib/blocks/schema';

// Chart v2 after hydration: Chart.js is replaced by a recording fake (happy-dom has no canvas 2D context), so these
// tests cover the component around it: legend toggles, downloads, readiness and the load-failure fallback.
// Installs happy-dom as process globals: never run with `bun test --concurrent`.

type ReactModule = typeof import('react');
type ClientModule = typeof import('react-dom/client');

interface FakeChart {
  config: ChartConfiguration;
  datasetVisible: boolean[];
  dataVisible: boolean[];
  updates: number;
  destroyed: boolean;
}

const charts: FakeChart[] = [];
let failNext = false;

class FakeChartJs implements FakeChart {
  config: ChartConfiguration;
  datasetVisible: boolean[];
  dataVisible: boolean[];
  updates = 0;
  destroyed = false;
  constructor(_canvas: HTMLCanvasElement, config: ChartConfiguration) {
    if (failNext) throw new Error('chart.js failed');
    this.config = config;
    this.datasetVisible = config.data.datasets.map(() => true);
    this.dataVisible = (config.data.labels ?? []).map(() => true);
    charts.push(this);
  }
  setDatasetVisibility(i: number, visible: boolean) { this.datasetVisible[i] = visible; }
  getDataVisibility(i: number) { return this.dataVisible[i] ?? true; }
  toggleDataVisibility(i: number) { this.dataVisible[i] = !this.getDataVisibility(i); }
  update() { this.updates += 1; }
  destroy() { this.destroyed = true; }
}

mock.module('chart.js/auto', () => ({ default: FakeChartJs }));

let React: ReactModule;
let client: ClientModule;
let renderer: typeof import('../src/components/blocks/BlockRenderer');

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
const blobs: Blob[] = [];
const savedNames: string[] = [];

const COMBO: ChartBlock = {
  id: 'rev', type: 'chart', kind: 'combo', title: 'Doanh thu', labels: ['Q1', 'Q2'],
  series: [{ name: 'Doanh thu', data: [10, 20] }, { name: 'Biên', type: 'line', axis: 'right', data: [5, 6] }],
  y2: { format: 'percent' }, csv: true, png: true,
};
const PIE: ChartBlock = { id: 'share', type: 'chart', kind: 'pie', title: 'Thị phần', labels: ['A', 'B', 'C'], series: [{ name: 'S', data: [1, 2, 3] }], legend: 'bottom' };

async function flush() {
  await React.act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); });
}

async function mount(blocks: Block[], locale?: string): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = client.createRoot(container);
  React.act(() => root.render(React.createElement(renderer.BlockRenderer, { doc: { version: 1, blocks }, interactive: false, locale })));
  mounted.push({ root, container });
  await flush();
  return container;
}

async function click(el: Element | null | undefined) {
  if (!el) throw new Error('missing element');
  await React.act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 0));
  });
}

const legendButtons = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>('.zb-chart-legend-item')];
const button = (root: HTMLElement, label: string) => [...root.querySelectorAll('button')].find(b => b.textContent === label);

beforeAll(async () => {
  delete process.env.SSR;
  GlobalRegistrator.register({ url: 'https://zuey.me/articles/demo' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  URL.createObjectURL = (obj: Blob | MediaSource) => {
    if (obj instanceof Blob) blobs.push(obj);
    return 'blob:test';
  };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) { savedNames.push(this.download); };
  HTMLCanvasElement.prototype.getContext = () => null;
  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,iVBORw0KGgo=';
  React = await import('react');
  client = await import('react-dom/client');
  renderer = await import('../src/components/blocks/BlockRenderer');
});

afterEach(() => {
  for (const m of mounted.splice(0)) {
    React.act(() => m.root.unmount());
    m.container.remove();
  }
  charts.length = 0;
  blobs.length = 0;
  savedNames.length = 0;
  failNext = false;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe('chart v2 client', () => {
  test('draws the chart, hides the table visually and shows a toggle legend', async () => {
    const root = await mount([COMBO]);
    expect(charts).toHaveLength(1);
    expect(charts[0]?.config.data.datasets.map(d => d.type)).toEqual(['bar', 'line']);
    expect(root.querySelector('canvas')?.getAttribute('style')).toBeNull();
    expect(root.querySelector('.zb-sr-only table')).not.toBeNull();
    expect(legendButtons(root).map(b => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['Doanh thu', 'true'], ['Biên', 'true']]);
    expect(root.querySelector('.zb-chart-legend')?.getAttribute('aria-label')).toBe('Chú giải: bấm để ẩn hoặc hiện');
  });

  test('legend buttons hide and show series, and Show all restores them', async () => {
    const root = await mount([COMBO], 'en');
    await click(legendButtons(root)[1]);
    expect(charts[0]?.datasetVisible).toEqual([true, false]);
    expect(legendButtons(root)[1]?.getAttribute('aria-pressed')).toBe('false');
    await click(legendButtons(root)[0]);
    expect(charts[0]?.datasetVisible).toEqual([false, false]);
    await click(button(root, 'Show all'));
    expect(charts[0]?.datasetVisible).toEqual([true, true]);
    expect(button(root, 'Show all')).toBeUndefined();
    expect(charts[0]?.updates).toBe(3);
  });

  test('pie legends toggle slices and sit under the chart', async () => {
    const root = await mount([PIE]);
    const legend = root.querySelector('.zb-chart-legend');
    expect(legend?.previousElementSibling?.tagName).toBe('CANVAS');
    expect(legendButtons(root).map(b => b.textContent)).toEqual(['A', 'B', 'C']);
    await click(legendButtons(root)[2]);
    expect(charts[0]?.dataVisible).toEqual([true, true, false]);
    await click(legendButtons(root)[2]);
    expect(charts[0]?.dataVisible).toEqual([true, true, true]);
  });

  test('a single series without a legend setting has no legend; legend none hides it', async () => {
    const one: ChartBlock = { id: 'one', type: 'chart', kind: 'area', labels: ['a'], series: [{ name: 'S', data: [1] }] };
    expect(legendButtons(await mount([one]))).toHaveLength(0);
    expect(legendButtons(await mount([{ ...PIE, id: 'p2', legend: 'none' }]))).toHaveLength(0);
  });

  test('downloads the data as CSV and the drawn chart as PNG', async () => {
    const root = await mount([COMBO], 'en');
    await click(button(root, 'Download CSV'));
    await click(button(root, 'Download PNG'));
    expect(savedNames).toEqual(['doanh-thu.csv', 'doanh-thu.png']);
    expect(await blobs[0]?.text()).toBe('﻿Label,Doanh thu,Biên\r\nQ1,10,5\r\nQ2,20,6\r\n');
    expect(blobs[1]?.type).toBe('image/png');
    expect(blobs[1]?.size).toBe(8);
  });

  test('keeps the table and explains when Chart.js cannot load', async () => {
    failNext = true;
    const root = await mount([COMBO]);
    expect(root.querySelector('.zb-note')?.textContent).toBe('Không tải được biểu đồ; dữ liệu hiển thị dạng bảng.');
    expect(root.querySelector('.zb-scroll table')).not.toBeNull();
    expect(root.querySelector('canvas')?.getAttribute('style')).toBe('display: none;');
    expect(legendButtons(root)).toHaveLength(0);
    expect(button(root, 'Tải PNG')).toBeUndefined();
  });

  test('the Studio editor switches kind, sets axes and marks, and removes unset options', async () => {
    const { ChartFields } = await import('../src/components/studio/ChartFields');
    const { validateDocument } = await import('../src/lib/blocks/validate');
    let current: Block = COMBO;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = client.createRoot(container);
    mounted.push({ root, container });
    const draw = () => React.act(() => root.render(React.createElement(ChartFields, {
      block: current.type === 'chart' ? current : COMBO,
      onChange: (b: Block) => { current = b; draw(); },
    })));
    draw();
    const select = (label: string) => [...container.querySelectorAll('label')].find(l => l.textContent?.startsWith(label))?.querySelector('select');
    const choose = async (el: HTMLSelectElement | null | undefined, value: string) => {
      if (!el) throw new Error('missing select');
      await React.act(async () => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
    };
    const check = async (label: string) => {
      const box = [...container.querySelectorAll('label')].find(l => l.textContent === label)?.querySelector('input');
      await click(box);
    };
    const chart = () => { if (current.type !== 'chart') throw new Error('not a chart'); return current; };

    await click(button(container, '+ Đường mốc'));
    await click(button(container, '+ Ghi chú'));
    await choose(select('Chú giải'), 'none');
    await check('Xếp chồng');
    expect(chart().references).toEqual([{ value: 0 }]);
    expect(chart().legend).toBe('none');
    expect(chart().stacked).toBe(true);
    // A note needs text before the chart is valid.
    const note = [...container.querySelectorAll('label')].find(l => l.textContent?.startsWith('Nội dung'))?.querySelector('input');
    if (!(note instanceof HTMLInputElement)) throw new Error('missing note input');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(note, 'Ra mắt');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(chart().annotations).toEqual([{ index: 0, text: 'Ra mắt' }]);
    expect(validateDocument({ version: 1, blocks: [chart()] }).ok).toBe(true);

    await choose(select('Chú giải'), 'auto');
    expect('legend' in chart()).toBe(false);
    await choose(select('Loại'), 'pie');
    expect(chart().kind).toBe('pie');
    for (const key of ['stacked', 'references', 'annotations', 'y2'] as const) expect(key in chart()).toBe(false);
    expect(validateDocument({ version: 1, blocks: [chart()] }).ok).toBe(true);
    expect(select('Vẽ dạng')).toBeUndefined();
  });

  test('destroys the chart on unmount', async () => {
    await mount([COMBO]);
    const chart = charts[0];
    const m = mounted.splice(0)[0];
    if (!m) throw new Error('not mounted');
    React.act(() => m.root.unmount());
    m.container.remove();
    expect(chart?.destroyed).toBe(true);
  });
});
