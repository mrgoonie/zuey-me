import { describe, expect, test } from 'bun:test';
import { PROVIDER_LABELS } from '../src/lib/blocks/embed';
import { createAnalyticsClient, shouldCaptureOn, type AnalyticsClientDeps } from '../src/lib/analytics/client';
import {
  BLOCKED_STORAGE, OPT_OUT_STORAGE_KEY, STORAGE_PROBE_KEY, consentControlView, consentState, isOptedOut, resolveConsentStorage,
  setOptOut, type ConsentEnvironment,
} from '../src/lib/analytics/consent';
import {
  DEFAULT_POSTHOG_KEY, createPostHogServerDestination, getPostHog, isSensitivePath, postHogClientDestination, resolvePostHogConfig, scrubCaptureResult,
} from '../src/lib/analytics/destinations/posthog';
import type { ClientDestination, ServerDestination } from '../src/lib/analytics/destinations/types';
import { validateEvent, type Taxonomy } from '../src/lib/analytics/events';
import {
  IDENTITY_CACHE_KEY, IDENTITY_STORAGE_KEY, isValidDistinctId, parseIdentityCache, parseIdentityResponse, planIdentity,
} from '../src/lib/analytics/identity';
import { REDACTED, containsPii, redactString, scrubUrl, scrubValue } from '../src/lib/analytics/pii';
import { captureServerEvent, isServerCaptureHost, sendServerEvent, serverDestinations } from '../src/lib/analytics/server';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c3JfMTIzIn0.c2lnbmF0dXJlLXZhbHVl';
const KEY = 'phc_abcdefghijklmnopqrstuvwxyz0123456789';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
}

describe('PII guard', () => {
  test('strips sensitive query and fragment parameters from absolute and relative URLs', () => {
    expect(scrubUrl('https://zuey.me/articles/x?token=abc123&next=%2Faccount')).toBe('https://zuey.me/articles/x?next=%2Faccount');
    expect(scrubUrl('https://zuey.me/login/verify?token=abc123&next=%2Faccount')).toBe('https://zuey.me/login/verify');
    expect(scrubUrl('/api/auth/google/callback?code=4%2F0Ab&state=xyz&utm_source=x')).toBe('/api/auth/google/callback?utm_source=x');
    expect(scrubUrl('https://zuey.me/#access_token=abc&tab=1')).toBe('https://zuey.me/#tab=1');
    expect(scrubUrl('https://zuey.me/?Email=a@b.co&reset_token=1&session_id=2&key=3&sig=4&secret=5')).toBe('https://zuey.me/');
    expect(scrubUrl('https://user:pw@zuey.me/x')).toBe('https://zuey.me/x');
  });

  test('keeps harmless parameters such as UTM and search keywords', () => {
    expect(scrubUrl('https://zuey.me/articles?q=astro&keyword=x&utm_campaign=y')).toBe('https://zuey.me/articles?q=astro&keyword=x&utm_campaign=y');
  });

  test('redacts emails, JWTs and secret tokens inside free text', () => {
    expect(redactString('mail me at duy@example.com')).toBe(`mail me at ${REDACTED}`);
    expect(redactString(`Bearer ${JWT}`)).toBe(`Bearer ${REDACTED}`);
    expect(redactString('key zk_abcdefghijklmnop1234 here')).toBe(`key ${REDACTED} here`);
    expect(redactString('a:href="/login/verify?token=zz"')).toBe(`a:href="/login/verify?token=${REDACTED}"`);
    expect(containsPii('duy@example.com')).toBe(true);
    expect(containsPii(JWT)).toBe(true);
    expect(containsPii('usr_01HZX')).toBe(false);
  });

  test('deep-scrubs PostHog automatic properties via before_send', () => {
    const out = scrubCaptureResult({
      event: '$pageview',
      properties: {
        $current_url: 'https://zuey.me/login/verify?token=secret-token',
        $referrer: 'https://mail.example.com/?email=a@b.co',
        $elements: [{ attr__href: '/x?code=123', $el_text: 'Contact a@b.co' }],
        count: 3,
      },
      $set: { $initial_current_url: 'https://zuey.me/?state=abc' },
    });
    expect(out?.properties).toEqual({
      $current_url: 'https://zuey.me/login/verify',
      $referrer: 'https://mail.example.com/',
      $elements: [{ attr__href: '/x', $el_text: `Contact ${REDACTED}` }],
      count: 3,
    });
    expect(out?.$set).toEqual({ $initial_current_url: 'https://zuey.me/' });
    expect(scrubCaptureResult(null)).toBeNull();
  });

  test('scrubValue leaves non-strings untouched', () => {
    expect(scrubValue({ a: 1, b: true, c: null })).toEqual({ a: 1, b: true, c: null });
  });
});

