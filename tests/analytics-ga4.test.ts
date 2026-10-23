import { describe, expect, it } from 'bun:test';
import { createTestD1 } from './helpers/d1';
import { createAnalyticsClient } from '../src/lib/analytics/client';
import { ecommerceTransactionId } from '../src/lib/analytics/commerce-events';
import { OPT_OUT_STORAGE_KEY, type ConsentEnvironment } from '../src/lib/analytics/consent';
import {
  GA4_CLIENT_EVENTS, GA4_MP_ENDPOINT, GA4_PRIVATE_TITLE, GA4_SCRIPT_URL, GA4_SERVER_EVENTS, MP_MAX_BACKDATE_MS,
  beginCheckoutParams, createGa4Client, createGa4ServerDestination, ga4ClientId, measurementProtocolPayload,
  resolveGa4MeasurementId, resolveGa4ServerConfig, type Ga4BrowserHost,
} from '../src/lib/analytics/destinations/ga4';
import type { ClientDestination, ServerAnalyticsEvent, ServerDestination } from '../src/lib/analytics/destinations/types';
import { ANALYTICS_EVENTS } from '../src/lib/analytics/events';
import { drainAnalyticsOutbox, enqueueServerEvent } from '../src/lib/analytics/outbox';
import { sendServerEvent, serverDestinations } from '../src/lib/analytics/server';

const GA4_ID = 'G-SS6M7YDZX0';
const SECRET = 'mp-test-secret-value';
const MEMBER = 'usr_01JGA4TEST';

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const map = new Map(Object.entries(initial));
  return {
    getItem: k => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: k => { map.delete(k); },
  };
}

const GRANTED: ConsentEnvironment = { navigator: {}, storage: memoryStorage() };
const BLOCKING: Array<[string, ConsentEnvironment]> = [
  ['opted out', { navigator: {}, storage: memoryStorage({ [OPT_OUT_STORAGE_KEY]: '1' }) }],
  ['Do Not Track', { navigator: { doNotTrack: '1' }, storage: memoryStorage() }],
  ['Global Privacy Control', { navigator: { globalPrivacyControl: true }, storage: memoryStorage() }],
];

function fakeHost(href: string, options: { referrer?: string; title?: string; cookie?: string } = {}) {
  const url = new URL(href);
  const appended: Array<{ async: boolean; src: string }> = [];
  const cookieWrites: string[] = [];
  const cookie = options.cookie ?? '';
  const win = { location: { href, pathname: url.pathname, hostname: url.hostname } };
  const host: Ga4BrowserHost = {
    win,
    doc: {
      referrer: options.referrer ?? '',
      title: options.title ?? 'Page',
      get cookie() { return cookie; },
      set cookie(value: string) { cookieWrites.push(value); },
      createElement: () => ({ async: false, src: '' }),
      head: {
        appendChild(node: unknown) {
          if (typeof node === 'object' && node !== null && 'src' in node && typeof node.src === 'string') appended.push({ async: true, src: node.src });
          return node;
        },
      },
    },
  };
  return { host, win, appended, cookieWrites };
}

/** gtag pushes `arguments` objects; read each data layer entry back as a plain array. */
function commands(win: object): unknown[][] {
  const layer: unknown = Reflect.get(win, 'dataLayer');
  if (!Array.isArray(layer)) return [];
  return layer.map((entry: unknown) => (typeof entry === 'object' && entry !== null && 'length' in entry ? Array.prototype.slice.call(entry) : []));
}

function serverEvent(event: string, properties: ServerAnalyticsEvent['properties'], extra: Partial<ServerAnalyticsEvent> = {}): ServerAnalyticsEvent {
  return {
    uuid: '0b3f2a1e-1111-4222-8333-444455556666', event, distinctId: MEMBER, properties,
    occurredAt: new Date(Date.now() - 60_000).toISOString(), ...extra,
  };
}

