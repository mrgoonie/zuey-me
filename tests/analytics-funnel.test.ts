import { describe, expect, test } from 'bun:test';
import {
  ATTRIBUTION_STORAGE_KEY, attributionProperties, parseAttribution, parseStoredAttribution, referrerOrigin,
} from '../src/lib/analytics/attribution';
import { createAnalyticsClient, MAX_PENDING_EVENTS, type AnalyticsClientDeps, type PageContext } from '../src/lib/analytics/client';
import type { ConsentEnvironment } from '../src/lib/analytics/consent';
import type { ClientDestination } from '../src/lib/analytics/destinations/types';
import { ANALYTICS_EVENTS, type EventSpec } from '../src/lib/analytics/events';
import { daysAhead, failureReason, moneyProps } from '../src/lib/analytics/funnel';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
}

const FUNNEL_EVENTS = [
  'sign_up_started', 'magic_link_requested', 'auth_failed', 'logout', 'pricing_viewed', 'billing_term_selected', 'plan_selected',
  'begin_checkout', 'checkout_created', 'payment_initiated', 'booking_availability_viewed', 'booking_slot_selected',
  'booking_hold_created', 'booking_checkout_started',
] as const;

type Captured = { event: string; props: Record<string, unknown> };

function fakeClient(opts: { consent?: ConsentEnvironment; session?: MemoryStorage; page?: PageContext | null } = {}) {
  const captured: Captured[] = [];
  const dest: ClientDestination = {
    name: 'fake',
    capture: (event, props) => { captured.push({ event, props }); },
    identify: () => undefined, reset: () => undefined, optOut: () => undefined, optIn: () => undefined, distinctId: () => null,
  };
  const consent = opts.consent ?? { navigator: {}, storage: new MemoryStorage() };
  const session = opts.session ?? new MemoryStorage();
  const deps: AnalyticsClientDeps = {
    destinations: [dest],
    consent: () => consent,
    local: () => new MemoryStorage(),
    session: () => session,
    fetchIdentity: async () => undefined,
    now: () => 1_000_000,
    debug: () => undefined,
    page: () => (opts.page === undefined ? { search: '', referrer: '', hostname: 'zuey.me' } : opts.page),
  };
  return { client: createAnalyticsClient(deps), captured, session, consent };
}

describe('funnel taxonomy', () => {
  test('every funnel event is a client event with plain, non-URL properties', () => {
    for (const name of FUNNEL_EVENTS) {
      const spec: EventSpec = ANALYTICS_EVENTS[name];
      expect(spec.source).toBe('client');
      for (const [prop, kind] of Object.entries(spec.props)) {
        expect(kind.kind).not.toBe('url');
        // No property may be named after personal data, secrets or provider references.
        expect(prop).not.toMatch(/email|phone|name|token|password|secret|url|address|_code$|^code$|_ref$|^ref$|_id$|^id$/);
      }
    }
  });
});

describe('session attribution', () => {
  test('keeps the five utm keys with plain values and drops everything else', () => {
    const a = parseAttribution(
      '?utm_source=newsletter&utm_medium=email&utm_campaign=Ra%20m%E1%BA%AFt%20Zuey&utm_term=ai+agents&utm_content=hero-cta&gclid=abc123&ref=x&email=a@b.co',
      '', 'zuey.me',
    );
    expect(a).toEqual({ utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'Ra mắt Zuey', utm_term: 'ai agents', utm_content: 'hero-cta' });
  });

  test('utm values that look like an email, a URL, a token or free text are dropped', () => {
    const a = parseAttribution(
      `?utm_source=duy@example.com&utm_medium=https://evil.test/?token=1&utm_campaign=${'x'.repeat(101)}&utm_term=zk_abcdefghijklmnop&utm_content=a=b`,
      '', 'zuey.me',
    );
    expect(a).toEqual({});
  });

  test('the referrer keeps only the origin of an external http(s) site', () => {
    expect(referrerOrigin('https://www.google.com/search?q=zuey+duy%40example.com', 'zuey.me')).toBe('https://www.google.com');
    expect(referrerOrigin('https://mail.example.com/u/0/#inbox/FMfcgz?token=abc', 'zuey.me')).toBe('https://mail.example.com');
    expect(referrerOrigin('https://zuey.me/login/verify?token=secret', 'zuey.me')).toBeNull();
    expect(referrerOrigin('android-app://com.google.android.gm/', 'zuey.me')).toBeNull();
    expect(referrerOrigin('not a url', 'zuey.me')).toBeNull();
    expect(referrerOrigin('', 'zuey.me')).toBeNull();
  });

  test('stored entries are re-validated and become session_* properties', () => {
    const stored = JSON.stringify({ utm_source: 'x', utm_medium: 'a@b.co', referrer: 'https://t.co/abc', other: 'nope' });
    expect(parseStoredAttribution(stored)).toEqual({ utm_source: 'x' });
    expect(parseStoredAttribution('{"referrer":"https://t.co"}')).toEqual({ referrer: 'https://t.co' });
    expect(parseStoredAttribution('not json')).toBeNull();
    expect(attributionProperties({ utm_source: 'x', referrer: 'https://t.co' })).toEqual({ session_utm_source: 'x', session_referrer: 'https://t.co' });
  });
});

