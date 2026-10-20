import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { PRESENCE_CONTRACT_VERSION, type OwnerStatusState, type PresenceDiagnostics } from '../src/lib/presence/contract';

// Renders the Studio Presence tab in happy-dom with `fetch` stubbed. Installs happy-dom as process
// globals: never run with `bun test --concurrent`.

type ReactModule = typeof import('react');
type ClientModule = typeof import('react-dom/client');
type TabModule = typeof import('../src/components/studio/PresenceStudioTab');

let React: ReactModule;
let client: ClientModule;
let tab: TabModule;
const originalFetch = globalThis.fetch;
const mounted: Array<{ unmount: () => void; container: HTMLElement }> = [];

const DIAG: PresenceDiagnostics = {
  v: PRESENCE_CONTRACT_VERSION,
  at: '2026-10-20T04:00:00.000Z',
  sockets: { total: 9, activeSessions: 5, idle: 1, watchOnly: 2, subscribers: 2, owner: 1 },
  limits: { maxTotal: 5000, maxPerIp: 20, maxPerKey: 8 },
  counters: { startedAt: '2026-10-20T01:00:00.000Z', connectsAccepted: 40, connectsRejected: 2, messagesDropped: 3, abuseCloses: 0, broadcasts: 120 },
  alarm: { nextAt: null, lastRunAt: '2026-10-20T03:59:00.000Z', lastRunMs: 4 },
  history: { buckets: 288, oldest: '2026-10-19T04:05:00.000Z', storageBytes: 40_960 },
};
const OWNER: OwnerStatusState = {
  mode: 'auto', text: null, updatedAt: '2026-10-20T03:00:00.000Z', connected: true,
  public: { status: 'online', onSite: true, since: '2026-10-20T03:00:00.000Z' },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(diagnostics: () => Response): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === '/api/v1/presence/diagnostics') return diagnostics();
    if (url === '/api/v1/presence/owner') return json({ success: true, data: OWNER });
    return json({ success: false }, 404);
  }) as typeof fetch;
  return urls;
}

async function settle() {
  for (let i = 0; i < 6; i++) await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function mount(owner: boolean): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = client.createRoot(container);
  React.act(() => root.render(React.createElement(tab.PresenceStudioTab, { owner })));
  mounted.push({ unmount: () => root.unmount(), container });
  return container;
}

beforeAll(async () => {
  GlobalRegistrator.register();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  React = await import('react');
  client = await import('react-dom/client');
  tab = await import('../src/components/studio/PresenceStudioTab');
});

afterEach(() => {
  for (const m of mounted.splice(0)) {
    React.act(() => m.unmount());
    m.container.remove();
  }
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe('Studio Presence tab', () => {
  test('an admin who is not the owner sees diagnostics only and never calls the owner endpoint', async () => {
    const urls = stubFetch(() => json({ success: true, data: DIAG }));
    const root = mount(false);
    await settle();
    expect(root.querySelector('[data-presence-preview]')).toBeNull();
    expect(root.querySelector('input[name="presence-mode"]')).toBeNull();
    expect(urls).toEqual(['/api/v1/presence/diagnostics']);
    const panel = root.querySelector('[data-presence-diagnostics]');
    expect(panel?.textContent).toContain('Presence diagnostics');
    const sockets = root.querySelector('[data-diagnostics-group="Sockets"]')?.textContent ?? '';
    expect(sockets).toContain('Active sessions (counted)');
    expect(sockets).toContain('5');
    expect(root.querySelector('[data-diagnostics-group="Limits"]')?.textContent).toContain('5,000');
    expect(root.querySelector('[data-diagnostics-group="Alarm & history"]')?.textContent).toContain('40.0 KB');
  });

  test('the owner sees the owner controls and the diagnostics', async () => {
    const urls = stubFetch(() => json({ success: true, data: DIAG }));
    const root = mount(true);
    await settle();
    expect(root.querySelectorAll('input[name="presence-mode"]').length).toBe(5);
    expect(root.querySelector('[data-presence-diagnostics]')).not.toBeNull();
    expect(new Set(urls)).toEqual(new Set(['/api/v1/presence/owner', '/api/v1/presence/diagnostics']));
  });

  test('a Worker outage or a malformed answer shows an error, and Refresh retries', async () => {
    let answer = () => json({ success: false, error: { code: 'presence_unavailable', message: 'Realtime presence is unavailable right now' } }, 503);
    const urls = stubFetch(() => answer());
    const root = mount(false);
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('presence_unavailable');

    answer = () => json({ success: true, data: { ...DIAG, sockets: { total: 'lots' } } });
    const refresh = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Refresh');
    React.act(() => refresh?.click());
    await settle();
    expect(urls).toHaveLength(2);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Unexpected response');
    expect(root.querySelector('[data-diagnostics-group]')).toBeNull();

    answer = () => json({ success: true, data: DIAG });
    React.act(() => refresh?.click());
    await settle();
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.querySelector('[data-diagnostics-group="Sockets"]')).not.toBeNull();
  });
});
