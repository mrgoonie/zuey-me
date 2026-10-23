import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, jest } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { ReactElement } from 'react';
import type { ArticleDocument, Block, InteractiveBlock } from '../src/lib/blocks/schema';
import { applyPaywall } from '../src/lib/blocks/paywall';
import { SANDBOX_CHANNEL, SANDBOX_CSP } from '../src/lib/ai/sandbox-doc';
import { BlockRenderer as ServerBlockRenderer } from '../src/components/blocks/BlockRenderer';

// Published readers start sandboxed widgets when they near the viewport. Runs in happy-dom with frame
// loading disabled, so widget code never executes and no third-party request leaves the test process.

type ReactModule = typeof import('react');
type ClientModule = typeof import('react-dom/client');
type RendererModule = typeof import('../src/components/blocks/BlockRenderer');
type FrameModule = typeof import('../src/components/ai/InteractiveFrame');
type QueueModule = typeof import('../src/components/ai/frame-start-queue');
type LessonModule = typeof import('../src/components/courses/LessonContent');

let React: ReactModule;
let client: ClientModule;
let renderer: RendererModule;
let frameModule: FrameModule;
let queue: QueueModule;
let lesson: LessonModule;

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
  fire(isIntersecting: boolean) { if (!this.disconnected) this.callback(this.targets.map(target => ({ isIntersecting, target }))); }
}

const mounted: Array<{ unmount: () => void; container: HTMLElement }> = [];
const originalConsoleError = console.error;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  GlobalRegistrator.register({ settings: { disableIframePageLoading: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  console.error = (...args: unknown[]) => {
    if (args[0] instanceof Error && args[0].message.includes('Iframe page loading is disabled')) return;
    originalConsoleError(...args);
  };
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, IntersectionObserver: FakeIntersectionObserver });
  React = await import('react');
  client = await import('react-dom/client');
  renderer = await import('../src/components/blocks/BlockRenderer');
  frameModule = await import('../src/components/ai/InteractiveFrame');
  queue = await import('../src/components/ai/frame-start-queue');
  lesson = await import('../src/components/courses/LessonContent');
});

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  for (const m of mounted.splice(0)) {
    React.act(() => m.unmount());
    m.container.remove();
  }
  // Let the start queue's cool-down elapse so the next test starts from an idle queue.
  React.act(() => { jest.advanceTimersByTime(queue.FRAME_START_GAP_MS * 2); });
  jest.useRealTimers();
  FakeIntersectionObserver.instances = [];
  Object.assign(globalThis, { IntersectionObserver: FakeIntersectionObserver, fetch: originalFetch });
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

function widget(id: string, extra: Partial<InteractiveBlock> = {}): InteractiveBlock {
  return { id, type: 'interactive', title: `Demo ${id}`, html: '<p>hi</p>', css: '', js: 'document.body.dataset.ran = "1"', ...extra };
}

function published(blocks: Block[]): HTMLElement {
  return mount(React.createElement(renderer.BlockRenderer, { doc: { version: 1, blocks }, autoRunInteractives: true }));
}

function preview(blocks: Block[]): HTMLElement {
  return mount(React.createElement(renderer.BlockRenderer, { doc: { version: 1, blocks }, interactive: false, autoLoadEmbeds: false }));
}

function frames(root: HTMLElement): HTMLIFrameElement[] {
  return [...root.querySelectorAll<HTMLIFrameElement>('.zif iframe')];
}

function observerFor(root: HTMLElement, title: string): FakeIntersectionObserver {
  const figure = root.querySelector(`figure.zif[aria-label$="${title}"]`);
  const io = FakeIntersectionObserver.instances.find(o => !o.disconnected && o.targets.includes(figure as Element));
  if (!io) throw new Error(`no live observer for ${title}`);
  return io;
}

function enter(io: FakeIntersectionObserver, isIntersecting = true) {
  React.act(() => io.fire(isIntersecting));
}

function advance(ms: number) {
  React.act(() => { jest.advanceTimersByTime(ms); });
}

function click(el: Element | null | undefined) {
  if (!(el instanceof window.HTMLElement)) throw new Error('missing element to click');
  React.act(() => { el.click(); });
}

function button(root: HTMLElement, text: string): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>('button')].find(b => b.textContent?.includes(text)) ?? null;
}

