import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Renders in happy-dom. This file installs process globals: never run it with `bun test --concurrent`.
GlobalRegistrator.register();
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ChannelLinks } = await import('../src/components/members/ChannelLinks');

const originalFetch = globalThis.fetch;
let calls: string[] = [];
let answer: () => Response;

afterAll(async () => {
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  calls = [];
  answer = () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return answer();
  };
  globalThis.fetch = Object.assign(stub, { preconnect: () => undefined });
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
});

async function mount(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => { createRoot(host).render(createElement(ChannelLinks)); });
  return host;
}

async function clickShow(host: HTMLElement): Promise<void> {
  const button = host.querySelector('button');
  if (!button) throw new Error('no button');
  await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('ChannelLinks', () => {
  it('asks Dewee for the linked accounts only when the member clicks, never on render', async () => {
    const host = await mount();
    expect(calls).toEqual([]);
    expect(host.textContent).toContain('Xem tài khoản chat đã liên kết');
    await clickShow(host);
    expect(calls).toEqual(['/api/v1/me/channels']);
    expect(host.textContent).toContain('Chưa có tài khoản chat nào');
  });

  it('shows the sender hint exactly as Dewee masks it, without a second ellipsis', async () => {
    answer = () => new Response(JSON.stringify({
      success: true, data: [{ id: '0199a572-a064-7118-8f4a-0b28d615d0e2', channel_type: 'telegram', sender_hint: '…7001', linked_at: null }],
    }), { status: 200 });
    const host = await mount();
    await clickShow(host);
    expect(host.textContent).toContain('Telegram · ID …7001');
    expect(host.textContent).not.toContain('……');
  });

  it('says linking is off when Dewee Connect is not configured', async () => {
    answer = () => new Response(JSON.stringify({ success: false, error: { code: 'dewee_identity_unconfigured', message: 'x' } }), { status: 503 });
    const host = await mount();
    await clickShow(host);
    expect(host.textContent).toContain('chưa được bật');
  });
});