describe('GA4 configuration', () => {
  it('accepts only a well-formed measurement id', () => {
    expect(resolveGa4MeasurementId(GA4_ID)).toBe(GA4_ID);
    expect(resolveGa4MeasurementId(` ${GA4_ID.toLowerCase()} `)).toBe(GA4_ID);
    for (const bad of [undefined, '', 'UA-123-1', 'G-', 'G-<script>']) expect(resolveGa4MeasurementId(bad)).toBeNull();
  });

  it('keeps the server path off until the API secret exists', () => {
    expect(resolveGa4ServerConfig({ PUBLIC_GA4_MEASUREMENT_ID: GA4_ID })).toBeNull();
    expect(resolveGa4ServerConfig({ PUBLIC_GA4_MEASUREMENT_ID: GA4_ID, GA4_API_SECRET: '  ' })).toBeNull();
    expect(resolveGa4ServerConfig({ GA4_API_SECRET: SECRET })).toBeNull();
    expect(resolveGa4ServerConfig({ PUBLIC_GA4_MEASUREMENT_ID: GA4_ID, GA4_API_SECRET: SECRET })).toEqual({ measurementId: GA4_ID, apiSecret: SECRET });
  });
});

describe('gtag consent gating', () => {
  for (const [label, consent] of BLOCKING) {
    it(`loads no script and queues nothing when ${label}`, () => {
      const ga4 = createGa4Client();
      const { host, win, appended } = fakeHost('https://zuey.me/pricing');
      expect(ga4.start(host, GA4_ID, consent)).toBe(false);
      expect(appended).toEqual([]);
      expect(Reflect.get(win, 'dataLayer')).toBeUndefined();
      expect(Reflect.get(win, 'gtag')).toBeUndefined();
      expect(ga4.destination.active?.()).toBe(false);
      // Later calls stay silent too.
      ga4.destination.capture('begin_checkout', { order_type: 'membership', provider: 'sepay', discount_entered: false });
      expect(Reflect.get(win, 'dataLayer')).toBeUndefined();
    });
  }

  it('sets Consent Mode v2 defaults to denied, grants analytics storage only, then loads gtag.js', () => {
    const ga4 = createGa4Client();
    const { host, win, appended } = fakeHost('https://zuey.me/pricing', { title: 'Pricing' });
    expect(ga4.start(host, GA4_ID, GRANTED)).toBe(true);
    const sent = commands(win);
    expect(sent[0]).toEqual(['consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied' }]);
    expect(sent[1]).toEqual(['consent', 'update', { analytics_storage: 'granted' }]);
    expect(sent[2]?.[0]).toBe('js');
    expect(sent[4]).toEqual(['config', GA4_ID, { allow_google_signals: false, allow_ad_personalization_signals: false }]);
    expect(appended).toEqual([{ async: true, src: `${GA4_SCRIPT_URL}?id=${GA4_ID}` }]);
    expect(ga4.start(host, GA4_ID, GRANTED)).toBe(true);
    expect(appended).toHaveLength(1);
  });
});

describe('gtag page fields', () => {
  it('scrubs page_location and page_referrer with the shared PII scrubber', () => {
    const ga4 = createGa4Client();
    const { host, win } = fakeHost('https://zuey.me/pricing?plan=ai&utm_source=x&email=duy%40example.com&token=abc123', {
      referrer: 'https://news.example/?q=duy%40example.com&ref=a', title: 'Pricing',
    });
    ga4.start(host, GA4_ID, GRANTED);
    const set = commands(win).find(c => c[0] === 'set');
    expect(set?.[1]).toEqual({
      page_location: 'https://zuey.me/pricing?plan=ai&utm_source=x',
      page_referrer: expect.stringMatching(/^https:\/\/news\.example\/\?q=.*redacted.*&ref=a$/),
      page_title: 'Pricing',
    });
    expect(JSON.stringify(commands(win))).not.toContain('example.com');
  });

  it('drops the query, templates the order code and hides the title on order pages', () => {
    const ga4 = createGa4Client();
    const { host, win } = fakeHost('https://zuey.me/billing/ZM12345?session=s1&x=1', { title: 'Order ZM12345' });
    ga4.start(host, GA4_ID, GRANTED);
    const set = commands(win).find(c => c[0] === 'set');
    expect(set?.[1]).toEqual({ page_location: 'https://zuey.me/billing/:code', page_title: GA4_PRIVATE_TITLE });
  });
});

