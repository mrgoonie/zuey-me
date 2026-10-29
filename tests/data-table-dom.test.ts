import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Root } from 'react-dom/client';
import type { Block, TableBlock } from '../src/lib/blocks/schema';

// Data table controls after hydration: sort buttons with aria-sort, search, filters, reset and CSV export of the visible rows.
// Installs happy-dom as process globals: never run with `bun test --concurrent`.

type ReactModule = typeof import('react');
type ClientModule = typeof import('react-dom/client');

let React: ReactModule;
let client: ClientModule;
let renderer: typeof import('../src/components/blocks/BlockRenderer');

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
const blobs: Blob[] = [];
const savedNames: string[] = [];

const TABLE: TableBlock = {
  id: 'prices', type: 'table', title: 'Bảng giá',
  headers: ['Gói', 'Giá', 'Hỗ trợ', 'Nhãn'],
  columns: [{ type: 'text' }, { type: 'currency', currency: 'VND', filter: true }, { type: 'boolean', filter: true }, { type: 'badge', filter: true }],
  rows: [
    ['Pro', '490000', 'true', 'Phổ biến'],
    ['Cơ bản', '190000', 'false', 'Mới'],
    ['Hà Nội', '', 'true', '@x'],
  ],
  sortable: true, search: true, csv: true,
};

async function flush() {
  await React.act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); });
}

async function mount(blocks: Block[], locale?: string): Promise<HTMLElement> {
  return mountNode(React.createElement(renderer.BlockRenderer, { doc: { version: 1, blocks }, interactive: false, locale }));
}

async function mountNode(node: ReturnType<ReactModule['createElement']>): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = client.createRoot(container);
  React.act(() => root.render(node));
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

async function type(el: Element | null | undefined, value: string) {
  if (!(el instanceof HTMLInputElement)) throw new Error('missing input');
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
  });
}

async function choose(el: Element | null | undefined, value: string) {
  if (!(el instanceof HTMLSelectElement)) throw new Error('missing select');
  await React.act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
  });
}

function firstColumn(root: HTMLElement): string[] {
  return [...root.querySelectorAll('tbody tr')].map(tr => tr.querySelector('td')?.textContent ?? '');
}

function sortButton(root: HTMLElement, header: string): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>('button.zb-dt-sort')].find(b => b.textContent?.startsWith(header));
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'https://zuey.me/articles/demo' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  URL.createObjectURL = (obj: Blob | MediaSource) => {
    if (obj instanceof Blob) blobs.push(obj);
    return 'blob:test';
  };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) { savedNames.push(this.download); };
  React = await import('react');
  client = await import('react-dom/client');
  renderer = await import('../src/components/blocks/BlockRenderer');
});

