import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { ReactElement } from 'react';
import type { Block, EmbedProvider } from '../src/lib/blocks/schema';

// Client behaviour of embeds and the Studio paste flow, in happy-dom. Iframe page loading is disabled,
// so no third-party request ever leaves the test process.

type ReactModule = typeof import('react');
type ClientModule = typeof import('react-dom/client');
type RendererModule = typeof import('../src/components/blocks/BlockRenderer');
type EditorModule = typeof import('../src/components/studio/ArticleEditor');
type EmbedViewModule = typeof import('../src/components/blocks/EmbedView');

let React: ReactModule;
let client: ClientModule;
let renderer: RendererModule;
let editor: EditorModule;
let embedView: EmbedViewModule;

/** Controllable IntersectionObserver: tests decide when a target enters the viewport. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets: Element[] = [];
  disconnected = false;
  constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void, readonly options?: { rootMargin?: string }) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: Element) { this.targets.push(el); }
  unobserve() {}
  disconnect() { this.disconnected = true; }
  takeRecords() { return []; }
  fire(isIntersecting: boolean) { this.callback(this.targets.map(target => ({ isIntersecting, target }))); }
}

const mounted: Array<{ unmount: () => void; container: HTMLElement }> = [];
const originalConsoleError = console.error;

beforeAll(async () => {
  GlobalRegistrator.register({ settings: { disableIframePageLoading: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  // happy-dom reports every (intentionally) blocked frame load through console.error; keep other errors visible.
  console.error = (...args: unknown[]) => {
    if (args[0] instanceof Error && args[0].message.includes('Iframe page loading is disabled')) return;
    originalConsoleError(...args);
  };
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, IntersectionObserver: FakeIntersectionObserver });
  // Imported after the DOM exists: react-dom decides DOM support at module load.
  React = await import('react');
  client = await import('react-dom/client');
  renderer = await import('../src/components/blocks/BlockRenderer');
  editor = await import('../src/components/studio/ArticleEditor');
  embedView = await import('../src/components/blocks/EmbedView');
});

afterEach(() => {
  for (const m of mounted.splice(0)) {
    React.act(() => m.unmount());
    m.container.remove();
  }
  FakeIntersectionObserver.instances = [];
  window.localStorage.clear();
  jest.useRealTimers();
});

afterAll(async () => {
  console.error = originalConsoleError;
  await GlobalRegistrator.unregister();
});

function mount(element: ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = client.createRoot(container);
  React.act(() => root.render(element));
  mounted.push({ unmount: () => root.unmount(), container });
  return container;
}

function article(url: string, provider: EmbedProvider, autoLoadEmbeds = true): HTMLElement {
  const blocks: Block[] = [{ id: 'e1', type: 'embed', url, provider }];
  return mount(React.createElement(renderer.BlockRenderer, { doc: { version: 1, blocks }, autoLoadEmbeds }));
}

function scrollIntoView() {
  React.act(() => { for (const io of FakeIntersectionObserver.instances) io.fire(true); });
}

/** happy-dom does not load frames, so give the iframe a stand-in window to compare message sources with. */
function stubFrameWindow(frame: HTMLIFrameElement): object {
  const win = {};
  Object.defineProperty(frame, 'contentWindow', { value: win, configurable: true });
  return win;
}

function postFromFrame(source: object | null, origin: string, data: unknown) {
  const event = new window.MessageEvent('message', { data, origin });
  Object.defineProperty(event, 'source', { value: source });
  React.act(() => { window.dispatchEvent(event); });
}

function click(el: Element | null) {
  if (!(el instanceof window.HTMLElement)) throw new Error('missing element to click');
  React.act(() => { el.click(); });
}

function fireLoad(frame: HTMLIFrameElement) {
  React.act(() => { frame.dispatchEvent(new window.Event('load')); });
}

function byText(root: HTMLElement, selector: string, text: string): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>(selector)].find(el => el.textContent?.includes(text)) ?? null;
}

const X_URL = 'https://x.com/someone/status/1234567890123';
const X_RESIZE = { 'twttr.embed': { method: 'twttr.private.resize', params: [{ width: 550, height: 300 }] } };