describe('gtag destination', () => {
  it('sends begin_checkout with GA4 ecommerce fields and nothing for other events', () => {
    const ga4 = createGa4Client();
    const { host, win } = fakeHost('https://zuey.me/pricing');
    ga4.start(host, GA4_ID, GRANTED);
    const before = commands(win).length;
    ga4.destination.capture('plan_selected', { plan: 'ai', provider: 'sepay', months: 3 });
    ga4.destination.capture('purchase', { amount: 1 });
    ga4.destination.capture('begin_checkout', {
      order_type: 'membership', provider: 'sepay', discount_entered: false, plan: 'ai', months: 3, value: 597000, currency: 'VND', utm_source: 'x',
    });
    const after = commands(win).slice(before);
    expect(after).toEqual([['event', 'begin_checkout', {
      value: 597000, currency: 'VND',
      items: [{ item_id: 'ai', item_name: 'ai', item_category: 'membership', quantity: 1, item_variant: '3m', price: 597000 }],
    }]]);
  });

  it('omits value without a currency', () => {
    expect(beginCheckoutParams({ order_type: 'course', provider: 'dodo', discount_entered: true, course: 'c1', value: 49 })).toEqual({
      items: [{ item_id: 'c1', item_name: 'c1', item_category: 'course', quantity: 1 }],
    });
  });

  it('sets and clears user_id, and opt-out disables gtag and deletes the _ga cookies', () => {
    const ga4 = createGa4Client();
    const { host, win, cookieWrites } = fakeHost('https://www.zuey.me/', { cookie: '_ga=GA1.1.1.2; other=1; _ga_SS6M7YDZX0=GS1.1' });
    ga4.start(host, GA4_ID, GRANTED);
    ga4.destination.identify(MEMBER);
    expect(ga4.destination.distinctId()).toBe(MEMBER);
    ga4.destination.reset();
    expect(ga4.destination.distinctId()).toBeNull();
    ga4.destination.optOut();
    const tail = commands(win).slice(-3);
    expect(tail).toEqual([['set', { user_id: MEMBER }], ['set', { user_id: null }], ['consent', 'update', { analytics_storage: 'denied' }]]);
    expect(Reflect.get(win, `ga-disable-${GA4_ID}`)).toBe(true);
    expect(cookieWrites).toContain('_ga=; Max-Age=0; path=/; domain=.zuey.me');
    expect(cookieWrites).toContain('_ga_SS6M7YDZX0=; Max-Age=0; path=/; domain=.zuey.me');
    expect(cookieWrites.some(c => c.startsWith('other='))).toBe(false);
    ga4.destination.optIn();
    expect(Reflect.get(win, `ga-disable-${GA4_ID}`)).toBe(false);
  });

  it('is skipped by the analytics client while it is not loaded', () => {
    const calls: string[] = [];
    const posthog: ClientDestination = {
      name: 'posthog', capture: e => calls.push(`posthog:${e}`), identify: id => calls.push(`posthog:identify:${id}`),
      reset: () => calls.push('posthog:reset'), optOut: () => calls.push('posthog:optOut'), optIn: () => calls.push('posthog:optIn'),
      distinctId: () => MEMBER,
    };
    const ga4 = createGa4Client();
    const client = createAnalyticsClient({
      destinations: [posthog, ga4.destination], consent: () => GRANTED, local: () => memoryStorage({ zuey_analytics_member: MEMBER }),
      session: () => memoryStorage(), fetchIdentity: async () => undefined, now: () => 0, debug: () => undefined,
    });
    client.activate(false);
    // PostHog already attributes to the member and GA4 is not loaded: identify is a no-op.
    client.identify(MEMBER);
    client.track('begin_checkout', { order_type: 'membership', provider: 'sepay', discount_entered: false });
    expect(calls).toEqual(['posthog:begin_checkout']);
  });
});

