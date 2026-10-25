import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Root } from 'react-dom/client';
import type { Block, TabsBlock } from '../src/lib/blocks/schema';

// Tabs after hydration: WAI-ARIA roles, arrow/Home/End keys, #anchor deep links, and a hydration that keeps the
// server-rendered panels (no mismatch, no remount). Installs happy-dom as process globals: never run with
// `bun test --concurrent`.

type ReactModule = typeof import('react');
type ClientModule = typeof import('react-dom/client');
type ServerModule = typeof import('react-dom/server');

let React: ReactModule;
let client: ClientModule;
let server: ServerModule;
let renderer: typeof import('../src/components/blocks/BlockRenderer');

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
const errors: unknown[][] = [];

const TABS: TabsBlock = {
  id: 'b_tabs', type: 'tabs',
  tabs: [
    { label: 'npm', anchor: 'cai-npm', blocks: [{ id: 'b_p1', type: 'paragraph', text: 'npm i zuey' }] },
    { label: 'bun', anchor: 'cai-bun', blocks: [{ id: 'b_p2', type: 'paragraph', text: 'bun add **zuey**' }] },
    { label: 'pnpm', blocks: [{ id: 'b_p3', type: 'paragraph', text: 'pnpm add zuey' }] },
  ],
};

async function flush() {
  await React.act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); });
}

const element = (blocks: Block[]) => React.createElement(renderer.BlockRenderer, { doc: { version: 1, blocks }, interactive: false });

async function mount(blocks: Block[]): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = client.createRoot(container);
  React.act(() => root.render(element(blocks)));
  mounted.push({ root, container });
  await flush();
  return container;
}

async function key(target: Element | null | undefined, name: string) {
  if (!target) throw new Error('missing element');
  await React.act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 0));
  });
}

const tabs = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const panels = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.zb-tab-panel')];
const selected = (root: HTMLElement) => tabs(root).findIndex(t => t.getAttribute('aria-selected') === 'true');
const visible = (root: HTMLElement) => panels(root).filter(p => !p.hidden).map(p => p.id);

// happy-dom globals and console.error outlive GlobalRegistrator.unregister(); every patch is undone in afterAll.
const previousSsr = process.env.SSR;
let restore: Array<() => void> = [];