describe('embeds load when scrolled into view', () => {
  it('waits for the viewport, then mounts the sandboxed provider frame', () => {
    const view = article(X_URL, 'x');
    expect(view.querySelector('iframe')).toBeNull();
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    expect(FakeIntersectionObserver.instances[0].options?.rootMargin).toBe(embedView.EMBED_PRELOAD_MARGIN);

    React.act(() => FakeIntersectionObserver.instances[0].fire(false));
    expect(view.querySelector('iframe')).toBeNull();

    scrollIntoView();
    const frame = view.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe('https://platform.twitter.com/embed/Tweet.html?id=1234567890123&dnt=true');
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-popups allow-presentation');
    expect(FakeIntersectionObserver.instances[0].disconnected).toBe(true);
  });

  it('keeps editor previews click-to-load', () => {
    const view = article(X_URL, 'x', false);
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
    click(byText(view, 'button', 'Tải nội dung từ'));
    expect(view.querySelector('iframe')).not.toBeNull();
  });

  it('honours the per-device opt-out and lets the reader load on demand', () => {
    const view = article(X_URL, 'x');
    scrollIntoView();
    expect(view.querySelector('iframe')).not.toBeNull();

    click(byText(view, 'button', 'Không tự tải'));
    expect(window.localStorage.getItem(embedView.EMBED_PREF_KEY)).toBe('click');
    expect(view.querySelector('iframe')).toBeNull();

    click(byText(view, 'button', 'Tải nội dung từ'));
    expect(view.querySelector('iframe')).not.toBeNull();

    click(byText(view, 'button', 'Tự tải nội dung nhúng'));
    expect(window.localStorage.getItem(embedView.EMBED_PREF_KEY)).toBeNull();
  });
});

describe('height messages', () => {
  it('only accepts resize messages sent by the embed frame itself, from the provider origin', () => {
    const view = article(X_URL, 'x');
    scrollIntoView();
    const frame = view.querySelector('iframe');
    if (!frame) throw new Error('frame not mounted');
    const win = stubFrameWindow(frame);
    const box = view.querySelector<HTMLElement>('.zb-embed-frame');

    postFromFrame({}, 'https://platform.twitter.com', X_RESIZE); // another window
    postFromFrame(null, 'https://platform.twitter.com', X_RESIZE); // no source
    postFromFrame(win, 'https://evil.example', X_RESIZE); // right window, wrong origin
    expect(box?.style.height).toBe('');

    postFromFrame(win, 'https://platform.twitter.com', X_RESIZE);
    expect(box?.style.height).toBe('300px');
  });
});

describe('slow or blocked frames', () => {
  it('shows a non-blocking notice after the timeout and keeps the frame, which can still finish', () => {
    jest.useFakeTimers();
    const view = article(X_URL, 'x');
    scrollIntoView();
    const frame = view.querySelector('iframe');
    if (!frame) throw new Error('frame not mounted');
    const win = stubFrameWindow(frame);
    fireLoad(frame); // `load` alone is not readiness for X: error pages fire it too.

    React.act(() => { jest.advanceTimersByTime(embedView.EMBED_SLOW_MS - 1); });
    expect(view.querySelector('.zb-embed-notice')).toBeNull();
    React.act(() => { jest.advanceTimersByTime(1); });
    const notice = view.querySelector('.zb-embed-notice');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.querySelector('a')?.getAttribute('href')).toBe(X_URL);
    expect(view.querySelector('iframe')).toBe(frame);

    postFromFrame(win, 'https://platform.twitter.com', X_RESIZE);
    expect(view.querySelector('.zb-embed-notice')).toBeNull();
  });

  it('retries with a fresh frame', () => {
    jest.useFakeTimers();
    const view = article(X_URL, 'x');
    scrollIntoView();
    const first = view.querySelector('iframe');
    React.act(() => { jest.advanceTimersByTime(embedView.EMBED_SLOW_MS); });

    click(byText(view, '.zb-embed-notice button', 'Thử lại'));
    const second = view.querySelector('iframe');
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(view.querySelector('.zb-embed-notice')).toBeNull();

    React.act(() => { jest.advanceTimersByTime(embedView.EMBED_SLOW_MS); });
    expect(view.querySelector('.zb-embed-notice')).not.toBeNull();
  });

  it('treats load as readiness for providers that do not report height', () => {
    jest.useFakeTimers();
    const view = article('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube');
    scrollIntoView();
    const frame = view.querySelector('iframe');
    if (!frame) throw new Error('frame not mounted');
    fireLoad(frame);
    expect(view.querySelector('.zb-embed-frame.is-loading')).toBeNull();
    React.act(() => { jest.advanceTimersByTime(embedView.EMBED_SLOW_MS * 2); });
    expect(view.querySelector('.zb-embed-notice')).toBeNull();
  });
});