describe('Measurement Protocol payload', () => {
  it('maps a purchase to the GA4 ecommerce fields with ads signals off', async () => {
    const tx = await ecommerceTransactionId('sepay', 'billing_order:ord_1');
    const body = await measurementProtocolPayload(serverEvent('purchase', {
      provider: 'sepay', order_type: 'membership', amount: 597000, currency: 'VND', renewal: false, plan: 'ai', months: 3, transaction_id: tx,
      event_version: 1, schema_version: 1,
    }), Date.now());
    expect(body).toEqual({
      client_id: await ga4ClientId(MEMBER),
      user_id: MEMBER,
      timestamp_micros: expect.any(Number),
      non_personalized_ads: true,
      consent: { ad_user_data: 'DENIED', ad_personalization: 'DENIED' },
      events: [{
        name: 'purchase',
        params: {
          transaction_id: tx, value: 597000, currency: 'VND',
          items: [{ item_id: 'ai', item_name: 'ai', item_category: 'membership', quantity: 1, item_variant: '3m', price: 597000 }],
        },
      }],
    });
    expect(tx).toMatch(/^tx_[0-9a-f]{24}$/);
    expect(JSON.stringify(body)).not.toContain('ord_1');
  });

  it('maps a refund, falls back to the event uuid without a transaction, and gives guests no user_id', async () => {
    const body = await measurementProtocolPayload(serverEvent('refund', {
      provider: 'paypal', order_type: 'booking', reason: 'refund', amount: 19.99, currency: 'USD', partial: false,
    }, { distinctId: 'guest_0123456789abcdef01234567' }), Date.now());
    expect(body?.user_id).toBeUndefined();
    expect(body?.client_id).toMatch(/^\d+\.\d+$/);
    expect(body?.events).toEqual([{
      name: 'refund',
      params: {
        transaction_id: '0b3f2a1e-1111-4222-8333-444455556666', value: 19.99, currency: 'USD',
        items: [{ item_id: 'booking', item_name: 'booking', item_category: 'booking', quantity: 1, price: 19.99 }],
      },
    }]);
  });

  it('derives a stable client_id and drops timestamps GA4 would reject', async () => {
    expect(await ga4ClientId(MEMBER)).toBe(await ga4ClientId(MEMBER));
    expect(await ga4ClientId(MEMBER)).not.toBe(await ga4ClientId('usr_other'));
    const now = Date.now();
    const old = await measurementProtocolPayload(serverEvent('purchase', { amount: 1, currency: 'USD' }, {
      occurredAt: new Date(now - MP_MAX_BACKDATE_MS - 1000).toISOString(),
    }), now);
    expect(old?.timestamp_micros).toBeUndefined();
  });

  it('builds nothing for events GA4 does not take', async () => {
    expect(await measurementProtocolPayload(serverEvent('sign_up', { method: 'google' }), Date.now())).toBeNull();
    expect(await measurementProtocolPayload(serverEvent('purchase', { provider: 'dodo' }), Date.now())).toBeNull();
  });

  it('posts to the Measurement Protocol endpoint and never reports the secret-bearing URL', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const dest = createGa4ServerDestination({ measurementId: GA4_ID, apiSecret: SECRET }, async (url, init) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 204 });
    });
    expect(dest.accepts?.('purchase')).toBe(true);
    expect(dest.accepts?.('sign_up')).toBe(false);
    const ok = await dest.send(serverEvent('purchase', { amount: 9, currency: 'USD', order_type: 'membership' }), new AbortController().signal);
    expect(ok).toEqual({ destination: 'ga4', ok: true, status: 204 });
    expect(requests[0]?.url).toBe(`${GA4_MP_ENDPOINT}?measurement_id=${GA4_ID}&api_secret=${SECRET}`);
    const failing = createGa4ServerDestination({ measurementId: GA4_ID, apiSecret: SECRET }, async url => { throw new Error(`failed ${url}`); });
    const failed = await failing.send(serverEvent('purchase', { amount: 9, currency: 'USD' }), new AbortController().signal);
    expect(failed).toEqual({ destination: 'ga4', ok: false, reason: 'network' });
    expect(JSON.stringify(failed)).not.toContain(SECRET);
  });
});

describe('server destinations', () => {
  const prod = { production: true, requestHost: 'zuey.me' } as const;

  it('adds GA4 only when the measurement id and the API secret are both set', () => {
    expect(serverDestinations({ PUBLIC_GA4_MEASUREMENT_ID: GA4_ID }, prod).map(d => d.name)).toEqual(['posthog']);
    expect(serverDestinations({ PUBLIC_GA4_MEASUREMENT_ID: GA4_ID, GA4_API_SECRET: SECRET }, prod).map(d => d.name)).toEqual(['posthog', 'ga4']);
    expect(serverDestinations({ PUBLIC_GA4_MEASUREMENT_ID: GA4_ID, GA4_API_SECRET: SECRET }, { production: true, requestHost: 'x.pages.dev' })).toEqual([]);
    expect(serverDestinations({ PUBLIC_GA4_MEASUREMENT_ID: GA4_ID, GA4_API_SECRET: SECRET }, { production: false, requestHost: 'zuey.me' })).toEqual([]);
  });

  it('sends GA4 only purchase and refund', async () => {
    const seen: string[] = [];
    const record = (name: string, accepts?: (e: string) => boolean): ServerDestination => ({
      name, accepts,
      send: async event => { seen.push(`${name}:${event.event}`); return { destination: name, ok: true, status: 200 }; },
    });
    const destinations = [record('posthog'), record('ga4', e => GA4_SERVER_EVENTS.includes(e))];
    await sendServerEvent({ event: 'sign_up', distinctId: MEMBER, properties: { method: 'google' } }, destinations);
    await sendServerEvent({
      event: 'purchase', distinctId: MEMBER,
      properties: { provider: 'dodo', order_type: 'membership', amount: 9, currency: 'USD', renewal: false },
    }, destinations);
    expect(seen).toEqual(['posthog:sign_up', 'posthog:purchase', 'ga4:purchase']);
    // Only GA4 configured: an event it does not take is done, not failed.
    expect(await sendServerEvent({ event: 'login', distinctId: MEMBER, properties: { method: 'google' } }, [destinations[1]!]))
      .toMatchObject({ delivered: true, results: [] });
  });
});