beforeAll(async () => {
  delete process.env.SSR;
  GlobalRegistrator.register({ url: 'https://zuey.me/articles/demo' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const consoleError = console.error;
  restore = [() => { console.error = consoleError; }];
  console.error = (...args: unknown[]) => { errors.push(args); };
  React = await import('react');
  client = await import('react-dom/client');
  server = await import('react-dom/server');
  renderer = await import('../src/components/blocks/BlockRenderer');
});

afterEach(() => {
  for (const m of mounted.splice(0)) {
    React.act(() => m.root.unmount());
    m.container.remove();
  }
  errors.length = 0;
  window.history.replaceState(null, '', '/articles/demo');
});

afterAll(async () => {
  for (const undo of restore.splice(0)) undo();
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  if (previousSsr === undefined) delete process.env.SSR;
  else process.env.SSR = previousSsr;
  await GlobalRegistrator.unregister();
});

describe('tabs on the client', () => {
  test('hydrates the all-panels server markup without a mismatch and keeps the panel content nodes', async () => {
    process.env.SSR = 'true';
    let markup: string;
    try {
      markup = server.renderToString(element([TABS]));
    } finally {
      delete process.env.SSR;
    }
    expect(markup).toContain('<h3 class="zb-tab-heading">bun</h3>');
    const container = document.createElement('div');
    container.innerHTML = markup;
    document.body.appendChild(container);
    const serverPanel = container.querySelector('#cai-bun');
    const serverText = container.querySelector('#cai-bun strong');
    let root: Root | undefined;
    React.act(() => { root = client.hydrateRoot(container, element([TABS])); });
    if (!root) throw new Error('hydration did not start');
    mounted.push({ root, container });
    await flush();
    expect(errors).toEqual([]);
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
    expect(container.querySelector('.zb-tab-heading')).toBeNull();
    // The nested blocks were hydrated in place, not re-created.
    expect(container.querySelector('#cai-bun')).toBe(serverPanel);
    expect(container.querySelector('#cai-bun strong')).toBe(serverText);
    expect(visible(container)).toEqual(['cai-npm']);
  });

  test('wires the WAI-ARIA tab pattern', async () => {
    const root = await mount([TABS]);
    const list = root.querySelector('[role="tablist"]');
    expect(list).not.toBeNull();
    const t = tabs(root);
    expect(t.map(b => b.textContent)).toEqual(['npm', 'bun', 'pnpm']);
    expect(t.map(b => b.tabIndex)).toEqual([0, -1, -1]);
    const p = panels(root);
    expect(p.map(x => x.getAttribute('role'))).toEqual(['tabpanel', 'tabpanel', 'tabpanel']);
    expect(t[1].getAttribute('aria-controls')).toBe('cai-bun');
    expect(p[1].getAttribute('aria-labelledby')).toBe(t[1].id);
    expect(p[2].id).toBe('b_tabs-panel-2');
    expect(visible(root)).toEqual(['cai-npm']);
  });

  test('moves with the arrow keys (wrapping), Home and End, focusing the selected tab', async () => {
    const root = await mount([TABS]);
    const list = root.querySelector('[role="tablist"]');
    await key(list, 'ArrowRight');
    expect(selected(root)).toBe(1);
    expect(document.activeElement).toBe(tabs(root)[1]);
    expect(tabs(root).map(b => b.tabIndex)).toEqual([-1, 0, -1]);
    expect(visible(root)).toEqual(['cai-bun']);
    await key(list, 'ArrowRight');
    await key(list, 'ArrowRight');
    expect(selected(root)).toBe(0);
    await key(list, 'ArrowLeft');
    expect(selected(root)).toBe(2);
    await key(list, 'Home');
    expect(selected(root)).toBe(0);
    await key(list, 'End');
    expect(selected(root)).toBe(2);
    expect(document.activeElement).toBe(tabs(root)[2]);
    await key(list, 'a');
    expect(selected(root)).toBe(2);
  });

  test('starts on the default tab and records anchored tabs in the URL fragment', async () => {
    const root = await mount([{ ...TABS, defaultTab: 2 }]);
    expect(selected(root)).toBe(2);
    await React.act(async () => { tabs(root)[1].click(); await new Promise(r => setTimeout(r, 0)); });
    expect(selected(root)).toBe(1);
    expect(window.location.hash).toBe('#cai-bun');
    // A tab without an anchor leaves the fragment alone.
    await React.act(async () => { tabs(root)[2].click(); await new Promise(r => setTimeout(r, 0)); });
    expect(window.location.hash).toBe('#cai-bun');
  });

  test('opens the tab named by the fragment on load and on hashchange', async () => {
    window.history.replaceState(null, '', '/articles/demo#cai-bun');
    const root = await mount([TABS]);
    expect(selected(root)).toBe(1);
    await React.act(async () => {
      window.history.replaceState(null, '', '/articles/demo#cai-npm');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await new Promise(r => setTimeout(r, 0));
    });
    expect(selected(root)).toBe(0);
    // An unrelated fragment changes nothing.
    await React.act(async () => {
      window.history.replaceState(null, '', '/articles/demo#elsewhere');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await new Promise(r => setTimeout(r, 0));
    });
    expect(selected(root)).toBe(0);
  });

  test('ignores a malformed percent-encoded fragment on load and on hashchange', async () => {
    window.history.replaceState(null, '', '/articles/demo#%E0%A4%A');
    const root = await mount([{ ...TABS, defaultTab: 1 }]);
    expect(errors).toEqual([]);
    expect(selected(root)).toBe(1);
    expect(visible(root)).toEqual(['cai-bun']);
    await React.act(async () => {
      window.history.replaceState(null, '', '/articles/demo#cai-%');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await new Promise(r => setTimeout(r, 0));
    });
    expect(errors).toEqual([]);
    expect(selected(root)).toBe(1);
    // A well-formed fragment still works afterwards.
    await React.act(async () => {
      window.history.replaceState(null, '', '/articles/demo#cai-npm');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await new Promise(r => setTimeout(r, 0));
    });
    expect(selected(root)).toBe(0);
  });
});