/** happy-dom does not load frames: a stand-in window records what the parent posts to the frame. */
function stubFrameWindow(frame: HTMLIFrameElement): { posted: unknown[] } {
  const posted: unknown[] = [];
  const win = { posted, postMessage: (message: unknown) => { posted.push(message); } };
  Object.defineProperty(frame, 'contentWindow', { value: win, configurable: true });
  return win;
}

function postFromFrame(source: object | null, data: unknown) {
  const event = new window.MessageEvent('message', { data, origin: 'null' });
  Object.defineProperty(event, 'source', { value: source });
  React.act(() => { window.dispatchEvent(event); });
}

describe('published readers start widgets near the viewport', () => {
  it('mounts the sandboxed frame without a click once the block reaches the preload margin', () => {
    const view = published([widget('w1')]);
    expect(frames(view)).toHaveLength(0);
    const io = observerFor(view, 'Demo w1');
    expect(io.options?.rootMargin).toBe(frameModule.INTERACTIVE_PRELOAD_MARGIN);

    enter(io, false);
    advance(1000);
    expect(frames(view)).toHaveLength(0);

    enter(io);
    // Never synchronously from the observer callback: the start queue runs it on a later turn.
    expect(frames(view)).toHaveLength(0);
    advance(0);
    const [frame] = frames(view);
    expect(frame).toBeDefined();
    expect(io.disconnected).toBe(true);
    // Auto-start keeps the isolation of a manual start.
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.getAttribute('allow')).toBe('');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    const srcdoc = frame.getAttribute('srcdoc') ?? '';
    expect(srcdoc.indexOf(SANDBOX_CSP)).toBeGreaterThan(-1);
    expect(srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(srcdoc.indexOf('<style'));
    expect(button(view, 'Chạy lại')).not.toBeNull();
  });

  it('reserves the starting height before the frame exists', () => {
    const view = published([widget('w1', { height: 480 })]);
    expect(view.querySelector<HTMLElement>('.zif-placeholder')?.style.minHeight).toBe('480px');
    const plain = preview([widget('w2', { height: 480 })]);
    expect(plain.querySelector<HTMLElement>('.zif-placeholder')?.style.minHeight).toBe('');
  });

  it('does not start off-screen widgets, spaces out simultaneous starts and never recreates a running frame', () => {
    const blocks = Array.from({ length: 10 }, (_, i) => widget(`w${i}`));
    const view = published(blocks);
    advance(5000);
    expect(frames(view)).toHaveLength(0);
    expect(FakeIntersectionObserver.instances.filter(o => !o.disconnected)).toHaveLength(10);

    // A jump that brings every widget into range at once.
    const observers = blocks.map(b => observerFor(view, b.title));
    for (const io of observers) enter(io);
    expect(queue.pendingFrameStarts()).toBe(10);
    advance(0);
    expect(frames(view)).toHaveLength(1);
    advance(queue.FRAME_START_GAP_MS - 1);
    expect(frames(view)).toHaveLength(1);
    advance(1);
    expect(frames(view)).toHaveLength(2);
    advance(queue.FRAME_START_GAP_MS * 8);
    expect(frames(view)).toHaveLength(10);
    expect(queue.pendingFrameStarts()).toBe(0);

    // Scrolling away and back keeps the same frames: no reset, no new observer.
    const before = frames(view);
    for (const io of observers) { enter(io, false); enter(io); }
    advance(1000);
    expect(frames(view)).toEqual(before);
    expect(FakeIntersectionObserver.instances.filter(o => !o.disconnected)).toHaveLength(0);
  });

  it('drops queued starts and disconnects observers on unmount', () => {
    const blocks = Array.from({ length: 3 }, (_, i) => widget(`w${i}`));
    const view = published(blocks);
    const observers = blocks.map(b => observerFor(view, b.title));
    enter(observers[0]);
    expect(queue.pendingFrameStarts()).toBe(1);
    const m = mounted.pop();
    React.act(() => m?.unmount());
    m?.container.remove();
    expect(queue.pendingFrameStarts()).toBe(0);
    expect(observers.every(o => o.disconnected)).toBe(true);
    advance(1000);
  });

  it('a manual start before the queued one runs cancels the automatic start', () => {
    const view = published([widget('w1')]);
    enter(observerFor(view, 'Demo w1'));
    click(button(view, 'Chạy demo'));
    expect(frames(view)).toHaveLength(1);
    const first = frames(view)[0];
    expect(queue.pendingFrameStarts()).toBe(0);
    advance(1000);
    expect(frames(view)[0]).toBe(first);
  });

  it('stays click-to-run when IntersectionObserver is unavailable', () => {
    Object.assign(globalThis, { IntersectionObserver: undefined });
    const view = published([widget('w1')]);
    advance(5000);
    expect(frames(view)).toHaveLength(0);
    click(button(view, 'Chạy demo'));
    expect(frames(view)).toHaveLength(1);
  });

  it('starts widgets in toggles, sections, cards and layouts only when their own block becomes visible', () => {
    const blocks: Block[] = [
      { id: 't1', type: 'toggle', summary: 'Mở', blocks: [widget('in-toggle')] },
      { id: 's1', type: 'section', width: 'prose', surface: 'none', blocks: [widget('in-section')] },
      { id: 'c1', type: 'card', variant: 'outline', blocks: [widget('in-card')] },
      { id: 'l1', type: 'layout', variant: 'columns', cols: { base: 1, md: 2, lg: 2 }, children: [{ blocks: [widget('in-layout')] }, { blocks: [] }] },
    ];
    const view = published(blocks);
    expect(FakeIntersectionObserver.instances).toHaveLength(4);
    advance(1000);
    expect(frames(view)).toHaveLength(0);

    // A closed toggle body is not rendered, so its widget only intersects once the reader opens it.
    const toggle = view.querySelector('details.zb-toggle');
    expect(toggle?.hasAttribute('open')).toBe(false);
    enter(observerFor(view, 'Demo in-section'));
    advance(0);
    expect(frames(view).map(f => f.getAttribute('title'))).toEqual(['Demo in-section']);

    React.act(() => { toggle?.setAttribute('open', ''); });
    enter(observerFor(view, 'Demo in-toggle'));
    advance(queue.FRAME_START_GAP_MS);
    expect(frames(view).map(f => f.getAttribute('title')).sort()).toEqual(['Demo in-section', 'Demo in-toggle']);
  });
});

