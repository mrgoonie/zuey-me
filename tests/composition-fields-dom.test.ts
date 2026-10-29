import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Root } from 'react-dom/client';
import { LIMITS } from '../src/lib/blocks/schema';
import type { Block, CompositionBlock, ProgressBlock, StatBlock, TabsBlock } from '../src/lib/blocks/schema';

// Studio composition editor (tabs, stat, progress fields) driven like a user: type, reorder, remove, and replace the
// block from outside (the JSON tab). Installs happy-dom as process globals: never run with `bun test --concurrent`.

type ReactModule = typeof import('react');
type ClientModule = typeof import('react-dom/client');
type FieldsModule = typeof import('../src/components/studio/CompositionFields');

let React: ReactModule;
let client: ClientModule;
let fields: FieldsModule;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

const isComposition = (b: Block): b is CompositionBlock =>
  b.type === 'tabs' || b.type === 'stat' || b.type === 'steps' || b.type === 'comparison' || b.type === 'progress';

interface Editor {
  root: HTMLElement;
  /** The block as last saved by the editor. */
  saved: () => Block;
  /** Replaces the block from outside the editor, as the JSON tab does. */
  replace: (b: CompositionBlock) => Promise<void>;
}

async function settle() {
  await React.act(async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)); });
}

async function mount(initial: CompositionBlock): Promise<Editor> {
  let saved: Block = initial;
  let setBlock: ((b: CompositionBlock) => void) | undefined;
  function Harness() {
    const [block, set] = React.useState<CompositionBlock>(initial);
    setBlock = set;
    return React.createElement(fields.CompositionFields, {
      block,
      onChange: (next: Block) => { saved = next; if (isComposition(next)) set(next); },
      renderBody: () => null,
    });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = client.createRoot(container);
  React.act(() => root.render(React.createElement(Harness)));
  mounted.push({ root, container });
  await settle();
  return {
    root: container,
    saved: () => saved,
    replace: async b => {
      await React.act(async () => { saved = b; setBlock?.(b); });
      await settle();
    },
  };
}

/** Inputs whose field label is exactly `label`, in document order. */
function inputs(root: ParentNode, label: string): HTMLInputElement[] {
  return [...root.querySelectorAll('label')]
    .filter(l => l.querySelector('span')?.textContent === label)
    .flatMap(l => { const el = l.querySelector('input'); return el ? [el] : []; });
}
const values = (root: ParentNode, label: string) => inputs(root, label).map(i => i.value);

function group(root: HTMLElement, title: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[role="group"][aria-label="${title}"]`);
  if (!el) throw new Error(`missing group ${title}`);
  return el;
}

function button(root: ParentNode, match: (b: HTMLButtonElement) => boolean): HTMLButtonElement {
  const el = [...root.querySelectorAll('button')].find(match);
  if (!el) throw new Error('missing button');
  return el;
}

/** Clicks like a pointer does: focus leaves the field being edited first. */
async function click(el: HTMLButtonElement) {
  await React.act(async () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== el) active.blur();
    el.click();
  });
  await settle();
}

async function typeInto(el: HTMLInputElement | undefined, value: string) {
  if (!el) throw new Error('missing input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await React.act(async () => {
    el.focus();
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function blur(el: HTMLInputElement | undefined) {
  if (!el) throw new Error('missing input');
  await React.act(async () => { el.blur(); });
}

const removeIn = (root: HTMLElement, title: string) => click(button(group(root, title), b => b.textContent === 'Xoá'));
const moveDown = (root: HTMLElement, title: string) => click(button(group(root, title), b => b.getAttribute('aria-label') === `Đưa ${title} xuống`));

const STAT: StatBlock = {
  id: 'b_stat', type: 'stat',
  items: [
    { label: 'Người dùng', value: 1, delta: { value: 10 }, sparkline: [1, 2, 3] },
    { label: 'Doanh thu', value: 2, delta: { value: 20 }, sparkline: [4, 5, 6] },
    { label: 'Đơn hàng', value: 3 },
  ],
};

const TABS: TabsBlock = {
  id: 'b_tabs', type: 'tabs',
  tabs: [{ label: 'npm', blocks: [] }, { label: 'bun', blocks: [] }, { label: 'pnpm', blocks: [] }],
};

const SPARK = `Đường xu hướng (${LIMITS.sparklineMin}–${LIMITS.sparklineMax} số, cách nhau dấu phẩy)`;

// happy-dom globals outlive GlobalRegistrator.unregister(); every patch is undone in afterAll.
const previousSsr = process.env.SSR;

beforeAll(async () => {
  delete process.env.SSR;
  GlobalRegistrator.register({ url: 'https://zuey.me/studio' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  React = await import('react');
  client = await import('react-dom/client');
  fields = await import('../src/components/studio/CompositionFields');
});

afterEach(() => {
  for (const m of mounted.splice(0)) {
    React.act(() => m.root.unmount());
    m.container.remove();
  }
});

afterAll(async () => {
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  if (previousSsr === undefined) delete process.env.SSR;
  else process.env.SSR = previousSsr;
  await GlobalRegistrator.unregister();
});

describe('Studio composition editor: number fields', () => {

  test('removing an item shows the values of the items that remain', async () => {
    const ed = await mount(STAT);
    expect(values(ed.root, 'Giá trị')).toEqual(['1', '2', '3']);
    await removeIn(ed.root, 'Chỉ số 1');
    const saved = ed.saved();
    if (saved.type !== 'stat') throw new Error('not a stat block');
    expect(saved.items.map(i => i.value)).toEqual([2, 3]);
    expect(values(ed.root, 'Giá trị')).toEqual(['2', '3']);
    expect(values(ed.root, 'Chênh lệch (tuỳ chọn)')).toEqual(['20', '']);
    expect(values(ed.root, SPARK)).toEqual(['4, 5, 6', '']);
  });

  test('moving an item moves its values with it', async () => {
    const ed = await mount(STAT);
    await moveDown(ed.root, 'Chỉ số 1');
    expect(values(ed.root, 'Giá trị')).toEqual(['2', '1', '3']);
    expect(values(ed.root, 'Chênh lệch (tuỳ chọn)')).toEqual(['20', '10', '']);
    expect(values(ed.root, SPARK)).toEqual(['4, 5, 6', '1, 2, 3', '']);
  });

  test('an item edited after an earlier one was typed into and removed shows its own value', async () => {
    const ed = await mount(STAT);
    await typeInto(inputs(ed.root, 'Giá trị')[0], '7');
    await removeIn(ed.root, 'Chỉ số 1');
    expect(values(ed.root, 'Giá trị')).toEqual(['2', '3']);
    await typeInto(inputs(ed.root, 'Giá trị')[0], '25');
    const saved = ed.saved();
    if (saved.type !== 'stat') throw new Error('not a stat block');
    expect(saved.items.map(i => i.value)).toEqual([25, 3]);
  });

  test('replacing the block from outside (JSON edit) shows the new values', async () => {
    const ed = await mount(STAT);
    await ed.replace({
      ...STAT,
      items: [{ label: 'Người dùng', value: 42, delta: { value: -5 }, sparkline: [9, 8, 7] }, { label: 'Doanh thu', value: 2 }],
    });
    expect(values(ed.root, 'Giá trị')).toEqual(['42', '2']);
    expect(values(ed.root, 'Chênh lệch (tuỳ chọn)')).toEqual(['-5', '']);
    expect(values(ed.root, SPARK)).toEqual(['9, 8, 7', '']);
  });

  test('keeps the typed text while editing and shows the saved value once the field loses focus', async () => {
    const ed = await mount(STAT);
    const field = inputs(ed.root, 'Giá trị')[0];
    await typeInto(field, '1,5');
    expect(field.value).toBe('1,5');
    let saved = ed.saved();
    if (saved.type !== 'stat') throw new Error('not a stat block');
    expect(saved.items[0].value).toBe(1.5);
    // A partial number is kept on screen but not saved.
    await typeInto(field, '-');
    expect(field.value).toBe('-');
    saved = ed.saved();
    if (saved.type !== 'stat') throw new Error('not a stat block');
    expect(saved.items[0].value).toBe(1.5);
    await blur(field);
    expect(field.value).toBe('1.5');

    const optional = inputs(ed.root, 'Chênh lệch (tuỳ chọn)')[0];
    await typeInto(optional, '');
    saved = ed.saved();
    if (saved.type !== 'stat') throw new Error('not a stat block');
    expect(saved.items[0].delta).toBeUndefined();
    await blur(optional);
    expect(optional.value).toBe('');

    const spark = inputs(ed.root, SPARK)[0];
    await typeInto(spark, '3,4, 5');
    expect(spark.value).toBe('3,4, 5');
    await blur(spark);
    expect(spark.value).toBe('3, 4, 5');
  });

  test('progress thresholds follow removal', async () => {
    const block: ProgressBlock = {
      id: 'b_prog', type: 'progress', variant: 'bar', items: [{ label: 'A', value: 50 }],
      thresholds: [{ at: 30, state: 'warning' }, { at: 70, state: 'positive' }],
    };
    const ed = await mount(block);
    expect(values(ed.root, 'Ngưỡng 1')).toEqual(['30']);
    const removeFirst = [...ed.root.querySelectorAll('button')].filter(b => b.textContent === 'Xoá').at(-2);
    if (!removeFirst) throw new Error('missing threshold remove button');
    await click(removeFirst);
    expect(values(ed.root, 'Ngưỡng 1')).toEqual(['70']);
  });
});

describe('Studio composition editor: tabs default', () => {
  const openTab = (root: HTMLElement) => {
    const select = [...root.querySelectorAll('label')].find(l => l.querySelector('span')?.textContent === 'Tab mở sẵn')?.querySelector('select');
    return select?.value;
  };
  const savedTabs = (ed: Editor) => {
    const saved = ed.saved();
    if (saved.type !== 'tabs') throw new Error('not a tabs block');
    return saved;
  };

  test('moving the first tab with no explicit default keeps that tab open first', async () => {
    const ed = await mount(TABS);
    await moveDown(ed.root, 'Tab 1');
    const saved = savedTabs(ed);
    expect(saved.tabs.map(t => t.label)).toEqual(['bun', 'npm', 'pnpm']);
    expect(saved.defaultTab).toBe(1);
    expect(openTab(ed.root)).toBe('1');
  });

  test('moving another tab onto the first place keeps the first tab as the default', async () => {
    const ed = await mount(TABS);
    await click(button(group(ed.root, 'Tab 2'), b => b.getAttribute('aria-label') === 'Đưa Tab 2 lên'));
    const saved = savedTabs(ed);
    expect(saved.tabs.map(t => t.label)).toEqual(['bun', 'npm', 'pnpm']);
    expect(saved.defaultTab).toBe(1);
  });

  test('an explicit default follows its tab and drops back to implicit when it reaches the first place', async () => {
    const ed = await mount({ ...TABS, defaultTab: 1 });
    await click(button(group(ed.root, 'Tab 2'), b => b.getAttribute('aria-label') === 'Đưa Tab 2 lên'));
    const saved = savedTabs(ed);
    expect(saved.tabs.map(t => t.label)).toEqual(['bun', 'npm', 'pnpm']);
    expect('defaultTab' in saved).toBe(false);
    expect(openTab(ed.root)).toBe('0');
  });

  test('removing a tab before the default keeps the same tab open', async () => {
    const ed = await mount({ ...TABS, defaultTab: 2 });
    await removeIn(ed.root, 'Tab 1');
    const saved = savedTabs(ed);
    expect(saved.tabs.map(t => t.label)).toEqual(['bun', 'pnpm']);
    expect(saved.defaultTab).toBe(1);
  });
});
