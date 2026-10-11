import { describe, it, expect, afterAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Renders in happy-dom. This file installs process globals: never run it with `bun test --concurrent`.
GlobalRegistrator.register();
const { act, createElement } = await import('react');
const { renderToString } = await import('react-dom/server');
const { hydrateRoot } = await import('react-dom/client');
const { BlockFrame } = await import('../src/components/blocks/BlockFrame');

afterAll(async () => {
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  await GlobalRegistrator.unregister();
});

function frame(props: Parameters<typeof BlockFrame>[0]) {
  return createElement(BlockFrame, props, createElement('p', { className: 'content' }, 'Nội dung'));
}

async function hydrate(props: Parameters<typeof BlockFrame>[0]) {
  const host = document.createElement('div');
  host.innerHTML = renderToString(frame(props));
  document.body.appendChild(host);
  const errors: unknown[] = [];
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  await act(async () => {
    hydrateRoot(host, frame(props), { onRecoverableError: (error: unknown) => { errors.push(error); } });
  });
  return { host, errors };
}

describe('BlockFrame', () => {
  it('server-renders title, content and caption without a toolbar', () => {
    const html = renderToString(frame({ title: 'Biểu đồ', caption: 'Nguồn: số liệu', fullscreen: true, copyText: () => 'x' }));
    expect(html).toContain('<figure class="zb-frame">');
    expect(html).toContain('<div class="zb-frame-title">Biểu đồ</div>');
    expect(html).toContain('<p class="content">Nội dung</p>');
    expect(html).toContain('<figcaption>Nguồn: số liệu</figcaption>');
    expect(html).not.toContain('zb-frame-toolbar');
  });

  it('shows the fallback while loading and above an error message', () => {
    const fallback = createElement('table', { className: 'fallback' });
    const loading = renderToString(createElement(BlockFrame, { state: 'loading', fallback }, 'chart'));
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('class="fallback"');
    expect(loading).not.toContain('chart');
    const bare = renderToString(createElement(BlockFrame, { state: 'loading' }, 'chart'));
    expect(bare).toContain('class="zb-frame-loading" role="status" aria-label="Đang tải…"');
    const failed = renderToString(createElement(BlockFrame, { state: 'error', fallback, errorMessage: 'Lỗi vẽ' }, 'chart'));
    expect(failed).toContain('<p class="zb-frame-error" role="status">Lỗi vẽ</p>');
    expect(failed).toContain('class="fallback"');
  });

  it('adds only supported toolbar actions after hydration, without a mismatch', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => undefined } });
    const { host, errors } = await hydrate({ title: 'T', copyText: () => 'abc', download: () => ({ filename: 'a.csv', data: 'a,b' }) });
    expect(errors).toEqual([]);
    const labels = Array.from(host.querySelectorAll('.zb-frame-btn')).map(b => b.textContent);
    expect(labels).toEqual(['Sao chép', 'Tải xuống']);
  });

  it('copies the computed text and confirms it', async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => { copied.push(s); } } });
    const { host } = await hydrate({ copyText: () => 'nội dung sao chép', labels: { copy: 'Copy', copied: 'Copied' } });
    const button = host.querySelector('.zb-frame-btn');
    if (!(button instanceof HTMLElement)) throw new Error('missing copy button');
    expect(button.textContent).toBe('Copy');
    await act(async () => { button.click(); await new Promise(r => setTimeout(r, 0)); });
    expect(copied).toEqual(['nội dung sao chép']);
    expect(button.textContent).toBe('Copied');
  });
});