describe('surfaces that stay as they were', () => {
  it('Studio previews and drafts stay click-to-run: no observer, no frame until Run', () => {
    const view = preview([widget('w1'), { id: 't1', type: 'toggle', summary: 'Mở', open: true, blocks: [widget('w2')] }]);
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
    advance(5000);
    expect(frames(view)).toHaveLength(0);
    click(button(view, 'Chạy demo'));
    expect(frames(view)).toHaveLength(1);
  });

  it('chat artifacts keep starting immediately', () => {
    const view = mount(React.createElement(frameModule.InteractiveFrame, { block: widget('chat'), autoRun: true }));
    expect(frames(view)).toHaveLength(1);
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
  });

  it('an admin viewing a lesson draft keeps widgets click-to-run', () => {
    const view = mount(React.createElement(lesson.LessonContent, {
      segments: [{ kind: 'article', blocks: [widget('draft')] }], courseSlug: 'c', lessonSlug: 'l', signedIn: true,
    }));
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
    advance(5000);
    expect(frames(view)).toHaveLength(0);
  });

  it('the inline copy does not auto-start while the full-screen copy runs', () => {
    const view = published([widget('w1')]);
    // happy-dom has no modal dialogs: the full-screen copy only needs to render.
    window.HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
    window.HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute('open'); };
    click(button(view, 'Mở toàn màn hình'));
    expect(frames(view)).toHaveLength(1);
    expect(FakeIntersectionObserver.instances.filter(o => !o.disconnected)).toHaveLength(0);
    advance(1000);
    expect(frames(view)).toHaveLength(1);
  });

  it('published lesson readers auto-start widgets and auto-load embeds near the viewport', () => {
    const view = mount(React.createElement(lesson.LessonContent, {
      segments: [{ kind: 'article', blocks: [widget('lw'), { id: 'e1', type: 'embed', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', provider: 'youtube' }] }],
      courseSlug: 'c', lessonSlug: 'l', signedIn: false, autoRunInteractives: true,
    }));
    expect(FakeIntersectionObserver.instances).toHaveLength(2);
    expect(view.querySelector('iframe')).toBeNull();
    React.act(() => { for (const io of FakeIntersectionObserver.instances) io.fire(true); });
    advance(0);
    expect(frames(view)).toHaveLength(1);
    expect(view.querySelector('.zb-embed iframe')?.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  });
});

describe('auto-started frames keep the watchdog, message checks and broker quotas', () => {
  function started(): { view: HTMLElement; frame: HTMLIFrameElement; win: { posted: unknown[] } } {
    const view = published([widget('w1')]);
    enter(observerFor(view, 'Demo w1'));
    advance(0);
    const [frame] = frames(view);
    if (!frame) throw new Error('frame did not start');
    return { view, frame, win: stubFrameWindow(frame) };
  }

  it('halts a frame that never reports ready and does not restart it by itself', () => {
    const { view } = started();
    advance(frameModule.READY_TIMEOUT_MS);
    expect(frames(view)).toHaveLength(0);
    expect(view.querySelector('[role="status"]')?.textContent).toContain('không phản hồi');
    expect(FakeIntersectionObserver.instances.filter(o => !o.disconnected)).toHaveLength(0);
    advance(10_000);
    expect(frames(view)).toHaveLength(0);
    // Recoverable: the reader can run it again.
    click(button(view, 'Chạy demo'));
    expect(frames(view)).toHaveLength(1);
  });

  it('only answers messages sent by its own frame window', () => {
    const { view, win } = started();
    postFromFrame({}, { channel: SANDBOX_CHANNEL, type: 'resize', height: 600 });
    postFromFrame(null, { channel: SANDBOX_CHANNEL, type: 'resize', height: 600 });
    postFromFrame(win, { channel: 'other', type: 'resize', height: 600 });
    expect(frames(view)[0].style.height).toBe('320px');
    postFromFrame(win, { channel: SANDBOX_CHANNEL, type: 'resize', height: 600 });
    expect(frames(view)[0].style.height).toBe('604px');
  });

  it('brokers fetches through the same-origin proxy with the concurrency and per-run limits', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const resolvers: Array<() => void> = [];
    Object.assign(globalThis, {
      fetch: (input: string, init?: { body?: string }) => {
        calls.push({ url: String(input), body: String(init?.body ?? '') });
        return new Promise<Response>(resolve => {
          resolvers.push(() => resolve(new Response(JSON.stringify({ success: true, data: { status: 200, content_type: 'text/plain', body: 'ok' } }), { status: 200 })));
        });
      },
    });
    const { win } = started();
    postFromFrame(win, { channel: SANDBOX_CHANNEL, type: 'ready' });
    for (let id = 1; id <= 5; id++) postFromFrame(win, { channel: SANDBOX_CHANNEL, type: 'fetch', id, url: 'https://api.github.com/x' });
    expect(calls).toHaveLength(frameModule.MAX_CONCURRENT_FETCHES);
    expect(calls.every(c => c.url === '/api/v1/sandbox/fetch' && c.body === JSON.stringify({ url: 'https://api.github.com/x' }))).toBe(true);
    expect(win.posted).toContainEqual({ channel: SANDBOX_CHANNEL, type: 'fetch:result', id: 5, ok: false, error: 'request limit reached' });

    // Drain, then exhaust the per-run budget (real timers let the mocked responses settle; the start
    // queue's fake cool-down timer must elapse first or it would be dropped with the fake clock).
    advance(queue.FRAME_START_GAP_MS);
    jest.useRealTimers();
    const settle = async () => { for (const r of resolvers.splice(0)) r(); await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0)); };
    await React.act(settle);
    let id = 100;
    while (calls.length < frameModule.MAX_FETCHES_PER_RUN) {
      postFromFrame(win, { channel: SANDBOX_CHANNEL, type: 'fetch', id: id++, url: 'https://api.github.com/x' });
      await React.act(settle);
    }
    postFromFrame(win, { channel: SANDBOX_CHANNEL, type: 'fetch', id: 999, url: 'https://api.github.com/x' });
    expect(calls).toHaveLength(frameModule.MAX_FETCHES_PER_RUN);
    expect(win.posted).toContainEqual({ channel: SANDBOX_CHANNEL, type: 'fetch:result', id: 999, ok: false, error: 'request limit reached' });
    jest.useFakeTimers();
  });
});

describe('widget markup is escaped and never runs outside the sandbox', () => {
  const hostile = widget('x1', {
    title: '<img src=x onerror=alert(1)>',
    caption: '<script>alert(2)</script>',
    html: '<p>hi</p>',
    js: '</script><script>alert(3)</script>',
    css: '</style><script>alert(4)</script>',
  });

  it('server HTML contains neither a frame nor executable widget markup', () => {
    const html = renderToString(createElement(ServerBlockRenderer, { doc: { version: 1, blocks: [hostile] }, autoRunInteractives: true }));
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(3)');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('the auto-started frame escapes closing tags in the widget source', () => {
    const view = published([hostile]);
    enter(observerFor(view, hostile.title));
    advance(0);
    const srcdoc = frames(view)[0]?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).not.toContain('</script><script>alert(3)');
    expect(srcdoc).not.toContain('</style><script>alert(4)');
    expect(view.querySelector('.zif-head img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });
});

describe('embeds: host allowlist under auto-load', () => {
  it('a stored provider that does not own the host renders a link, never a frame', () => {
    const view = published([
      { id: 'e1', type: 'embed', url: 'https://example.com/watch?v=dQw4w9WgXcQ', provider: 'youtube' },
      { id: 'e2', type: 'embed', url: 'https://evil.example/someone/status/1234567890123', provider: 'x' },
    ]);
    React.act(() => { for (const io of FakeIntersectionObserver.instances) io.fire(true); });
    advance(1000);
    expect(view.querySelector('iframe')).toBeNull();
    const links = [...view.querySelectorAll('.zb-embed-fallback a')].map(a => a.getAttribute('href'));
    expect(links).toEqual(['https://example.com/watch?v=dQw4w9WgXcQ', 'https://evil.example/someone/status/1234567890123']);
  });
});

describe('paywall cuts withhold widgets before anything can run them', () => {
  const viewer = { isAdmin: false, entitlements: [] };
  const long = (id: string): Block => ({ id, type: 'paragraph', text: 'Đoạn văn mở đầu khá dài để giữ phần đầu của bài viết. '.repeat(4) });

  function cut(doc: ArticleDocument): ArticleDocument {
    const res = applyPaywall(doc, 'knowledges', viewer);
    expect(res.truncated).toBe(true);
    return res.doc;
  }

  it('top level: a withheld widget is neither rendered nor observed', () => {
    const doc = cut({ version: 1, blocks: [long('p1'), widget('free'), long('p2'), long('p3'), long('p4'), widget('paid', { js: 'SECRET_PAID_TOP()' })] });
    expect(JSON.stringify(doc)).not.toContain('SECRET_PAID_TOP');
    const html = renderToString(createElement(ServerBlockRenderer, { doc, autoRunInteractives: true }));
    expect(html).not.toContain('Demo paid');
    const view = mount(React.createElement(renderer.BlockRenderer, { doc, autoRunInteractives: true }));
    React.act(() => { for (const io of FakeIntersectionObserver.instances) io.fire(true); });
    advance(1000);
    expect(frames(view).map(f => f.getAttribute('title'))).toEqual(['Demo free']);
  });

  it('nested: widgets withheld inside sections, toggles and layouts are dropped from the delivered document', () => {
    const doc = cut({
      version: 1,
      blocks: [
        long('p1'),
        { id: 's1', type: 'section', width: 'prose', surface: 'none', blocks: [long('p2'), long('p3'), widget('sec', { js: 'SECRET_IN_SECTION()' })] },
        { id: 't1', type: 'toggle', summary: 'Mở', blocks: [widget('tog', { js: 'SECRET_IN_TOGGLE()' })] },
        { id: 'l1', type: 'layout', variant: 'columns', cols: { base: 1, md: 2, lg: 2 }, children: [{ blocks: [widget('lay', { js: 'SECRET_IN_LAYOUT()' })] }] },
      ],
    });
    const json = JSON.stringify(doc);
    for (const secret of ['SECRET_IN_SECTION', 'SECRET_IN_TOGGLE', 'SECRET_IN_LAYOUT']) expect(json).not.toContain(secret);
    const view = mount(React.createElement(renderer.BlockRenderer, { doc, autoRunInteractives: true }));
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
    expect(view.querySelector('.zif')).toBeNull();
  });
});