describe('layout (computed styles from the real stylesheet)', () => {
  it('centres each provider in a box of the right width', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(new URL('../src/styles/blocks.css', import.meta.url), 'utf8');
    document.head.appendChild(style);
    try {
      const cases: Array<[string, EmbedProvider, string]> = [
        [X_URL, 'x', '550px'],
        ['https://www.instagram.com/p/C0deAbc123/', 'instagram', '540px'],
        ['https://www.facebook.com/someone/posts/abc', 'facebook', '500px'],
        ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', '100%'],
      ];
      for (const [url, provider, maxWidth] of cases) {
        const view = article(url, provider);
        const figure = view.querySelector('figure.zb-embed');
        const frame = view.querySelector('.zb-embed-frame');
        if (!figure || !frame) throw new Error(`no embed rendered for ${provider}`);
        expect(getComputedStyle(figure).alignItems).toBe('center');
        expect(getComputedStyle(figure).getPropertyValue('--zb-embed-max').trim() || '100%').toBe(maxWidth);
        expect(getComputedStyle(frame).width).toBe('100%');
      }
      const view = article('https://www.facebook.com/someone/posts/abc', 'facebook');
      const fbFrame = view.querySelector('.zb-embed-frame');
      if (!fbFrame) throw new Error('no facebook frame');
      expect(getComputedStyle(fbFrame).aspectRatio.replace(/\s/g, '')).toBe('1/1');
    } finally {
      style.remove();
    }
  });
});

describe('Studio: pasted links become embed blocks', () => {
  function paste(target: Element | null, text: string) {
    if (!target) throw new Error('missing paste target');
    const event = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
    React.act(() => { target.dispatchEvent(event); });
    return event;
  }

  it('converts a link pasted into an empty paragraph, keeping the block id and original URL', () => {
    const changes: Block[] = [];
    const view = mount(React.createElement(editor.ParagraphField, {
      block: { id: 'p1', type: 'paragraph', text: '' }, onChange: (b: Block) => { changes.push(b); }, allowed: [],
    }));
    const event = paste(view.querySelector('textarea'), `${X_URL}\n`);
    expect(event.defaultPrevented).toBe(true);
    expect(changes).toEqual([{ id: 'p1', type: 'embed', url: X_URL, provider: 'x' }]);
  });

  it('leaves prose and non-empty paragraphs alone, but offers one-click conversion of a bare link', () => {
    const changes: Block[] = [];
    const onChange = (b: Block) => { changes.push(b); };
    const empty = mount(React.createElement(editor.ParagraphField, { block: { id: 'p1', type: 'paragraph', text: '' }, onChange, allowed: [] }));
    expect(paste(empty.querySelector('textarea'), `xem ${X_URL}`).defaultPrevented).toBe(false);
    const filled = mount(React.createElement(editor.ParagraphField, { block: { id: 'p2', type: 'paragraph', text: 'Mở đầu' }, onChange, allowed: [] }));
    expect(paste(filled.querySelector('textarea'), X_URL).defaultPrevented).toBe(false);
    expect(changes).toEqual([]);

    const bare = mount(React.createElement(editor.ParagraphField, { block: { id: 'p3', type: 'paragraph', text: X_URL }, onChange, allowed: [] }));
    click(byText(bare, 'button', 'Chuyển thành khối nhúng X'));
    expect(changes).toEqual([{ id: 'p3', type: 'embed', url: X_URL, provider: 'x' }]);
  });

  it('inserts an embed when a link is pasted into the empty block inserter', () => {
    const inserted: Block[] = [];
    const view = mount(React.createElement(editor.BlockInserter, { allowed: [], onInsert: (b: Block) => { inserted.push(b); } }));
    paste(view.querySelector('input'), 'https://www.instagram.com/p/C0deAbc123/');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ type: 'embed', url: 'https://www.instagram.com/p/C0deAbc123/', provider: 'instagram' });
  });

  it('can turn an embed back into a paragraph (undo for a conversion)', () => {
    const changes: Block[] = [];
    const view = mount(React.createElement(editor.EmbedFields, {
      block: { id: 'e1', type: 'embed', url: X_URL, provider: 'x' }, onChange: (b: Block) => { changes.push(b); },
    }));
    click(byText(view, 'button', 'Chuyển về đoạn văn'));
    expect(changes).toEqual([{ id: 'e1', type: 'paragraph', text: X_URL }]);
  });
});