afterEach(() => {
  for (const m of mounted.splice(0)) {
    React.act(() => m.root.unmount());
    m.container.remove();
  }
  blobs.length = 0;
  savedNames.length = 0;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe('data table controls', () => {
  test('sort buttons cycle ascending, descending and off with aria-sort and a status line', async () => {
    const root = await mount([TABLE]);
    const th = () => sortButton(root, 'Giá')?.closest('th');
    expect(th()?.getAttribute('aria-sort')).toBe('none');
    await click(sortButton(root, 'Giá'));
    expect(th()?.getAttribute('aria-sort')).toBe('ascending');
    expect(firstColumn(root)).toEqual(['Cơ bản', 'Pro', 'Hà Nội']);
    expect(root.querySelector('[role="status"]')?.textContent).toBe('Hiển thị 3/3 hàng, sắp xếp theo Giá tăng dần');
    await click(sortButton(root, 'Giá'));
    expect(th()?.getAttribute('aria-sort')).toBe('descending');
    expect(firstColumn(root)).toEqual(['Pro', 'Cơ bản', 'Hà Nội']);
    await click(sortButton(root, 'Giá'));
    expect(th()?.getAttribute('aria-sort')).toBe('none');
    expect(firstColumn(root)).toEqual(['Pro', 'Cơ bản', 'Hà Nội']);
  });

  test('search ignores diacritics and reset restores every row', async () => {
    const root = await mount([TABLE]);
    await type(root.querySelector('input[type="search"]'), 'ha noi');
    expect(firstColumn(root)).toEqual(['Hà Nội']);
    expect(root.querySelector('[role="status"]')?.textContent).toBe('Hiển thị 1/3 hàng');
    await type(root.querySelector('input[type="search"]'), 'khong-co');
    expect(root.querySelector('.zb-dt-empty')?.textContent).toBe('Không có hàng phù hợp.');
    await click(root.querySelector('button.zb-dt-reset'));
    expect(firstColumn(root)).toHaveLength(3);
    expect(root.querySelector('button.zb-dt-reset')).toBeNull();
  });

  test('value and range filters narrow the rows', async () => {
    const root = await mount([TABLE]);
    const support = [...root.querySelectorAll('label.zb-dt-field')].find(l => l.textContent?.startsWith('Hỗ trợ'));
    await choose(support?.querySelector('select'), 'false');
    expect(firstColumn(root)).toEqual(['Cơ bản']);
    await choose(support?.querySelector('select'), '');
    await type(root.querySelector('input[aria-label="Giá từ"]'), '200000');
    expect(firstColumn(root)).toEqual(['Pro']);
  });

  test('labels every control', async () => {
    const root = await mount([TABLE]);
    for (const input of root.querySelectorAll('input, select')) {
      const labelled = input.getAttribute('aria-label') || input.closest('label')?.textContent;
      expect(Boolean(labelled)).toBe(true);
    }
    expect(root.querySelector('[role="region"]')?.getAttribute('tabindex')).toBe('0');
  });

  test('exports the visible rows in display order as guarded CSV', async () => {
    const root = await mount([{ ...TABLE, rows: [...TABLE.rows, ['=HYPERLINK("x")', '1', 'true', '+cmd']] }]);
    await click(sortButton(root, 'Giá'));
    const button = [...root.querySelectorAll('button')].find(b => b.textContent === 'Tải CSV');
    await click(button);
    expect(savedNames).toEqual(['bang-gia.csv']);
    const csv = await blobs[0]?.text();
    expect(csv?.replace(/^﻿/, '').split('\r\n')).toEqual([
      'Gói,Giá,Hỗ trợ,Nhãn',
      `"'=HYPERLINK(""x"")",1,true,'+cmd`,
      'Cơ bản,190000,false,Mới',
      'Pro,490000,true,Phổ biến',
      'Hà Nội,,true,\'@x',
      '',
    ]);
  });

  test('cards mode adds the column labels once hydrated', async () => {
    const root = await mount([{ ...TABLE, mobile: 'cards' }]);
    expect(root.querySelector('.zb-dt-cards')).not.toBeNull();
    expect([...root.querySelectorAll('tbody tr:first-child td')].map(td => td.getAttribute('data-label'))).toEqual(TABLE.headers);
    expect(root.querySelector('td .zb-dt-yes')?.parentElement?.textContent).toBe('✓ Có');
  });

  test('cards mode keeps a multi-line text cell as one value item after the label', async () => {
    const root = await mount([{ ...TABLE, mobile: 'cards', rows: [['dòng 1\ndòng **2**', '490000', 'true', 'Mới']] }]);
    const td = root.querySelector('tbody tr td');
    expect(td?.getAttribute('data-label')).toBe('Gói');
    // The label is the ::before pseudo-element; the value must be the cell's only node so it stays in the value column.
    expect(td?.childNodes).toHaveLength(1);
    expect(td?.children).toHaveLength(1);
    expect(td?.querySelector('br')).not.toBeNull();
    expect(td?.textContent).toBe('dòng 1dòng 2');
    for (const cell of root.querySelectorAll('tbody td')) expect(cell.childNodes).toHaveLength(1);
  });

  test('English editions get English labels and numbers', async () => {
    const root = await mount([TABLE], 'en');
    expect(root.querySelector('[role="status"]')?.textContent).toBe('Showing 3 of 3 rows');
    expect(root.textContent).toContain('490,000 ₫');
    expect(root.querySelector('input[type="search"]')?.getAttribute('maxlength')).toBe('200');
  });

  test('a lazy chunk that fails to load shows its fallback and keeps the rest of the document', async () => {
    const failing = React.lazy(() => Promise.reject(new Error('chunk failed')));
    const original = console.error;
    console.error = () => {};
    try {
      const root = await mountNode(React.createElement('div', null,
        React.createElement('p', null, 'Intro'),
        React.createElement(renderer.LazyBoundary, { fallback: React.createElement('p', null, 'Fallback') },
          React.createElement(React.Suspense, { fallback: React.createElement('p', null, 'Loading') }, React.createElement(failing))),
        React.createElement('p', null, 'After')));
      expect(root.textContent).toBe('IntroFallbackAfter');
    } finally {
      console.error = original;
    }
  });
});