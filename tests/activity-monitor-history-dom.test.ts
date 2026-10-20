import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { PRESENCE_CONTRACT_VERSION, type PresenceHistory, type PresenceSnapshot } from '../src/lib/presence/contract';

// Renders the real Activity Monitor panel (live feed + 24h history) in happy-dom with `fetch` stubbed.
// Installs happy-dom as process globals: never run with `bun test --concurrent`.

type ReactModule = typeof import('react');
type ClientModule = typeof import('react-dom/client');
type PanelModule = typeof import('../src/components/activity-monitor/ActivityMonitorPanel');
type FeedModule = typeof import('../src/lib/presence/presence-feed');

let React: ReactModule;
let client: ClientModule;
let panel: PanelModule;
let feed: FeedModule;
const originalFetch = globalThis.fetch;
const mounted: Array<{ unmount: () => void; container: HTMLElement }> = [];

const snapshot: PresenceSnapshot = {
  v: PRESENCE_CONTRACT_VERSION,
  at: '2026-10-20T04:00:00.000Z',
  active: 12,
  members: 4,
  categories: [{ id: 'reading', count: 12 }],
  owner: { status: 'online', onSite: true, since: '2026-10-20T03:00:00.000Z' },
};

const history: PresenceHistory = {
  v: PRESENCE_CONTRACT_VERSION,
  at: '2026-10-20T04:01:00.000Z',
  bucketMinutes: 5,
  buckets: [
    { t: '2026-10-20T03:55:00.000Z', peak: 7, categories: [{ id: 'reading', count: 4 }, { id: 'ai', count: 3 }] },
    { t: '2026-10-20T04:00:00.000Z', peak: 2, categories: [] },
  ],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Ticket endpoint fails, so the feed polls the snapshot from the fallback origin (no socket needed). */
function stubFetch(historyAnswer: () => Response): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/v1/history')) return historyAnswer();
    if (url.endsWith('/v1/snapshot')) return json(snapshot);
    return json({ success: false }, 503);
  }) as typeof fetch;
  return urls;
}

async function settle() {
  for (let i = 0; i < 8; i++) await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

function mount(active = true): { root: HTMLElement; rerender: (active: boolean) => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = client.createRoot(container);
  const render = (a: boolean) => React.act(() => root.render(React.createElement(panel.ActivityMonitorPanel, { locale: 'en', active: a })));
  render(active);
  mounted.push({ unmount: () => root.unmount(), container });
  return { root: container, rerender: render };
}

beforeAll(async () => {
  GlobalRegistrator.register();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  React = await import('react');
  client = await import('react-dom/client');
  panel = await import('../src/components/activity-monitor/ActivityMonitorPanel');
  feed = await import('../src/lib/presence/presence-feed');
});

afterEach(() => {
  for (const m of mounted.splice(0)) {
    React.act(() => m.unmount());
    m.container.remove();
  }
  setVisibility('visible');
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe('Activity Monitor 24h history', () => {
  test('renders an accessible chart from the feed origin, with a keyboard tooltip and breakdown', async () => {
    const urls = stubFetch(() => json(history));
    const { root } = mount();
    await settle();
    // Same Worker origin as the live feed's snapshot (the shared feed may have learned it from an earlier ticket).
    const snapshotOrigin = urls.find((u) => u.endsWith('/v1/snapshot'))?.slice(0, -'/v1/snapshot'.length);
    expect(snapshotOrigin).toBe(feed.getFeedOrigin());
    expect(urls.filter((u) => u.endsWith('/v1/history'))).toEqual([`${feed.getFeedOrigin()}/v1/history`]);
    const plot = root.querySelector<HTMLElement>('.am-hist-plot');
    expect(plot).not.toBeNull();
    expect(plot?.getAttribute('tabindex')).toBe('0');
    expect(plot?.getAttribute('aria-label')).toContain('Highest: 7');
    expect(root.querySelector('.am-hist svg path.am-hist-area')).not.toBeNull();

    React.act(() => plot?.focus());
    const tip = () => root.querySelector('.am-hist-tip')?.textContent ?? '';
    expect(tip()).toContain('Peak: 2'); // focus starts on the latest slot
    React.act(() => { plot?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(tip()).toContain('Peak: 7');
    const cats = Array.from(root.querySelectorAll('.am-hist-tip li')).map((li) => li.getAttribute('data-category'));
    expect(cats).toEqual(['reading', 'ai']);
    React.act(() => { plot?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(tip()).toContain('No data for this slot');
    expect(root.querySelectorAll('.am-hist-tip li')).toHaveLength(0);
  });

  test('a failing history shows "unavailable" while the live numbers keep working', async () => {
    stubFetch(() => json({ success: false }, 503));
    const { root } = mount();
    await settle();
    expect(root.querySelector('[data-history-state="error"]')?.textContent).toContain('History unavailable');
    expect(root.querySelector('[data-kpi="active"] .am-kpi-val')?.textContent).toBe('12');
    expect(Array.from(root.querySelectorAll('.am-cats li')).map((li) => li.getAttribute('data-category'))).toEqual(['reading']);
  });

  test('an all-zero day is the empty state, not a flat chart', async () => {
    stubFetch(() => json({ ...history, buckets: [{ t: '2026-10-20T04:00:00.000Z', peak: 0, categories: [] }] }));
    const { root } = mount();
    await settle();
    expect(root.querySelector('[data-history-state="empty"]')?.textContent).toBe('No visitors in the last 24 hours.');
    expect(root.querySelector('.am-hist-plot')).toBeNull();
  });

  test('shows loading until the first answer', async () => {
    let release: (r: Response) => void = () => undefined;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/history')) return new Promise<Response>((r) => { release = r; });
      return url.endsWith('/v1/snapshot') ? json(snapshot) : json({ success: false }, 503);
    }) as typeof fetch;
    const { root } = mount();
    await settle();
    expect(root.querySelector('[data-history-state="loading"]')).not.toBeNull();
    release(json(history));
    await settle();
    expect(root.querySelector('.am-hist-plot')).not.toBeNull();
  });

  test('never fetches history while the window is closed or the page is hidden', async () => {
    const urls = stubFetch(() => json(history));
    const closed = mount(false);
    await settle();
    expect(urls).toEqual([]);

    setVisibility('hidden');
    closed.rerender(true);
    await settle();
    expect(urls.filter((u) => u.endsWith('/v1/history'))).toEqual([]);

    setVisibility('visible');
    await settle();
    expect(urls.filter((u) => u.endsWith('/v1/history'))).toHaveLength(1);

    closed.rerender(false);
    await settle();
    const before = urls.length;
    setVisibility('hidden');
    setVisibility('visible');
    await settle();
    expect(urls.length).toBe(before);
  });
});