describe('client funnel plumbing', () => {
  test('events tracked before the boot step are sent once it activates, with the session attribution', () => {
    const { client, captured, session } = fakeClient({
      page: { search: '?utm_source=fb&utm_campaign=launch&fbclid=IwAR123', referrer: 'https://l.facebook.com/l.php?u=https%3A%2F%2Fzuey.me', hostname: 'zuey.me' },
    });
    client.track('pricing_viewed', { months: 1, card_available: true });
    expect(captured).toEqual([]);
    client.activate(false);
    expect(captured).toEqual([{
      event: 'pricing_viewed',
      props: {
        months: 1, card_available: true, session_utm_source: 'fb', session_utm_campaign: 'launch', session_referrer: 'https://l.facebook.com',
        event_version: 1, schema_version: 1,
      },
    }]);
    expect(session.getItem(ATTRIBUTION_STORAGE_KEY)).toBe('{"utm_source":"fb","utm_campaign":"launch","referrer":"https://l.facebook.com"}');
  });

  test('the first page of the session keeps its attribution on later pages', () => {
    const session = new MemoryStorage();
    fakeClient({ session, page: { search: '?utm_source=youtube', referrer: '', hostname: 'zuey.me' } }).client.activate(false);
    const next = fakeClient({ session, page: { search: '?utm_source=other', referrer: 'https://zuey.me/', hostname: 'zuey.me' } });
    next.client.activate(false);
    next.client.track('plan_selected', { plan: 'ai', provider: 'sepay', months: 3 });
    expect(next.captured[0].props.session_utm_source).toBe('youtube');
  });

  test('a direct visit stays direct for the session', () => {
    const session = new MemoryStorage();
    fakeClient({ session }).client.activate(false);
    const next = fakeClient({ session, page: { search: '?utm_source=late', referrer: '', hostname: 'zuey.me' } });
    next.client.activate(false);
    next.client.track('logout', { surface: 'account' });
    expect(Object.keys(next.captured[0].props).filter(k => k.startsWith('session_'))).toEqual([]);
  });

  test('settle drops the pending events; the queue is bounded', () => {
    const settled = fakeClient();
    settled.client.track('pricing_viewed', { months: 1, card_available: false });
    settled.client.settle();
    settled.client.activate(false);
    expect(settled.captured).toEqual([]);

    const flood = fakeClient();
    for (let i = 0; i < MAX_PENDING_EVENTS + 10; i += 1) flood.client.track('booking_slot_selected', { duration_min: 90, days_ahead: i });
    flood.client.activate(false);
    expect(flood.captured).toHaveLength(MAX_PENDING_EVENTS);
  });

  test('trackOnce sends a key once per page load (StrictMode double effects, remounts)', () => {
    const { client, captured } = fakeClient();
    client.activate(false);
    for (let i = 0; i < 3; i += 1) client.trackOnce('pricing_viewed', 'pricing_viewed', { months: 1, card_available: false });
    client.trackOnce('booking_availability_viewed', 'booking_availability_viewed', { slot_count: 4 });
    expect(captured.map(c => c.event)).toEqual(['pricing_viewed', 'booking_availability_viewed']);
  });

  test('with Do Not Track or an opt-out, queued events are dropped and no attribution is stored', () => {
    for (const consent of [
      { navigator: { doNotTrack: '1' }, storage: new MemoryStorage() },
      { navigator: { globalPrivacyControl: true }, storage: new MemoryStorage() },
    ]) {
      const { client, captured, session } = fakeClient({ consent, page: { search: '?utm_source=x', referrer: '', hostname: 'zuey.me' } });
      client.track('pricing_viewed', { months: 1, card_available: false });
      client.activate(false);
      client.track('begin_checkout', { order_type: 'membership', provider: 'sepay', discount_entered: false });
      expect(captured).toEqual([]);
      expect(session.getItem(ATTRIBUTION_STORAGE_KEY)).toBeNull();
    }

    const opted = fakeClient({ page: { search: '?utm_source=x', referrer: '', hostname: 'zuey.me' } });
    opted.client.activate(false);
    expect(opted.session.getItem(ATTRIBUTION_STORAGE_KEY)).not.toBeNull();
    opted.client.optOut();
    opted.client.track('plan_selected', { plan: 'ai', provider: 'sepay', months: 1 });
    expect(opted.captured).toEqual([]);
    expect(opted.session.getItem(ATTRIBUTION_STORAGE_KEY)).toBeNull();
  });

  test('a funnel event with an undeclared or PII property is dropped whole', () => {
    const { client, captured } = fakeClient();
    client.activate(false);
    const bad: unknown = { stage: 'magic_link_request', reason: 'rate_limited', email: 'duy@example.com' };
    // @ts-expect-error -- the typed API refuses the extra property; the runtime check must too.
    client.track('auth_failed', bad);
    client.track('auth_failed', { stage: 'callback', reason: 'duy@example.com' });
    expect(captured).toEqual([]);
  });
});

describe('funnel helpers', () => {
  test('failure reasons are snake_case codes or unknown', () => {
    expect(failureReason('oauth_denied')).toBe('oauth_denied');
    expect(failureReason('http_429')).toBe('http_429');
    expect(failureReason('Duy@Example.com')).toBe('unknown');
    expect(failureReason('token=abc')).toBe('unknown');
    expect(failureReason(null)).toBe('unknown');
  });

  test('days ahead is coarse and never negative', () => {
    const now = Date.parse('2026-10-11T03:00:00Z');
    expect(daysAhead('2026-10-11T09:00:00Z', now)).toBe(0);
    expect(daysAhead('2026-10-14T09:00:00Z', now)).toBe(3);
    expect(daysAhead('2026-10-01T09:00:00Z', now)).toBe(0);
    expect(daysAhead('garbage', now)).toBe(0);
  });

  test('money props keep the currency and use major units', () => {
    expect(moneyProps(199900, 'USD')).toEqual({ value: 1999, currency: 'USD' });
    expect(moneyProps(237000, 'VND')).toEqual({ value: 237000, currency: 'VND' });
    expect(moneyProps(null, 'VND')).toEqual({});
  });
});