describe('event taxonomy', () => {
  test('accepts a declared event and scrubs url properties', () => {
    const r = validateEvent('link_clicked', { id: 'l1', section: 'main', title: 'Blog', url: 'https://x.dev/?token=1&ref=zuey' }, 'client');
    expect(r).toEqual({ ok: true, version: 1, properties: { id: 'l1', section: 'main', title: 'Blog', url: 'https://x.dev/?ref=zuey' } });
  });

  test('rejects unknown events, unknown or missing properties and wrong types', () => {
    expect(validateEvent('made_up', {}, 'client')).toMatchObject({ ok: false, error: { reason: 'unknown_event' } });
    expect(validateEvent('social_clicked', { platform: 'x', email: 'a' }, 'client')).toMatchObject({ ok: false, error: { reason: 'unknown_property', property: 'email' } });
    expect(validateEvent('social_clicked', {}, 'client')).toMatchObject({ ok: false, error: { reason: 'missing_property', property: 'platform' } });
    expect(validateEvent('article_ask_ai_clicked', { slug: 's', chars: '12' }, 'client')).toMatchObject({ ok: false, error: { reason: 'invalid_type', property: 'chars' } });
    expect(validateEvent('social_clicked', { platform: 'x' }, 'server')).toMatchObject({ ok: false, error: { reason: 'wrong_source' } });
    expect(validateEvent('toString', {}, 'client')).toMatchObject({ ok: false, error: { reason: 'unknown_event' } });
  });

  test('url properties redact embedded emails instead of rejecting the event', () => {
    expect(validateEvent('explore_clicked', { target: 'mailto:hi@zuey.me' }, 'client'))
      .toEqual({ ok: true, version: 1, properties: { target: `mailto:${REDACTED}` } });
  });

  test('rejects values that look like personal data or free text', () => {
    expect(validateEvent('social_clicked', { platform: 'duy@example.com' }, 'client')).toMatchObject({ ok: false, error: { reason: 'pii' } });
    expect(validateEvent('command_palette_article', { slug: JWT }, 'client')).toMatchObject({ ok: false, error: { reason: 'pii' } });
    expect(validateEvent('command_palette_action', { action: 'x'.repeat(501) }, 'client')).toMatchObject({ ok: false, error: { reason: 'too_long' } });
  });
});

describe('consent', () => {
  const env = (over: Partial<ConsentEnvironment> = {}): ConsentEnvironment => ({ navigator: {}, storage: new MemoryStorage(), ...over });

  test('Do Not Track and Global Privacy Control disable capture', () => {
    expect(consentState(env())).toBe('granted');
    expect(consentState(env({ navigator: { doNotTrack: '1' } }))).toBe('do_not_track');
    expect(consentState(env({ navigator: { globalPrivacyControl: true } }))).toBe('do_not_track');
    expect(consentState(env({ windowDoNotTrack: 'yes' }))).toBe('do_not_track');
  });

  test('the local opt-out persists and can be withdrawn', () => {
    const e = env();
    expect(setOptOut(true, e)).toBe(true);
    expect(e.storage?.getItem(OPT_OUT_STORAGE_KEY)).toBe('1');
    expect(consentState(e)).toBe('opted_out');
    setOptOut(false, e);
    expect(consentState(e)).toBe('granted');
  });

  test('storage that throws on read reports storage_blocked and never tracks', () => {
    const throwing = { getItem: (): string | null => { throw new Error('blocked'); }, setItem: () => undefined, removeItem: () => undefined };
    expect(consentState(env({ storage: throwing }))).toBe('storage_blocked');
    expect(isOptedOut(env({ storage: throwing }))).toBe(true);
  });

  test('Do Not Track still wins over blocked storage', () => {
    expect(consentState(env({ navigator: { doNotTrack: '1' }, storage: BLOCKED_STORAGE }))).toBe('do_not_track');
  });
});

interface Call { method: string; args: unknown[] }

/** A PostHog-like destination whose distinct id follows identify/reset; `shared` models one browser profile. */
function fakeDestination(calls: Call[], shared: { distinctId: string }): ClientDestination {
  let anon = 0;
  return {
    name: 'fake',
    capture: (...args) => { calls.push({ method: 'capture', args }); },
    identify: (...args) => { calls.push({ method: 'identify', args }); shared.distinctId = args[0]; },
    reset: () => { calls.push({ method: 'reset', args: [] }); anon += 1; shared.distinctId = `anon-${anon}`; },
    optOut: () => { calls.push({ method: 'optOut', args: [] }); },
    optIn: () => { calls.push({ method: 'optIn', args: [] }); },
    distinctId: () => shared.distinctId,
  };
}

function fakeClient(
  over: Partial<AnalyticsClientDeps> = {},
  consent: ConsentEnvironment = { navigator: {}, storage: new MemoryStorage() },
  browser: { local: MemoryStorage; posthog: { distinctId: string } } = { local: new MemoryStorage(), posthog: { distinctId: 'anon-0' } },
) {
  const calls: Call[] = [];
  const dest = fakeDestination(calls, browser.posthog);
  const local = browser.local;
  const session = new MemoryStorage();
  const client = createAnalyticsClient({
    destinations: [dest],
    consent: () => consent,
    local: () => local,
    session: () => session,
    fetchIdentity: async () => undefined,
    now: () => 1_000_000,
    debug: () => undefined,
    ...over,
  });
  return { client, calls, local, session, consent };
}

