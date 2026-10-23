import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Root } from 'react-dom/client';
import type { Block } from '../src/lib/blocks/schema';

// Code block toolbar after hydration: copy (raw code, never diff markers), wrap toggle and expand/collapse.
// Installs happy-dom as process globals: never run with `bun test --concurrent`.

type ReactModule = typeof import('react');
type ClientModule = typeof import('react-dom/client');

let React: ReactModule;
let client: ClientModule;
let renderer: typeof import('../src/components/blocks/BlockRenderer');
let toastBus: typeof import('../src/components/feedback/toast-bus');

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
const written: string[] = [];
let clipboardFails = false;

function mount(blocks: Block[]): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = client.createRoot(container);
  React.act(() => root.render(React.createElement(renderer.BlockRenderer, { doc: { version: 1, blocks }, interactive: false })));
  mounted.push({ root, container });
  return container;
}

async function click(el: Element | null) {
  if (!el) throw new Error('missing element');
  await React.act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 0));
  });
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'https://zuey.me/articles/demo' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(text: string) {
        if (clipboardFails) throw new Error('denied');
        written.push(text);
      },
    },
  });
  React = await import('react');
  client = await import('react-dom/client');
  renderer = await import('../src/components/blocks/BlockRenderer');
  toastBus = await import('../src/components/feedback/toast-bus');
});

afterEach(() => {
  for (const m of mounted.splice(0)) {
    React.act(() => m.root.unmount());
    m.container.remove();
  }
  written.length = 0;
  clipboardFails = false;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe('code block toolbar', () => {
  test('copies a diff as the code after the change, without markers, and announces it once', async () => {
    const root = mount([{ id: 'd', type: 'code', language: 'ts', diff: true, code: ' a = 1\n-b = 2\n+b = 3' }]);
    await click(root.querySelector('button[aria-label="Chép code"]'));
    expect(written).toEqual(['a = 1\nb = 3']);
    expect(root.querySelector('[role="status"]')?.textContent).toBe('Đã chép code');
    expect(root.querySelector('button[aria-label="Chép code"]')?.getAttribute('data-state')).toBe('copied');
  });

  test('hands the confirmation to a page Toaster when one is mounted', async () => {
    const toasts: string[] = [];
    const listener = (e: Event) => {
      if (e instanceof CustomEvent) {
        const detail = toastBus.parseToastDetail(e.detail);
        if (detail) { toasts.push(detail.message); e.preventDefault(); }
      }
    };
    window.addEventListener(toastBus.TOAST_EVENT, listener);
    try {
      const root = mount([{ id: 'p', type: 'code', language: '', code: 'echo hi\r\n' }]);
      await click(root.querySelector('button[aria-label="Chép code"]'));
      expect(written).toEqual(['echo hi\n']);
      expect(toasts).toEqual(['Đã chép code']);
      expect(root.querySelector('[role="status"]')?.textContent).toBe('');
    } finally {
      window.removeEventListener(toastBus.TOAST_EVENT, listener);
    }
  });

  test('reports a failed copy', async () => {
    clipboardFails = true;
    const root = mount([{ id: 'f', type: 'code', language: '', code: 'x' }]);
    await click(root.querySelector('button[aria-label="Chép code"]'));
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Không chép được');
  });

  test('adds the toolbar to plain blocks once hydrated, keeping their code', () => {
    const root = mount([{ id: 'p', type: 'code', language: 'ts', code: 'let a = 1;' }]);
    expect(root.querySelector('.zb-codeblock .zb-code-tools [aria-label="Xuống dòng"]')).not.toBeNull();
    expect(root.querySelector('code')?.textContent).toBe('let a = 1;');
  });

  test('toggles wrapping', async () => {
    const root = mount([{ id: 'w', type: 'code', language: '', code: 'x'.repeat(300), wrap: true }]);
    const pre = () => root.querySelector('pre');
    const toggle = root.querySelector('button[aria-label="Xuống dòng"]');
    expect(pre()?.classList.contains('zb-code-wrap')).toBe(true);
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    await click(toggle);
    expect(pre()?.classList.contains('zb-code-wrap')).toBe(false);
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
  });

  test('expands and collapses long code', async () => {
    const code = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const root = mount([{ id: 'c', type: 'code', language: '', code, collapseAfter: 10 }]);
    const pre = () => root.querySelector('pre');
    const expand = root.querySelector('.zb-code-expand');
    expect(pre()?.classList.contains('zb-code-collapsed')).toBe(true);
    expect(expand?.textContent).toBe('Hiện toàn bộ 30 dòng');
    expect(expand?.getAttribute('aria-expanded')).toBe('false');
    await click(expand);
    expect(pre()?.classList.contains('zb-code-collapsed')).toBe(false);
    expect(expand?.getAttribute('aria-expanded')).toBe('true');
    expect(expand?.textContent).toBe('Thu gọn');
    // The whole code is in the DOM either way; collapsing only limits the height.
    expect(pre()?.querySelector('code')?.textContent).toBe(code);
  });
});