describe('outbox drain with GA4', () => {
  async function queueSamples(d1: ReturnType<typeof createTestD1>): Promise<void> {
    await enqueueServerEvent(d1, {
      event: 'purchase', distinctId: MEMBER, dedupeKey: 'purchase:dodo:pay_1',
      properties: { provider: 'dodo', order_type: 'membership', amount: 9, currency: 'USD', renewal: false },
    });
    await enqueueServerEvent(d1, { event: 'sign_up', distinctId: MEMBER, dedupeKey: `sign_up:${MEMBER}`, properties: { method: 'google' } });
  }

  it('without the API secret delivers to PostHog only, with no failures or dead letters', async () => {
    const d1 = createTestD1();
    await queueSamples(d1);
    const urls: string[] = [];
    const destinations = serverDestinations({ PUBLIC_GA4_MEASUREMENT_ID: GA4_ID }, {
      production: true, requestHost: 'zuey.me', fetchImpl: async url => { urls.push(url); return new Response('{}', { status: 200 }); },
    });
    expect(await drainAnalyticsOutbox(d1, { destinations })).toMatchObject({ sent: 2, retried: 0, dead: 0, pending: 0 });
    expect(urls.some(u => u.startsWith(GA4_MP_ENDPOINT))).toBe(false);
  });

  it('with the API secret sends one Measurement Protocol request per purchase, none for other events', async () => {
    const d1 = createTestD1();
    await queueSamples(d1);
    const urls: string[] = [];
    const destinations = serverDestinations({ PUBLIC_GA4_MEASUREMENT_ID: GA4_ID, GA4_API_SECRET: SECRET }, {
      production: true, requestHost: 'zuey.me', fetchImpl: async url => { urls.push(url); return new Response(null, { status: 204 }); },
    });
    expect(await drainAnalyticsOutbox(d1, { destinations })).toMatchObject({ sent: 2, dead: 0 });
    expect(urls.filter(u => u.startsWith(GA4_MP_ENDPOINT))).toHaveLength(1);
    expect(urls.filter(u => !u.startsWith(GA4_MP_ENDPOINT))).toHaveLength(2);
  });

  it('halves the per-run row limit when two destinations share the subrequest budget', async () => {
    const d1 = createTestD1();
    for (let i = 0; i < 25; i++) {
      await enqueueServerEvent(d1, { event: 'login', distinctId: MEMBER, dedupeKey: `login:s${i}`, properties: { method: 'google' } });
    }
    const ok = (name: string): ServerDestination => ({ name, send: async () => ({ destination: name, ok: true, status: 200 }) });
    expect((await drainAnalyticsOutbox(d1, { destinations: [ok('a'), ok('b')], limit: 40 })).claimed).toBe(20);
  });
});

describe('one emitter per GA4 event', () => {
  it('sends begin_checkout from the browser and purchase/refund only from the server', () => {
    const sourceOf = (e: string): string | undefined => Object.entries(ANALYTICS_EVENTS).find(([name]) => name === e)?.[1].source;
    expect(GA4_CLIENT_EVENTS.filter(e => GA4_SERVER_EVENTS.includes(e))).toEqual([]);
    for (const e of GA4_CLIENT_EVENTS) expect(sourceOf(e)).toBe('client');
    for (const e of GA4_SERVER_EVENTS) expect(sourceOf(e)).toBe('server');
  });
});