describe('browser client', () => {
  test('track sends only validated events with version metadata', () => {
    const { client, calls } = fakeClient();
    client.activate(false);
    client.track('social_clicked', { platform: 'github' });
    expect(calls).toEqual([{ method: 'capture', args: ['social_clicked', { platform: 'github', event_version: 1, schema_version: 1 }] }]);
  });

  test('nothing is sent before activation, with Do Not Track, or after opting out', () => {
    const inactive = fakeClient();
    inactive.client.track('social_clicked', { platform: 'x' });
    expect(inactive.calls).toEqual([]);

    const dnt = fakeClient({}, { navigator: { doNotTrack: '1' }, storage: new MemoryStorage() });
    dnt.client.activate(false);
    dnt.client.track('social_clicked', { platform: 'x' });
    dnt.client.identify('usr_1');
    expect(dnt.calls).toEqual([]);

    const opted = fakeClient();
    opted.client.activate(false);
    opted.client.optOut();
    opted.client.track('social_clicked', { platform: 'x' });
    expect(opted.calls.map(c => c.method)).toEqual(['optOut', 'reset']);
  });

  test('track never throws, even when a destination does', () => {
    const { client } = fakeClient({
      destinations: [{ name: 'broken', capture: () => { throw new Error('boom'); }, identify: () => undefined, reset: () => undefined, optOut: () => undefined, optIn: () => undefined, distinctId: () => null }],
    });
    client.activate(false);
    expect(() => client.track('social_clicked', { platform: 'x' })).not.toThrow();
  });

  test('identify uses the member id and refuses emails', () => {
    const { client, calls, local } = fakeClient();
    client.activate(false);
    client.identify('duy@example.com');
    expect(calls).toEqual([]);
    client.identify('usr_01HZXABC');
    expect(calls).toEqual([{ method: 'identify', args: ['usr_01HZXABC'] }]);
    expect(local.getItem(IDENTITY_STORAGE_KEY)).toBe('usr_01HZXABC');
    client.identify('usr_01HZXABC');
    expect(calls.length).toBe(1);
  });

  test('a different member on the same device is reset before being identified', () => {
    const { client, calls } = fakeClient();
    client.activate(false);
    client.identify('usr_a');
    client.identify('usr_b');
    expect(calls.map(c => `${c.method}:${c.args.join(',')}`)).toEqual(['identify:usr_a', 'reset:', 'identify:usr_b']);
  });

  test('reset clears the stored identity even when inactive', () => {
    const { client, calls, local, session } = fakeClient();
    local.setItem(IDENTITY_STORAGE_KEY, 'usr_a');
    session.setItem(IDENTITY_CACHE_KEY, '{}');
    client.reset();
    expect(local.getItem(IDENTITY_STORAGE_KEY)).toBeNull();
    expect(session.getItem(IDENTITY_CACHE_KEY)).toBeNull();
    expect(calls.map(c => c.method)).toEqual(['reset']);
  });

  test('syncIdentity identifies from the server session and resets when it ends', async () => {
    let answer: unknown = { success: true, data: { member_id: 'usr_a' } };
    const { client, calls, session } = fakeClient({ fetchIdentity: async () => answer });
    client.activate(false);
    await client.syncIdentity('/account');
    expect(calls).toEqual([{ method: 'identify', args: ['usr_a'] }]);

    answer = { success: true, data: { member_id: null } };
    session.removeItem(IDENTITY_CACHE_KEY);
    await client.syncIdentity('/');
    expect(calls.map(c => c.method)).toEqual(['identify', 'reset']);
  });

  test('syncIdentity keeps the identity when the server answer is unknown', async () => {
    const { client, calls, local } = fakeClient({ fetchIdentity: async () => undefined });
    local.setItem(IDENTITY_STORAGE_KEY, 'usr_a');
    client.activate(false);
    await client.syncIdentity('/');
    expect(calls).toEqual([]);
    expect(local.getItem(IDENTITY_STORAGE_KEY)).toBe('usr_a');
  });

  test('syncIdentity uses the tab cache outside auth pages', async () => {
    let fetches = 0;
    const { client, session } = fakeClient({ fetchIdentity: async () => { fetches += 1; return { data: { member_id: null } }; } });
    client.activate(false);
    session.setItem(IDENTITY_CACHE_KEY, JSON.stringify({ memberId: null, at: 1_000_000 - 1000 }));
    await client.syncIdentity('/articles');
    expect(fetches).toBe(0);
    await client.syncIdentity('/login/verify');
    expect(fetches).toBe(1);
  });
});

describe('identity helpers', () => {
  test('planIdentity never merges two members', () => {
    expect(planIdentity(null, null)).toEqual([]);
    expect(planIdentity(null, 'a')).toEqual(['identify']);
    expect(planIdentity('a', 'a')).toEqual([]);
    expect(planIdentity('a', null)).toEqual(['reset']);
    expect(planIdentity('a', 'b')).toEqual(['reset', 'identify']);
  });

  test('distinct ids must be opaque ids', () => {
    expect(isValidDistinctId('usr_01HZX')).toBe(true);
    expect(isValidDistinctId('0191c8a2-7d9e-7a1b-9c3d-2e4f5a6b7c8d')).toBe(true);
    expect(isValidDistinctId('duy@example.com')).toBe(false);
    expect(isValidDistinctId('Duy Nguyen')).toBe(false);
    expect(isValidDistinctId('')).toBe(false);
  });

  test('parses the identity endpoint and the tab cache defensively', () => {
    expect(parseIdentityResponse({ success: true, data: { member_id: 'usr_a' } })).toBe('usr_a');
    expect(parseIdentityResponse({ success: true, data: { member_id: null } })).toBeNull();
    expect(parseIdentityResponse({ success: false })).toBeUndefined();
    expect(parseIdentityResponse('nope')).toBeUndefined();
    expect(parseIdentityCache(JSON.stringify({ memberId: 'usr_a', at: 100 }), 200)).toEqual({ memberId: 'usr_a', at: 100 });
    expect(parseIdentityCache(JSON.stringify({ memberId: 'usr_a', at: 0 }), 11 * 60 * 1000)).toBeNull();
    expect(parseIdentityCache('{bad', 0)).toBeNull();
  });
});

