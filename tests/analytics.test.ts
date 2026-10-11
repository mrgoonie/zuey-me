import { describe, expect, test } from 'bun:test';
import { createAnalyticsClient, isLocalHostname, shouldCaptureOn, type AnalyticsClientDeps } from '../src/lib/analytics/client';
import { OPT_OUT_STORAGE_KEY, consentState, setOptOut, type ConsentEnvironment } from '../src/lib/analytics/consent';
import {
  DEFAULT_POSTHOG_KEY, createPostHogServerDestination, isSensitivePath, resolvePostHogConfig, scrubCaptureResult,
} from '../src/lib/analytics/destinations/posthog';
import type { ClientDestination, ServerDestination } from '../src/lib/analytics/destinations/types';
import { validateEvent, type Taxonomy } from '../src/lib/analytics/events';
import {
  IDENTITY_CACHE_KEY, IDENTITY_STORAGE_KEY, isValidDistinctId, parseIdentityCache, parseIdentityResponse, planIdentity,
} from '../src/lib/analytics/identity';
import { REDACTED, containsPii, redactString, scrubUrl, scrubValue } from '../src/lib/analytics/pii';
import { sendServerEvent, serverDestinations } from '../src/lib/analytics/server';

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
    expect(scrubUrl('https://zuey.me/login/verify?token=abc123&next=%2Faccount')).toBe('https://zuey.me/login/verify?next=%2Faccount');
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

  test('blocked storage is treated as opted out', () => {
    const throwing = { getItem: (): string | null => { throw new Error('blocked'); }, setItem: () => undefined, removeItem: () => undefined };
    expect(consentState(env({ storage: throwing }))).toBe('opted_out');
  });
});

interface Call { method: string; args: unknown[] }

function fakeClient(over: Partial<AnalyticsClientDeps> = {}, consent: ConsentEnvironment = { navigator: {}, storage: new MemoryStorage() }) {
  const calls: Call[] = [];
  const dest: ClientDestination = {
    name: 'fake',
    capture: (...args) => { calls.push({ method: 'capture', args }); },
    identify: (...args) => { calls.push({ method: 'identify', args }); },
    reset: () => { calls.push({ method: 'reset', args: [] }); },
    optOut: () => { calls.push({ method: 'optOut', args: [] }); },
    optIn: () => { calls.push({ method: 'optIn', args: [] }); },
  };
  const local = new MemoryStorage();
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
      destinations: [{ name: 'broken', capture: () => { throw new Error('boom'); }, identify: () => undefined, reset: () => undefined, optOut: () => undefined, optIn: () => undefined }],
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
    expect(isLocalHostname('localhost')).toBe(true);
    expect(isLocalHostname('127.0.0.1')).toBe(true);
    expect(isLocalHostname('zuey.me')).toBe(false);
    expect(shouldCaptureOn('zuey.me', config, false)).toBe(true);
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
      properties: { plan: 'ai', event_version: 2, schema_version: 1, $lib: 'zuey-me-server' },
    });
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
    expect(serverDestinations({ PUBLIC_POSTHOG_KEY: KEY }, { production: false })).toEqual([]);
    expect(serverDestinations({ PUBLIC_POSTHOG_KEY: KEY, PUBLIC_ANALYTICS_DEBUG: '1' }, { production: false }).map(d => d.name)).toEqual(['posthog']);
    expect(serverDestinations({}, { production: true }).map(d => d.name)).toEqual(['posthog']);
  });
});
