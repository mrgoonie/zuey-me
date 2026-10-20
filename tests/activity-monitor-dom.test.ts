import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { PRESENCE_CONTRACT_VERSION, type PresenceSnapshot } from '../src/lib/presence/contract';

// Renders the real Activity Monitor panel in happy-dom against the shared presence feed, with `fetch`
// stubbed. Installs happy-dom as process globals: never run with `bun test --concurrent`.

type ReactModule = typeof import('react');
type ClientModule = typeof import('react-dom/client');
type PanelModule = typeof import('../src/components/activity-monitor/ActivityMonitorPanel');

let React: ReactModule;
let client: ClientModule;
let panel: PanelModule;
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const grant = { success: true, data: { ticket: 'tkt.sig', url: 'wss://presence.test/v1/connect', expiresAt: '2026-10-20T04:02:00.000Z' } };

/** Inert WebSocket: records what the feed opens, never touches the network. */
class FakeWebSocket extends EventTarget {
  static opened: Array<{ url: string; protocols: string[] }> = [];
  readyState = 0;
  constructor(url: string, protocols: string[] = []) {
    super();
    FakeWebSocket.opened.push({ url, protocols });
  }
  send(): void {}
  close(): void {}
}
const mounted: Array<{ unmount: () => void; container: HTMLElement }> = [];

const snapshot: PresenceSnapshot = {
  v: PRESENCE_CONTRACT_VERSION,
  at: '2026-10-20T04:00:00.000Z',
  active: 12,
  members: null,
  categories: [{ id: 'reading', count: 8 }, { id: 'ai', count: 4 }],
  owner: { status: 'online', onSite: true, text: 'Shipping <b>things</b>', since: '2026-10-20T03:00:00.000Z' },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(handler: (url: string) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL) => handler(String(input))) as typeof fetch;
}

function stubWebSocket() {
  FakeWebSocket.opened = [];
  Object.assign(globalThis, { WebSocket: FakeWebSocket });
}

async function settle() {
  for (let i = 0; i < 8; i++) await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function mount(active = true): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = client.createRoot(container);
  React.act(() => root.render(React.createElement(panel.ActivityMonitorPanel, { locale: 'vi', active })));
  mounted.push({ unmount: () => root.unmount(), container });
  return container;
}

beforeAll(async () => {
  GlobalRegistrator.register();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  React = await import('react');
  client = await import('react-dom/client');
  panel = await import('../src/components/activity-monitor/ActivityMonitorPanel');
});

afterEach(() => {
  for (const m of mounted.splice(0)) {
    React.act(() => m.unmount());
    m.container.remove();
  }
  globalThis.fetch = originalFetch;
  Object.assign(globalThis, { WebSocket: originalWebSocket });
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe('Activity Monitor panel', () => {
  test('without data it shows dashes and an explanation, never a zero', async () => {
    stubFetch(() => json({ success: false }, 503));
    const root = mount();
    await settle();
    const text = root.textContent ?? '';
    expect(root.querySelector('[data-kpi="active"] .am-kpi-val')?.textContent).toBe('—');
    expect(root.querySelector('[data-kpi="members"] .am-kpi-val')?.textContent).toBe('—');
    expect(root.querySelector('[data-kpi="owner"] .am-kpi-val')?.textContent).toBe('—');
    expect(text).toContain('Chưa khả dụng');
    expect(text).toContain('Luồng trực tiếp hiện chưa khả dụng');
    expect(root.querySelector('.am-cats .am-empty')?.textContent).toBe('Chưa có dữ liệu');
    expect(root.querySelector('.am-bar')).toBeNull();
    expect(root.querySelector('a[href="/privacy"]')).not.toBeNull();
  });

  test('members below the privacy floor read "< 3", not a fake number', async () => {
    stubWebSocket();
    stubFetch((url) => (url.endsWith('/v1/snapshot') ? json(snapshot) : json(grant)));
    const root = mount();
    await settle();
    // The snapshot origin comes from the ticket answer; the ticket rides as a subprotocol, never in the URL.
    expect(FakeWebSocket.opened).toEqual([{ url: 'wss://presence.test/v1/connect', protocols: ['zuey-presence.v1', 'tkt.sig'] }]);
    expect(root.querySelector('[data-kpi="active"] .am-kpi-val')?.textContent).toBe('12');
    expect(root.querySelector('[data-kpi="members"] .am-kpi-val')?.textContent).toBe('< 3');
    expect(root.querySelector('[data-kpi="members"]')?.textContent).toContain('ít hơn 3');
    expect(root.querySelector('[data-kpi="owner"]')?.textContent).toContain('Trực tuyến');
    expect(root.querySelector('[data-kpi="owner"]')?.textContent).toContain('Đang ở zuey.me');
    // Owner text is rendered as text, never as markup.
    expect(root.querySelector('.am-owner-text')?.textContent).toBe('Shipping <b>things</b>');
    expect(root.querySelector('.am-owner-text b')).toBeNull();
    const rows = Array.from(root.querySelectorAll('.am-cats li')).map((li) => li.getAttribute('data-category'));
    expect(rows).toEqual(['reading', 'ai']);
    expect(root.querySelector('h2')).not.toBeNull();
  });

  test('a closed window holds no connection', async () => {
    let calls = 0;
    stubFetch(() => { calls++; return json(snapshot); });
    const root = mount(false);
    await settle();
    expect(calls).toBe(0);
    expect(root.querySelector('[data-kpi="active"] .am-kpi-val')?.textContent).toBe('—');
  });
});