describe('PostHog configuration', () => {
  test('the built-in key is used only by production builds', () => {
    expect(resolvePostHogConfig({}, { production: true })?.key).toBe(DEFAULT_POSTHOG_KEY);
    expect(resolvePostHogConfig({}, { production: false })).toBeNull();
    expect(resolvePostHogConfig({ PUBLIC_POSTHOG_KEY: KEY }, { production: false })).toEqual({ key: KEY, host: 'https://us.i.posthog.com', debug: false });
  });

  test('rejects malformed keys and non-https hosts', () => {
    expect(resolvePostHogConfig({ PUBLIC_POSTHOG_KEY: 'not-a-key' }, { production: true })).toBeNull();
    expect(resolvePostHogConfig({ PUBLIC_POSTHOG_KEY: KEY, PUBLIC_POSTHOG_HOST: 'http://evil.test' }, { production: true })).toBeNull();
    expect(resolvePostHogConfig({ PUBLIC_POSTHOG_KEY: KEY, PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com/' }, { production: true })?.host).toBe('https://eu.i.posthog.com');
  });

  test('capture is off on localhost and dev builds unless debug is set', () => {
    const config = { key: KEY, host: 'https://us.i.posthog.com', debug: false };
    expect(shouldCaptureOn('zuey.me', config, false)).toBe(true);
    expect(shouldCaptureOn('www.zuey.me', config, false)).toBe(true);
    expect(shouldCaptureOn('feature-x.zuey-me.pages.dev', config, false)).toBe(false);
    expect(shouldCaptureOn('127.0.0.1', config, false)).toBe(false);
    expect(shouldCaptureOn('localhost', config, false)).toBe(false);
    expect(shouldCaptureOn('zuey.me', config, true)).toBe(false);
    expect(shouldCaptureOn('localhost', { ...config, debug: true }, true)).toBe(true);
  });

  test('autocapture is disabled on account, billing, booking and AI pages', () => {
    expect(isSensitivePath('/account')).toBe(true);
    expect(isSensitivePath('/billing/ZM123')).toBe(true);
    expect(isSensitivePath('/chat')).toBe(true);
    expect(isSensitivePath('/articles/x')).toBe(false);
  });
});

const testTaxonomy: Taxonomy = {
  server_test: { version: 2, source: 'server', owner: 'test', trigger: 'test', props: { plan: { kind: 'string' } } },
};
const config = { key: KEY, host: 'https://us.i.posthog.com', debug: false };

describe('server capture', () => {
  test('delivers a validated event to the PostHog capture API', async () => {
    const seen: { url: string; body: unknown }[] = [];
    const dest = createPostHogServerDestination(config, async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response('{"status":"Ok"}', { status: 200 });
    });
    const result = await sendServerEvent({ event: 'server_test', distinctId: 'usr_a', properties: { plan: 'ai' } }, [dest], {
      taxonomy: testTaxonomy, uuid: '0191c8a2-7d9e-7a1b-9c3d-2e4f5a6b7c8d', occurredAt: '2026-10-11T03:00:00Z',
    });
    expect(result).toEqual({ delivered: true, uuid: '0191c8a2-7d9e-7a1b-9c3d-2e4f5a6b7c8d', results: [{ destination: 'posthog', ok: true, status: 200 }] });
    expect(seen[0].url).toBe('https://us.i.posthog.com/i/v0/e/');
    expect(seen[0].body).toEqual({
      api_key: KEY, event: 'server_test', distinct_id: 'usr_a', uuid: '0191c8a2-7d9e-7a1b-9c3d-2e4f5a6b7c8d',
      timestamp: '2026-10-11T03:00:00.000Z',
      // No GeoIP from the server's egress IP; a member id still updates its person profile.
      properties: { plan: 'ai', event_version: 2, schema_version: 1, $lib: 'zuey-me-server', $geoip_disable: true },
    });

    await sendServerEvent({ event: 'server_test', distinctId: 'guest_0123456789abcdef01234567', properties: { plan: 'ai' } }, [dest], {
      taxonomy: testTaxonomy,
    });
    // A booking guest never creates a person profile.
    expect(seen[1].body).toMatchObject({ properties: { $geoip_disable: true, $process_person_profile: false } });
  });

  test('never throws on network errors', async () => {
    const dest = createPostHogServerDestination(config, async () => { throw new TypeError('fetch failed'); });
    const result = await sendServerEvent({ event: 'server_test', distinctId: 'usr_a', properties: { plan: 'ai' } }, [dest], { taxonomy: testTaxonomy });
    expect(result.delivered).toBe(false);
    expect(result.results[0]).toMatchObject({ ok: false, reason: 'network' });
  });

  test('reports HTTP failures', async () => {
    const dest = createPostHogServerDestination(config, async () => new Response('nope', { status: 500 }));
    const result = await sendServerEvent({ event: 'server_test', distinctId: 'usr_a', properties: { plan: 'ai' } }, [dest], { taxonomy: testTaxonomy });
    expect(result.results[0]).toEqual({ destination: 'posthog', ok: false, reason: 'http', status: 500 });
  });

  test('times out a hanging destination, even one that ignores the abort signal', async () => {
    const hanging: ServerDestination = { name: 'hang', send: () => new Promise(() => undefined) };
    const started = Date.now();
    const result = await sendServerEvent({ event: 'server_test', distinctId: 'usr_a', properties: { plan: 'ai' } }, [hanging], { taxonomy: testTaxonomy, timeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.results[0]).toEqual({ destination: 'hang', ok: false, reason: 'timeout' });
  });

  test('a destination that rejects is reported, not thrown', async () => {
    const rejecting: ServerDestination = { name: 'bad', send: () => Promise.reject(new Error('boom')) };
    const result = await sendServerEvent({ event: 'server_test', distinctId: 'usr_a', properties: { plan: 'ai' } }, [rejecting], { taxonomy: testTaxonomy });
    expect(result.results[0]).toMatchObject({ destination: 'bad', ok: false, reason: 'network' });
  });

  test('rejects emails as distinct ids, unknown properties and client events before sending', async () => {
    let sent = 0;
    const dest: ServerDestination = { name: 'count', send: async () => { sent += 1; return { destination: 'count', ok: true, status: 200 }; } };
    const asEmail = await sendServerEvent({ event: 'server_test', distinctId: 'duy@example.com', properties: { plan: 'ai' } }, [dest], { taxonomy: testTaxonomy });
    expect(asEmail.rejected).toEqual({ reason: 'invalid_distinct_id' });
    const extra = await sendServerEvent({ event: 'server_test', distinctId: 'usr_a', properties: { plan: 'ai', email: 'x' } }, [dest], { taxonomy: testTaxonomy });
    expect(extra.rejected).toMatchObject({ reason: 'unknown_property' });
    const client = await sendServerEvent({ event: 'social_clicked', distinctId: 'usr_a', properties: { platform: 'x' } }, [dest]);
    expect(client.rejected).toMatchObject({ reason: 'wrong_source' });
    expect(sent).toBe(0);
  });

  test('no destinations outside production unless debug is set', () => {
    expect(serverDestinations({ PUBLIC_POSTHOG_KEY: KEY }, { production: false, requestHost: 'zuey.me' })).toEqual([]);
    expect(serverDestinations({ PUBLIC_POSTHOG_KEY: KEY, PUBLIC_ANALYTICS_DEBUG: '1' }, { production: false, requestHost: 'localhost' }).map(d => d.name)).toEqual(['posthog']);
    expect(serverDestinations({}, { production: true, requestHost: 'zuey.me' }).map(d => d.name)).toEqual(['posthog']);
    expect(serverDestinations({}, { production: true, requestHost: 'WWW.ZUEY.ME' }).map(d => d.name)).toEqual(['posthog']);
  });

  test('a production build on a preview or unknown host never sends to the production project', () => {
    // Previews are production builds with the production key from wrangler.toml and the same database.
    const prodEnv = { PUBLIC_POSTHOG_KEY: KEY };
    for (const host of ['feat-x.zuey-me.pages.dev', 'zuey-me.pages.dev', 'zuey.me.evil.com', 'localhost', null]) {
      expect(isServerCaptureHost(prodEnv, host)).toBe(false);
      expect(serverDestinations(prodEnv, { production: true, requestHost: host })).toEqual([]);
    }
    expect(isServerCaptureHost({ ...prodEnv, PUBLIC_ANALYTICS_DEBUG: '1' }, 'feat-x.zuey-me.pages.dev')).toBe(true);
  });

  test('captureServerEvent without a production request host sends nothing', async () => {
    const result = await captureServerEvent({ PUBLIC_POSTHOG_KEY: KEY }, 'login', 'usr_a', { method: 'magic_link' }, { requestHost: 'x.pages.dev' });
    expect(result.delivered).toBe(false);
    expect(result.results).toEqual([{ destination: 'none', ok: false, reason: 'disabled' }]);
  });
});

describe('private pages and identifiers', () => {
  const paypalReturn = 'https://zuey.me/booking/bk_8f2a91c3?manage=mt_7d1e2f3a4b5c6d7e8f9a&paypal=return&token=5O190127TN364715T&PayerID=QYR5Z8XDVJNXQ';

  test('the PayPal booking return URL loses the manage token and PayPal parameters everywhere', () => {
    const out = scrubCaptureResult({
      event: '$pageview',
      properties: {
        $current_url: paypalReturn,
        $pathname: '/booking/bk_8f2a91c3',
        $referrer: 'https://www.paypal.com/checkoutnow?token=5O190127TN364715T',
        title: 'Booking ZB-4821 — zuey.me',
      },
      $set_once: { $initial_current_url: paypalReturn, $initial_pathname: '/booking/bk_8f2a91c3' },
    });
    const text = JSON.stringify(out);
    for (const secret of ['mt_7d1e2f3a4b5c6d7e8f9a', '5O190127TN364715T', 'QYR5Z8XDVJNXQ', 'bk_8f2a91c3', 'ZB-4821']) {
      expect(text).not.toContain(secret);
    }
    expect(out?.properties).toEqual({
      $current_url: 'https://zuey.me/booking/:id',
      $pathname: '/booking/:id',
      $referrer: 'https://www.paypal.com/checkoutnow',
      title: '',
    });
    expect(out?.$set_once).toEqual({ $initial_current_url: 'https://zuey.me/booking/:id', $initial_pathname: '/booking/:id' });
  });

  test('the manage and PayerID parameters are stripped on any page', () => {
    expect(scrubUrl('https://zuey.me/articles?manage=abc&PayerID=Q1&ref=x')).toBe('https://zuey.me/articles?ref=x');
  });

  test('order codes (the SePay transfer memo) are templated in paths and referrers', () => {
    expect(scrubUrl('https://zuey.me/billing/ZM8K2Q4?x=1')).toBe('https://zuey.me/billing/:code');
    expect(scrubUrl('https://zuey.me/billing/card/cs_123abc')).toBe('https://zuey.me/billing/card/:id');
    expect(scrubUrl('/courses/orders/ZSC9X7Y')).toBe('/courses/orders/:code');
    expect(scrubUrl('https://zuey.me/account?tab=billing#x')).toBe('https://zuey.me/account');
    expect(scrubUrl('https://zuey.me/pricing?plan=ai')).toBe('https://zuey.me/pricing?plan=ai');
    const out = scrubCaptureResult({ properties: { $current_url: 'https://zuey.me/pricing', $referrer: 'https://zuey.me/billing/ZM8K2Q4', title: 'Pricing' } });
    expect(out?.properties).toEqual({ $current_url: 'https://zuey.me/pricing', $referrer: 'https://zuey.me/billing/:code', title: 'Pricing' });
  });
});

describe('identity across tabs and redirects', () => {
  test('a tab cache from before a sign-out in another tab does not re-identify the old member', async () => {
    const browser = { local: new MemoryStorage(), posthog: { distinctId: 'anon-0' } };
    const tabA = fakeClient({ fetchIdentity: async () => ({ data: { member_id: 'usr_a' } }) }, undefined, browser);
    tabA.client.activate(false);
    await tabA.client.syncIdentity('/articles');
    expect(browser.posthog.distinctId).toBe('usr_a');

    // Tab B signs out: reset clears the shared identity key, and the session cookie is gone.
    const tabB = fakeClient({}, undefined, browser);
    tabB.client.reset();

    // Tab A navigates again with its own (stale) sessionStorage cache still saying usr_a.
    let fetched = 0;
    const tabA2 = fakeClient({ fetchIdentity: async () => { fetched += 1; return { data: { member_id: null } }; } }, undefined, browser);
    tabA2.session.setItem(IDENTITY_CACHE_KEY, tabA.session.getItem(IDENTITY_CACHE_KEY) ?? '');
    tabA2.client.activate(false);
    await tabA2.client.syncIdentity('/articles');
    expect(fetched).toBe(1);
    expect(tabA2.calls.filter(c => c.method === 'identify')).toEqual([]);
    expect(browser.posthog.distinctId).not.toBe('usr_a');
  });

  test('auth pages drop the tab cache so the sign-in redirect identifies at once', async () => {
    let member: string | null = null;
    const { client, session, calls } = fakeClient({ fetchIdentity: async () => ({ data: { member_id: member } }) });
    client.activate(false);
    await client.syncIdentity('/articles');
    expect(JSON.parse(session.getItem(IDENTITY_CACHE_KEY) ?? '{}')).toMatchObject({ memberId: null });
    await client.syncIdentity('/login');
    expect(session.getItem(IDENTITY_CACHE_KEY)).toBeNull();
    member = 'usr_a';
    await client.syncIdentity('/articles');
    expect(calls).toEqual([{ method: 'identify', args: ['usr_a'] }]);
  });

  test('an anonymous answer is cached only briefly', () => {
    expect(parseIdentityCache(JSON.stringify({ memberId: null, at: 0 }), 60 * 1000)).toEqual({ memberId: null, at: 0 });
    expect(parseIdentityCache(JSON.stringify({ memberId: null, at: 0 }), 3 * 60 * 1000)).toBeNull();
    expect(parseIdentityCache(JSON.stringify({ memberId: 'usr_a', at: 0 }), 3 * 60 * 1000)).toEqual({ memberId: 'usr_a', at: 0 });
  });

  test('identify re-runs when PostHog lost the member even if the local key still has it', () => {
    const browser = { local: new MemoryStorage(), posthog: { distinctId: 'anon-9' } };
    browser.local.setItem(IDENTITY_STORAGE_KEY, 'usr_a');
    const { client, calls } = fakeClient({}, undefined, browser);
    client.activate(false);
    client.identify('usr_a');
    expect(calls).toEqual([{ method: 'identify', args: ['usr_a'] }]);
  });
});

describe('blocked storage', () => {
  const throws = (): never => { throw new DOMException('The operation is insecure.', 'SecurityError'); };

  test('reports storage_blocked and cannot record a choice', () => {
    const env: ConsentEnvironment = { navigator: {}, storage: BLOCKED_STORAGE };
    expect(consentState(env)).toBe('storage_blocked');
    expect(setOptOut(false, env)).toBe(false);
    expect(setOptOut(true, env)).toBe(false);
  });

  test('a localStorage getter that throws resolves to blocked storage', () => {
    const storage = resolveConsentStorage(throws);
    expect(storage).toBe(BLOCKED_STORAGE);
    expect(consentState({ navigator: {}, storage })).toBe('storage_blocked');
  });

  test('storage that reads but refuses writes resolves to blocked storage', () => {
    const readOnly = new MemoryStorage();
    readOnly.setItem = throws;
    expect(resolveConsentStorage(() => readOnly)).toBe(BLOCKED_STORAGE);
  });

  test('working storage passes the probe and keeps no probe key behind', () => {
    const storage = new MemoryStorage();
    expect(resolveConsentStorage(() => storage)).toBe(storage);
    expect(storage.getItem(STORAGE_PROBE_KEY)).toBeNull();
    expect(resolveConsentStorage(() => undefined)).toBeNull();
  });

  test('the privacy control hides the toggle when storage is blocked or DNT is on', () => {
    expect(consentControlView('storage_blocked')).toEqual({ status: 'storageOff', toggle: null });
    expect(consentControlView('do_not_track')).toEqual({ status: 'dnt', toggle: null });
    expect(consentControlView('opted_out')).toEqual({ status: 'optedOut', toggle: 'optIn' });
    expect(consentControlView('granted')).toEqual({ status: 'granted', toggle: 'optOut' });
  });

  test('the browser client stays silent and opt-in reports storage_blocked', () => {
    const { client, calls } = fakeClient({}, { navigator: {}, storage: BLOCKED_STORAGE });
    client.activate(false);
    expect(client.isActive()).toBe(false);
    client.track('social_clicked', { platform: 'github' });
    expect(client.optIn()).toBe('storage_blocked');
    expect(calls.filter(c => c.method === 'capture' || c.method === 'optIn')).toEqual([]);
  });
});

describe('privacy page consent copy', () => {
  test('both languages carry the blocked-storage status text', async () => {
    const source = await Bun.file(new URL('../src/pages/privacy.astro', import.meta.url)).text();
    expect(source.match(/storageOff: '/g)?.length).toBe(2);
    expect(source).toContain('data-storage-off={c.analytics.storageOff}');
    // `inline-flex` would otherwise override the `hidden` attribute and leave an empty button on screen.
    expect(source).toContain('inline-flex items-center [&[hidden]]:hidden');
  });
});

describe('privacy page third-party processors', () => {
  const read = (rel: string) => Bun.file(new URL(rel, import.meta.url)).text();

  /** The `processors: [...]` rows of each language, as source text. */
  async function processorRows(): Promise<Record<'vi' | 'en', string>> {
    const source = await read('../src/pages/privacy.astro');
    const [vi, en] = source.split('\n  en: {');
    const rows = (block: string) => block.slice(block.indexOf('    processors: ['), block.indexOf('    processorsNote:'));
    return { vi: rows(vi), en: rows(en) };
  }

  test('every embeddable provider is listed in both languages', async () => {
    const rows = await processorRows();
    const providers = Object.entries(PROVIDER_LABELS).filter(([id]) => id !== 'generic').map(([, label]) => label);
    expect(providers.length).toBe(9);
    for (const lang of ['vi', 'en'] as const) {
      const names = [...rows[lang].matchAll(/name: '([^']+)'/g)].map(m => m[1]).join(' | ');
      for (const label of providers) expect(names).toContain(label);
      expect(rows[lang]).toContain('youtube-nocookie.com, i.ytimg.com');
    }
  });

  test('jsDelivr is listed in both languages because /docs loads Scalar from it', async () => {
    const docs = await read('../src/pages/docs/index.astro');
    expect(docs).toContain('https://cdn.jsdelivr.net/');
    const rows = await processorRows();
    expect(rows.vi).toMatch(/name: 'jsDelivr', purpose: '[^']*\/docs[^']*', data: '[^']*IP/);
    expect(rows.en).toMatch(/name: 'jsDelivr', purpose: '[^']*\/docs[^']*', data: '[^']*IP/);
  });

  /** Each language's whole copy block (sections, analytics text and processors), as source text. */
  async function languageBlocks(): Promise<Record<'vi' | 'en', string>> {
    const [vi, en] = (await read('../src/pages/privacy.astro')).split('\n  en: {');
    return { vi, en };
  }

  test('Cloudflare discloses Workers AI, the search query and members-only articles in both languages', async () => {
    const indexer = await read('../src/lib/search/indexer.ts');
    expect(indexer).toContain("tier: 'full'");
    expect(indexer).toContain('embedTexts(backend.ai');
    const rows = await processorRows();
    expect(rows.vi).toMatch(/name: 'Cloudflare', purpose: '[^']*Workers AI[^']*', data: '[^']*nội dung từ khoá tìm kiếm \(tối đa 200 ký tự[^']*nội dung đã xuất bản \(kể cả bài viết dành cho thành viên\)/);
    expect(rows.en).toMatch(/name: 'Cloudflare', purpose: '[^']*Workers AI[^']*', data: '[^']*search query text \(up to 200 characters[^']*published content \(including members-only articles\)/);
    expect(rows.vi).not.toContain('chữ của từ khoá');
  });

  test('Cloudflare discloses Stream lesson videos and their signed links in both languages', async () => {
    const signing = await read('../src/lib/courses/course-media-signing.ts');
    expect(signing).toContain('.cloudflarestream.com/');
    expect(signing).toContain('MEDIA_TOKEN_MIN_TTL_SECONDS = 10 * 60');
    expect(signing).toContain('MEDIA_TOKEN_MAX_TTL_SECONDS = 4 * 60 * 60');
    const lesson = await read('../src/pages/courses/[slug]/[lesson].astro');
    expect(lesson).toContain("'Referrer-Policy', 'no-referrer'");
    const rows = await processorRows();
    expect(rows.vi).toMatch(/name: 'Cloudflare', purpose: '[^']*Cloudflare Stream phát video bài học[^']*', data: '[^']*link Stream ký riêng hết hạn sau ít nhất 10 phút và tối đa 4 giờ[^']*gửi địa chỉ IP và user agent trực tiếp tới cloudflarestream\.com/);
    expect(rows.en).toMatch(/name: 'Cloudflare', purpose: '[^']*Cloudflare Stream plays course lesson videos[^']*', data: '[^']*signed Stream link that expires after 10 minutes to 4 hours[^']*IP address and user agent directly to cloudflarestream\.com/);
  });

  test('blocks that load from any https host are disclosed in both languages', async () => {
    const validate = await read('../src/lib/blocks/validate.ts');
    expect(validate).toContain("protocol === 'https:'");
    const rows = await processorRows();
    expect(rows.vi).toMatch(/name: 'Máy chủ ảnh, media và tệp do tác giả chọn', purpose: '[^']*https:\/\/[^']*', data: '[^']*Địa chỉ IP và user agent/);
    expect(rows.en).toMatch(/name: 'Image, media and file hosts chosen by the author', purpose: '[^']*https:\/\/[^']*', data: '[^']*IP address and user agent/);
    const copy = await languageBlocks();
    expect(copy.vi).toContain('có thể trỏ tới bất kỳ địa chỉ https:// nào do tác giả chọn');
    expect(copy.en).toContain('can point to any https:// address the author chooses');
  });

  test('OpenRouter is listed as the transcript rewriter with no visitor data, and Workers AI only as its fallback', async () => {
    const providers = await read('../src/lib/videos/video-transcript-rewrite-providers.ts');
    expect(providers).toContain('https://openrouter.ai/api/v1/chat/completions');
    const ingest = await read('../src/lib/videos/video-ingest-service.ts');
    expect(ingest.indexOf('openRouterRewriter(')).toBeLessThan(ingest.indexOf('workersAiRewriter('));
    const rows = await processorRows();
    expect(rows.vi).toMatch(/name: 'OpenRouter', purpose: '[^']*phụ đề[^']*', data: 'Chỉ phụ đề công khai[^']*không có dữ liệu của người xem'/);
    expect(rows.en).toMatch(/name: 'OpenRouter', purpose: '[^']*transcripts[^']*', data: 'Only the public video transcript[^']*no visitor data'/);
    expect(rows.vi).toMatch(/name: 'Cloudflare', purpose: '[^']*phụ đề Zueytube khi OpenRouter không được cấu hình hoặc bị lỗi/);
    expect(rows.en).toMatch(/name: 'Cloudflare', purpose: '[^']*Zueytube transcripts only when OpenRouter is not configured or fails/);
  });

  test('SePay discloses the qr.sepay.vn image in both languages', async () => {
    expect(await read('../src/lib/payments/sepay.ts')).toContain('https://qr.sepay.vn/img?');
    const rows = await processorRows();
    expect(rows.vi).toMatch(/name: 'SePay', purpose: '[^']*', data: '[^']*qr\.sepay\.vn/);
    expect(rows.en).toMatch(/name: 'SePay', purpose: '[^']*', data: '[^']*qr\.sepay\.vn/);
  });

  test('the server-side analytics disclosure stays in both languages', async () => {
    const rows = await processorRows();
    expect(rows.vi).toMatch(/name: 'PostHog', purpose: '[^']*', data: '[^']*sự kiện tài khoản, mua hàng từ máy chủ[^']*\(không có email hay tên\)'/);
    expect(rows.en).toMatch(/name: 'PostHog', purpose: '[^']*', data: '[^']*server-side account and purchase events[^']*\(no email or name\)'/);
    const copy = await languageBlocks();
    expect(copy.vi).toContain('các sự kiện này vẫn được gửi kể cả khi bạn tắt analytics trên trình duyệt');
    expect(copy.en).toContain('they are sent even when browser analytics is off');
  });
});

describe('PostHog snippet stub', () => {
  /** Mirrors the official loader snippet: before init() the array stub only has `init` and `__SV`. */
  function snippetStub() {
    const stub = Object.assign([] as unknown[], { __SV: 1, _i: [] as unknown[] });
    Reflect.set(stub, 'init', (key: string, config: Record<string, unknown>) => {
      for (const method of ['capture', 'identify', 'reset', 'opt_out_capturing', 'opt_in_capturing']) {
        Reflect.set(stub, method, (...args: unknown[]) => { stub.push([method, ...args]); });
      }
      stub._i.push([key, config]);
    });
    return stub;
  }

  function withWindow<T>(posthog: unknown, run: () => T): T {
    const hadWindow = 'window' in globalThis;
    const previous: unknown = Reflect.get(globalThis, 'window');
    Reflect.set(globalThis, 'window', { posthog });
    try {
      return run();
    } finally {
      if (hadWindow) Reflect.set(globalThis, 'window', previous);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  }

  test('the pre-init stub is accepted so boot can call init()', () => {
    const stub = snippetStub();
    withWindow(stub, () => {
      const ph = getPostHog();
      expect(ph).not.toBeNull();
      postHogClientDestination.capture('before_init', {});
      expect(stub.length).toBe(0);
      ph?.init('phc_test', { api_host: 'https://us.i.posthog.com' });
      postHogClientDestination.capture('after_init', { a: 1 });
      postHogClientDestination.identify('mem_1');
      expect([...stub]).toEqual([['capture', 'after_init', { a: 1 }], ['identify', 'mem_1']]);
      expect(stub._i.length).toBe(1);
    });
  });

  test('values without an init function are rejected', () => {
    for (const value of [null, undefined, 'posthog', {}, [], { capture: () => undefined }]) {
      withWindow(value, () => expect(getPostHog()).toBeNull());
    }
  });
});
