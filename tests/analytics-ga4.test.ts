import { describe, expect, it } from 'bun:test';
import { createTestD1 } from './helpers/d1';
import { createAnalyticsClient } from '../src/lib/analytics/client';
import { ecommerceTransactionId, queuePurchase, queueRefund } from '../src/lib/analytics/commerce-events';
import { OPT_OUT_STORAGE_KEY, type ConsentEnvironment } from '../src/lib/analytics/consent';
import {
  GA4_CLIENT_EVENTS, GA4_MP_ENDPOINT, GA4_PRIVATE_TITLE, GA4_SCRIPT_URL, GA4_SERVER_EVENTS, MP_MAX_BACKDATE_MS,
  beginCheckoutParams, createGa4Client, createGa4ServerDestination, dropSearchParams, ga4ClientId, measurementProtocolPayload,
  resolveGa4MeasurementId, resolveGa4ServerConfig, type Ga4BrowserHost,
} from '../src/lib/analytics/destinations/ga4';
import {
  GA4_CLIENT_RETENTION_MS, ga4IdsFromRequest, ga4OutboxProperties, parseGaClientCookie, parseGaSessionCookie, rememberGa4Client,
} from '../src/lib/analytics/ga4-attribution';
import { membersRuntime } from '../src/lib/members/runtime';
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
    const page = { page_location: 'https://zuey.me/pricing', page_title: 'Pricing' };
    expect(sent[3]).toEqual(['set', page]);
    // No automatic page view: the only one is ours, with the scrubbed fields.
    expect(sent[4]).toEqual(['config', GA4_ID, { allow_google_signals: false, allow_ad_personalization_signals: false, send_page_view: false }]);
    expect(sent[5]).toEqual(['event', 'page_view', page]);
    expect(sent).toHaveLength(6);
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
      page_referrer: 'https://news.example/?ref=a',
      page_title: 'Pricing',
    });
    expect(JSON.stringify(commands(win))).not.toContain('example.com');
  });

  it('never sends search words, whatever the shared scrubber keeps', () => {
    const ga4 = createGa4Client();
    const { host, win } = fakeHost('https://zuey.me/articles?q=react+hooks&tag=ai&page=2&Search=x&keyword=y', {
      referrer: 'https://www.google.com/search?q=zuey+react', title: 'Articles',
    });
    ga4.start(host, GA4_ID, GRANTED);
    const pageView = commands(win).find(c => c[0] === 'event' && c[1] === 'page_view');
    expect(pageView?.[2]).toEqual({
      page_location: 'https://zuey.me/articles?tag=ai&page=2', page_referrer: 'https://www.google.com/search', page_title: 'Articles',
    });
    const all = JSON.stringify(commands(win));
    for (const word of ['react', 'hooks', 'zuey+react']) expect(all).not.toContain(word);
    expect(dropSearchParams('not a url?q=secret')).toBe('not a url');
    expect(dropSearchParams('https://zuey.me/a?b=1')).toBe('https://zuey.me/a?b=1');
  });

  it('puts the already identified member on the first page view', () => {
    const ga4 = createGa4Client();
    const { host, win } = fakeHost('https://zuey.me/');
    ga4.start(host, GA4_ID, GRANTED, MEMBER);
    const sent = commands(win);
    const userAt = sent.findIndex(c => c[0] === 'set' && JSON.stringify(c[1]) === JSON.stringify({ user_id: MEMBER }));
    const viewAt = sent.findIndex(c => c[0] === 'event' && c[1] === 'page_view');
    expect(userAt).toBeGreaterThan(-1);
    expect(userAt).toBeLessThan(viewAt);
    expect(ga4.destination.distinctId()).toBe(MEMBER);
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

  it('maps a refund of a known purchase, skips one without, and gives guests no user_id', async () => {
    const tx = await ecommerceTransactionId('paypal', 'CAPTURE1');
    const refund = { provider: 'paypal', order_type: 'booking', reason: 'refund', amount: 19.99, currency: 'USD', partial: false };
    const guest = { distinctId: 'guest_0123456789abcdef01234567' };
    const body = await measurementProtocolPayload(serverEvent('refund', { ...refund, transaction_id: tx }, guest), Date.now());
    expect(body?.user_id).toBeUndefined();
    expect(body?.client_id).toMatch(/^\d+\.\d+$/);
    expect(body?.events).toEqual([{
      name: 'refund',
      params: {
        transaction_id: tx, value: 19.99, currency: 'USD',
        items: [{ item_id: 'booking', item_name: 'booking', item_category: 'booking', quantity: 1, price: 19.99 }],
      },
    }]);
    // No purchase transaction known: GA4 would show a refund of nothing, so nothing is built.
    expect(await measurementProtocolPayload(serverEvent('refund', refund, guest), Date.now())).toBeNull();
  });

  it('uses the browser GA ids captured at checkout for client_id and session_id', async () => {
    const body = await measurementProtocolPayload(serverEvent('purchase', {
      provider: 'sepay', order_type: 'membership', amount: 199000, currency: 'VND', renewal: false, transaction_id: 'tx_abc',
      ga_client_id: '1234567890.1700000000', ga_session_id: '1700000500',
    }), Date.now());
    expect(body?.client_id).toBe('1234567890.1700000000');
    expect(body?.events).toEqual([{ name: 'purchase', params: expect.objectContaining({ transaction_id: 'tx_abc', session_id: '1700000500' }) }]);
    expect(JSON.stringify(body)).not.toContain('ga_client_id');
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

  it('needs a valid PostHog config: GA4 alone never makes a server destination', () => {
    const env = { PUBLIC_POSTHOG_KEY: 'not a key', PUBLIC_GA4_MEASUREMENT_ID: GA4_ID, GA4_API_SECRET: SECRET };
    expect(serverDestinations(env, prod)).toEqual([]);
  });

  const purchase = {
    event: 'purchase', distinctId: MEMBER,
    properties: { provider: 'dodo', order_type: 'membership', amount: 9, currency: 'USD', renewal: false, transaction_id: 'tx_1' },
  };
  function scripted(name: string, statuses: number[], seen: string[], secondary = false): ServerDestination {
    return {
      name, secondary, accepts: secondary ? (e: string) => GA4_SERVER_EVENTS.includes(e) : undefined,
      send: async event => {
        seen.push(`${name}:${event.event}`);
        const status = statuses.shift() ?? 200;
        return status < 300 ? { destination: name, ok: true, status } : { destination: name, ok: false, reason: 'http', status };
      },
    };
  }

  it('sends GA4 only purchase and refund, after PostHog accepted', async () => {
    const seen: string[] = [];
    const destinations = [scripted('posthog', [], seen), scripted('ga4', [], seen, true)];
    await sendServerEvent({ event: 'sign_up', distinctId: MEMBER, properties: { method: 'google' } }, destinations);
    expect(await sendServerEvent(purchase, destinations)).toMatchObject({ delivered: true });
    expect(seen).toEqual(['posthog:sign_up', 'posthog:purchase', 'ga4:purchase']);
    // Only a secondary destination: nothing is delivered.
    expect(await sendServerEvent({ event: 'login', distinctId: MEMBER, properties: { method: 'google' } }, [destinations[1]!]))
      .toMatchObject({ delivered: false, results: [{ destination: 'none', ok: false, reason: 'disabled' }] });
  });

  it('a PostHog failure is not delivered and GA4 is not sent; a GA4 failure never fails the event', async () => {
    const seen: string[] = [];
    const failingPostHog = await sendServerEvent(purchase, [scripted('posthog', [503], seen), scripted('ga4', [], seen, true)]);
    expect(failingPostHog).toMatchObject({ delivered: false, results: [{ destination: 'posthog', ok: false, status: 503 }] });
    expect(seen).toEqual(['posthog:purchase']);
    const failingGa4 = await sendServerEvent(purchase, [scripted('posthog', [], seen), scripted('ga4', [500], seen, true)]);
    expect(failingGa4.delivered).toBe(true);
    expect(failingGa4.results.map(r => r.ok)).toEqual([true, false]);
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

  it('keeps retrying a purchase PostHog failed, and sends GA4 its one copy only once PostHog accepted', async () => {
    const realNow = membersRuntime.now;
    let now = Date.parse('2026-10-20T03:00:00.000Z');
    membersRuntime.now = () => now;
    try {
      const d1 = createTestD1();
      await enqueueServerEvent(d1, {
        event: 'purchase', distinctId: MEMBER, dedupeKey: 'purchase:dodo:pay_2', occurredAt: new Date(now).toISOString(),
        properties: { provider: 'dodo', order_type: 'membership', amount: 9, currency: 'USD', renewal: false, transaction_id: 'tx_2' },
      });
      const calls: string[] = [];
      let posthogStatus = 503;
      const fetchImpl = async (url: string): Promise<Response> => {
        const ga4 = url.startsWith(GA4_MP_ENDPOINT);
        calls.push(ga4 ? 'ga4' : 'posthog');
        return new Response(null, { status: ga4 ? 204 : posthogStatus });
      };
      const destinations = serverDestinations({ PUBLIC_GA4_MEASUREMENT_ID: GA4_ID, GA4_API_SECRET: SECRET }, { production: true, requestHost: 'zuey.me', fetchImpl });
      expect(await drainAnalyticsOutbox(d1, { destinations })).toMatchObject({ sent: 0, retried: 1, dead: 0 });
      expect(calls).toEqual(['posthog']);
      now += 60 * 60 * 1000;
      posthogStatus = 200;
      expect(await drainAnalyticsOutbox(d1, { destinations })).toMatchObject({ sent: 1, retried: 0 });
      expect(calls).toEqual(['posthog', 'posthog', 'ga4']);
      now += 60 * 60 * 1000;
      expect(await drainAnalyticsOutbox(d1, { destinations })).toMatchObject({ claimed: 0 });
      expect(calls).toHaveLength(3);
    } finally {
      membersRuntime.now = realNow;
    }
  });

  it('with a broken PostHog config and the GA4 secret, rows stay queued and the drain reports skipped', async () => {
    const d1 = createTestD1();
    await queueSamples(d1);
    const destinations = serverDestinations({ PUBLIC_POSTHOG_KEY: 'bad', PUBLIC_GA4_MEASUREMENT_ID: GA4_ID, GA4_API_SECRET: SECRET }, {
      production: true, requestHost: 'zuey.me', fetchImpl: async () => new Response(null, { status: 204 }),
    });
    expect(await drainAnalyticsOutbox(d1, { destinations })).toMatchObject({ status: 'skipped', sent: 0, pending: 2 });
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

describe('GA4 attribution of server purchases', () => {
  const COOKIES = `other=1; _ga=GA1.1.1234567890.1700000000; _ga_${GA4_ID.slice(2)}=GS2.1.s1700000500$o3$g1$t1700000600$j0$l0$h0`;
  const request = (headers: Record<string, string>) => new Request('https://zuey.me/api/v1/billing/orders', { method: 'POST', headers });

  it('parses the GA client and session cookies', () => {
    expect(parseGaClientCookie('GA1.1.1234567890.1700000000')).toBe('1234567890.1700000000');
    expect(parseGaClientCookie('GA1.2.x.1')).toBeNull();
    expect(parseGaClientCookie(null)).toBeNull();
    expect(parseGaSessionCookie('GS1.1.1700000500.3.1.1700000600.0.0.0')).toBe('1700000500');
    expect(parseGaSessionCookie('GS2.1.s1700000500$o3$g1$t1700000600$j0$l0$h0')).toBe('1700000500');
    expect(parseGaSessionCookie('GS9.1.1')).toBeNull();
  });

  it('reads the ids only when GA4 is on and the browser sends neither Do Not Track nor GPC', () => {
    expect(ga4IdsFromRequest(request({ Cookie: COOKIES }), GA4_ID)).toEqual({ clientId: '1234567890.1700000000', sessionId: '1700000500' });
    expect(ga4IdsFromRequest(request({ Cookie: COOKIES }), undefined)).toBeNull();
    expect(ga4IdsFromRequest(request({ Cookie: COOKIES, DNT: '1' }), GA4_ID)).toBeNull();
    expect(ga4IdsFromRequest(request({ Cookie: COOKIES, 'Sec-GPC': '1' }), GA4_ID)).toBeNull();
    expect(ga4IdsFromRequest(request({ Cookie: 'other=1' }), GA4_ID)).toBeNull();
  });

  it('stores them at checkout and puts them on the purchase and refund rows, never on PostHog', async () => {
    const realNow = membersRuntime.now;
    let now = Date.parse('2026-10-20T03:00:00.000Z');
    membersRuntime.now = () => now;
    try {
      const d1 = createTestD1();
      await rememberGa4Client(d1, GA4_ID, MEMBER, request({ Cookie: COOKIES }));
      now += 10 * 60 * 1000;
      await queuePurchase(d1, { distinctId: MEMBER, provider: 'sepay', orderType: 'membership', transactionId: 'billing_order:o1', amountMinor: 199000, currency: 'VND' });
      await queueRefund(d1, { distinctId: MEMBER, provider: 'sepay', orderType: 'membership', reference: 'r1', reason: 'refund', purchaseTransactionId: 'billing_order:o1' });
      const rows = await d1.prepare('SELECT event, properties FROM analytics_outbox ORDER BY event').all<{ event: string; properties: string }>();
      const props = Object.fromEntries((rows.results ?? []).map(r => [r.event, JSON.parse(r.properties)]));
      expect(props.purchase).toMatchObject({ ga_client_id: '1234567890.1700000000', ga_session_id: '1700000500' });
      expect(props.refund).toMatchObject({ ga_client_id: '1234567890.1700000000' });
      expect(props.refund.ga_session_id).toBeUndefined();

      const bodies: Array<{ url: string; body: string }> = [];
      const destinations = serverDestinations({ PUBLIC_GA4_MEASUREMENT_ID: GA4_ID, GA4_API_SECRET: SECRET }, {
        production: true, requestHost: 'zuey.me',
        fetchImpl: async (url, init) => { bodies.push({ url, body: String(init.body) }); return new Response(null, { status: 204 }); },
      });
      expect(await drainAnalyticsOutbox(d1, { destinations })).toMatchObject({ sent: 2 });
      const posthog = bodies.filter(b => !b.url.startsWith(GA4_MP_ENDPOINT));
      const ga4 = bodies.filter(b => b.url.startsWith(GA4_MP_ENDPOINT)).map(b => JSON.parse(b.body));
      expect(posthog).toHaveLength(2);
      for (const b of posthog) expect(b.body).not.toContain('1234567890');
      expect(ga4.map(b => b.client_id)).toEqual(['1234567890.1700000000', '1234567890.1700000000']);
      // Once sent, the outbox rows no longer keep a copy of the ids.
      const sent = await d1.prepare('SELECT properties FROM analytics_outbox').all<{ properties: string }>();
      for (const r of sent.results ?? []) expect(r.properties).not.toContain('ga_');

      // Past the retention window the ids are neither used nor kept.
      now += GA4_CLIENT_RETENTION_MS + 1000;
      expect(await ga4OutboxProperties(d1, MEMBER, true)).toEqual({});
      await rememberGa4Client(d1, GA4_ID, 'usr_other', request({ Cookie: COOKIES }));
      const left = await d1.prepare('SELECT user_id FROM analytics_ga4_clients').all<{ user_id: string }>();
      expect((left.results ?? []).map(r => r.user_id)).toEqual(['usr_other']);
    } finally {
      membersRuntime.now = realNow;
    }
  });

  it('purges expired ids on every outbox drain, without waiting for a checkout', async () => {
    const realNow = membersRuntime.now;
    const now = Date.parse('2026-10-20T03:00:00.000Z');
    membersRuntime.now = () => now;
    try {
      const d1 = createTestD1();
      d1.raw.run('INSERT INTO analytics_ga4_clients (user_id, client_id, session_id, updated_at) VALUES (?, ?, NULL, ?)',
        ['usr_old', '1.1', new Date(now - GA4_CLIENT_RETENTION_MS - 1000).toISOString()]);
      d1.raw.run('INSERT INTO analytics_ga4_clients (user_id, client_id, session_id, updated_at) VALUES (?, ?, NULL, ?)',
        ['usr_new', '2.2', new Date(now - 1000).toISOString()]);
      const ok: ServerDestination = { name: 'posthog', send: async () => ({ destination: 'posthog', ok: true, status: 200 }) };
      expect(await drainAnalyticsOutbox(d1, { destinations: [ok] })).toMatchObject({ status: 'ok', claimed: 0 });
      const left = await d1.prepare('SELECT user_id FROM analytics_ga4_clients').all<{ user_id: string }>();
      expect((left.results ?? []).map(r => r.user_id)).toEqual(['usr_new']);

      // A skipped run (analytics off) purges too, and a missing table never breaks the drain.
      d1.raw.run("UPDATE analytics_ga4_clients SET updated_at = '2000-01-01T00:00:00.000Z'");
      expect(await drainAnalyticsOutbox(d1, { destinations: [] })).toMatchObject({ status: 'skipped' });
      expect(await d1.prepare('SELECT COUNT(*) AS n FROM analytics_ga4_clients').first<{ n: number }>()).toEqual({ n: 0 });
      d1.raw.run('DROP TABLE analytics_ga4_clients');
      expect(await drainAnalyticsOutbox(d1, { destinations: [ok] })).toMatchObject({ status: 'ok' });
    } finally {
      membersRuntime.now = realNow;
    }
  });

  it('stores nothing without consent signals or cookies, and ignores guests', async () => {
    const d1 = createTestD1();
    await rememberGa4Client(d1, GA4_ID, MEMBER, request({ Cookie: COOKIES, DNT: '1' }));
    await rememberGa4Client(d1, undefined, MEMBER, request({ Cookie: COOKIES }));
    expect(await d1.prepare('SELECT COUNT(*) AS n FROM analytics_ga4_clients').first<{ n: number }>()).toEqual({ n: 0 });
    expect(await ga4OutboxProperties(d1, 'guest_0123456789abcdef01234567', true)).toEqual({});
  });
});

describe('client identity with GA4 started for a known member', () => {
  it('does not re-run identify on every page load', () => {
    const calls: string[] = [];
    const posthog: ClientDestination = {
      name: 'posthog', capture: () => undefined, identify: id => calls.push(`posthog:identify:${id}`),
      reset: () => calls.push('posthog:reset'), optOut: () => undefined, optIn: () => undefined, distinctId: () => MEMBER,
    };
    const ga4 = createGa4Client();
    ga4.start(fakeHost('https://zuey.me/').host, GA4_ID, GRANTED, MEMBER);
    const client = createAnalyticsClient({
      destinations: [posthog, ga4.destination], consent: () => GRANTED, local: () => memoryStorage({ zuey_analytics_member: MEMBER }),
      session: () => memoryStorage(), fetchIdentity: async () => undefined, now: () => 0, debug: () => undefined,
    });
    client.activate(false);
    client.identify(MEMBER);
    expect(calls).toEqual([]);
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
