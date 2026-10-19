/**
 * Browser analytics API: typed `track()`, `identify()`, `reset()`, opt-out/opt-in and the boot step
 * run from the layout. Nothing here ever throws into the caller; when consent is missing, the
 * environment is local/dev, or PostHog failed to load, every call is a silent no-op.
 */
import {
  ATTRIBUTION_STORAGE_KEY, attributionProperties, parseAttribution, parseStoredAttribution, type Attribution,
} from './attribution';
import { CONFIG_ELEMENT_ID, PRODUCTION_HOSTNAMES } from './constants';
import { PERFORMANCE_CAPTURE_OPTIONS } from './engagement';
import { browserConsentEnvironment, consentState, setOptOut, type ConsentEnvironment, type ConsentState } from './consent';
import {
  getPostHog, postHogClientDestination, postHogInitOptions, resolvePostHogConfig, type PostHogConfig,
} from './destinations/posthog';
import type { ClientDestination } from './destinations/types';
import {
  ANALYTICS_SCHEMA_VERSION, validateEvent, type ClientEventName, type EventProperties,
} from './events';
import {
  IDENTITY_CACHE_KEY, IDENTITY_ENDPOINT, IDENTITY_STORAGE_KEY, isAuthPath, isValidDistinctId,
  parseIdentityCache, parseIdentityResponse, planIdentity,
} from './identity';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Injectable browser surface so the client can be exercised without a DOM. */
export interface AnalyticsClientDeps {
  destinations: ClientDestination[];
  consent: () => ConsentEnvironment;
  local: () => StorageLike | null;
  session: () => StorageLike | null;
  fetchIdentity: () => Promise<unknown>;
  now: () => number;
  debug: (message: string, detail?: unknown) => void;
  /** The landing page this session's attribution is read from (absent: no attribution). */
  page?: () => PageContext | null;
}

export interface PageContext {
  search: string;
  referrer: string;
  hostname: string;
}

/** Events tracked before the boot step decided whether analytics runs on this page (islands may hydrate first). */
export const MAX_PENDING_EVENTS = 50;

export interface AnalyticsClient {
  /**
   * Marks the client live (consent and environment already checked by the caller), records this session's
   * attribution and sends the events tracked while the boot step was still pending.
   */
  activate(debug: boolean): void;
  /** The boot step decided analytics stays off on this page: drop the pending events, queue no more. */
  settle(): void;
  isActive(): boolean;
  track<E extends ClientEventName>(event: E, properties: EventProperties<E>): void;
  /** `track()` at most once per page load for `key` (mount effects re-run under StrictMode and remounts). */
  trackOnce<E extends ClientEventName>(key: string, event: E, properties: EventProperties<E>): void;
  identify(memberId: string): void;
  reset(): void;
  /** Aligns the identified member with the server session (identify, reset, or both). */
  syncIdentity(pathname: string): Promise<void>;
  optOut(): void;
  optIn(): ConsentState;
}

function read(storage: StorageLike | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: StorageLike | null, key: string, value: string | null): void {
  try {
    if (!storage) return;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // Storage full or blocked: identity simply re-syncs on the next page.
  }
}

export function createAnalyticsClient(deps: AnalyticsClientDeps): AnalyticsClient {
  let active = false;
  let debug = false;
  // Until activate() or settle(), events wait here: a component may mount before the layout's boot script runs.
  let decided = false;
  let pending: Array<{ event: string; properties: unknown }> = [];
  const once = new Set<string>();
  let attribution: Attribution | null = null;

  const each = (run: (d: ClientDestination) => void): void => {
    for (const d of deps.destinations) {
      try {
        run(d);
      } catch (err) {
        deps.debug(`analytics: ${d.name} failed`, err instanceof Error ? err.message : err);
      }
    }
  };
  const granted = (): boolean => consentState(deps.consent()) === 'granted';
  const live = (): boolean => active && granted();
  // posthog-js reset() also clears its own opt-out: re-apply it so a reset never resumes capture.
  const resetDestinations = (): void => {
    each(d => d.reset());
    if (!granted()) each(d => d.optOut());
  };

  // First tracked page of the tab session wins; later pages reuse it (also when it is empty: a direct visit).
  const loadAttribution = (): Attribution | null => {
    const stored = parseStoredAttribution(read(deps.session(), ATTRIBUTION_STORAGE_KEY));
    if (stored) return stored;
    const page = deps.page?.() ?? null;
    if (!page) return null;
    const fresh = parseAttribution(page.search, page.referrer, page.hostname);
    write(deps.session(), ATTRIBUTION_STORAGE_KEY, JSON.stringify(fresh));
    return fresh;
  };

  const send = (event: string, properties: unknown): void => {
    if (!live()) return;
    const checked = validateEvent(event, properties, 'client');
    if (!checked.ok) {
      deps.debug('analytics: event rejected', checked.error);
      return;
    }
    const props = {
      ...checked.properties, ...attributionProperties(attribution),
      event_version: checked.version, schema_version: ANALYTICS_SCHEMA_VERSION,
    };
    if (debug) deps.debug(`analytics: ${event}`, props);
    each(d => d.capture(event, props));
  };

  const client: AnalyticsClient = {
    activate(on) {
      active = true;
      debug = on;
      decided = true;
      try {
        if (granted()) attribution = loadAttribution();
      } catch {
        attribution = null;
      }
      const queued = pending;
      pending = [];
      for (const item of queued) {
        try {
          send(item.event, item.properties);
        } catch (err) {
          deps.debug('analytics: track failed', err instanceof Error ? err.message : err);
        }
      }
    },
    settle() {
      decided = true;
      pending = [];
    },
    isActive: live,
    track(event, properties) {
      try {
        if (!decided) {
          if (pending.length < MAX_PENDING_EVENTS) pending.push({ event, properties });
          return;
        }
        send(event, properties);
      } catch (err) {
        deps.debug('analytics: track failed', err instanceof Error ? err.message : err);
      }
    },
    trackOnce(key, event, properties) {
      if (once.has(key)) return;
      once.add(key);
      client.track(event, properties);
    },
    identify(memberId) {
      try {
        if (!live()) return;
        if (!isValidDistinctId(memberId)) {
          deps.debug('analytics: identify rejected a value that is not a member id');
          return;
        }
        const previous = read(deps.local(), IDENTITY_STORAGE_KEY);
        // Only the destinations know whether they already attribute events to this member.
        if (deps.destinations.length > 0 && deps.destinations.every(d => d.distinctId() === memberId)) {
          if (previous !== memberId) write(deps.local(), IDENTITY_STORAGE_KEY, memberId);
          return;
        }
        // Never let a second person inherit the first one's identity on a shared device.
        if (previous !== null && previous !== memberId) resetDestinations();
        each(d => d.identify(memberId));
        write(deps.local(), IDENTITY_STORAGE_KEY, memberId);
      } catch (err) {
        deps.debug('analytics: identify failed', err instanceof Error ? err.message : err);
      }
    },
    reset() {
      try {
        write(deps.local(), IDENTITY_STORAGE_KEY, null);
        write(deps.session(), IDENTITY_CACHE_KEY, null);
        // Reset even when inactive: a sign-out must never leave the previous member attached.
        resetDestinations();
      } catch (err) {
        deps.debug('analytics: reset failed', err instanceof Error ? err.message : err);
      }
    },
    async syncIdentity(pathname) {
      try {
        if (!live()) return;
        const now = deps.now();
        const authPage = isAuthPath(pathname);
        // The member may have just changed on sign-in pages: never answer from (or keep) the tab cache there.
        if (authPage) write(deps.session(), IDENTITY_CACHE_KEY, null);
        const previous = read(deps.local(), IDENTITY_STORAGE_KEY);
        const cached = authPage ? null : parseIdentityCache(read(deps.session(), IDENTITY_CACHE_KEY), now);
        let current: string | null;
        // sessionStorage is per tab while the identity key is shared by all tabs: another tab may have
        // signed out or in since this tab cached its answer, so the cache counts only while both agree.
        if (cached && cached.memberId === previous) {
          current = cached.memberId;
        } else {
          const fetched = parseIdentityResponse(await deps.fetchIdentity());
          // Unknown (network error, odd response): leave the identity as it is.
          if (fetched === undefined) return;
          current = fetched;
          if (!authPage) write(deps.session(), IDENTITY_CACHE_KEY, JSON.stringify({ memberId: current, at: now }));
        }
        if (planIdentity(previous, current).includes('reset')) {
          write(deps.local(), IDENTITY_STORAGE_KEY, null);
          resetDestinations();
        }
        // identify() is a no-op when the destinations already attribute events to this member.
        if (current !== null) client.identify(current);
      } catch (err) {
        deps.debug('analytics: identity sync failed', err instanceof Error ? err.message : err);
      }
    },
    optOut() {
      setOptOut(true, deps.consent());
      pending = [];
      attribution = null;
      write(deps.session(), ATTRIBUTION_STORAGE_KEY, null);
      // reset() opts the destinations out last (posthog-js reset() clears its own opt-out), which also
      // orders the calls the snippet queues while array.js is still loading.
      client.reset();
      // No storage to hold the choice (consent still reads granted): opt this page out anyway.
      if (granted()) each(d => d.optOut());
    },
    optIn() {
      setOptOut(false, deps.consent());
      const state = consentState(deps.consent());
      if (state === 'granted' && active) each(d => d.optIn());
      return state;
    },
  };
  return client;
}

function safeSessionStorage(): StorageLike | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function safeLocalStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

async function fetchIdentityFromServer(): Promise<unknown> {
  try {
    const res = await fetch(IDENTITY_ENDPOINT, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

const browserClient = createAnalyticsClient({
  destinations: [postHogClientDestination],
  consent: browserConsentEnvironment,
  local: safeLocalStorage,
  session: safeSessionStorage,
  fetchIdentity: fetchIdentityFromServer,
  now: () => Date.now(),
  debug: (message, detail) => console.debug(message, detail ?? ''),
  page: () => (typeof window === 'undefined' ? null : {
    search: window.location.search,
    referrer: typeof document === 'undefined' ? '' : document.referrer,
    hostname: window.location.hostname,
  }),
});

/** Sends a taxonomy event from the browser. Unknown properties or PII drop the event. */
export function track<E extends ClientEventName>(event: E, properties: EventProperties<E>): void {
  browserClient.track(event, properties);
}

/**
 * Sends an event at most once per page load for `key`: use it in mount effects, which React runs twice
 * under StrictMode and again on every remount.
 */
export function trackOnce<E extends ClientEventName>(key: string, event: E, properties: EventProperties<E>): void {
  browserClient.trackOnce(key, event, properties);
}

/** Links this browser to a verified member id. Emails, names and other non-id values are refused. */
export function identify(memberId: string): void {
  browserClient.identify(memberId);
}

/** Forgets the identified member (call on sign-out and account deletion). */
export function reset(): void {
  browserClient.reset();
}

/**
 * Call once the server ended a member session: sends `logout` while this browser is still identified as
 * the member (so it joins their funnel), then forgets the identity.
 */
export function signOutAnalytics(surface: 'account'): void {
  browserClient.track('logout', { surface });
  browserClient.reset();
}

export function optOut(): void {
  browserClient.optOut();
}

/** Clears the local opt-out. Returns the resulting state (still `do_not_track` when DNT/GPC is on). */
export function optIn(): ConsentState {
  const state = browserClient.optIn();
  if (state === 'granted' && !browserClient.isActive()) {
    bootAnalytics();
    // posthog-js persisted the earlier opt-out itself; lift it now that PostHog is loaded again.
    if (browserClient.isActive()) postHogClientDestination.optIn();
  }
  return state;
}

export function currentConsent(): ConsentState {
  return consentState(browserConsentEnvironment());
}

/**
 * Capture only on the production hostnames in production builds, unless PUBLIC_ANALYTICS_DEBUG is set.
 * Localhost, `*.pages.dev` previews and any other host stay silent even though they share the key.
 */
export function shouldCaptureOn(hostname: string, config: PostHogConfig, devBuild: boolean): boolean {
  if (config.debug) return true;
  return !devBuild && PRODUCTION_HOSTNAMES.includes(hostname.toLowerCase());
}

function readConfig(): PostHogConfig | null {
  const el = document.getElementById(CONFIG_ELEMENT_ID);
  if (!el) return null;
  return resolvePostHogConfig({
    PUBLIC_POSTHOG_KEY: el.getAttribute('data-key') ?? undefined,
    PUBLIC_POSTHOG_HOST: el.getAttribute('data-host') ?? undefined,
    PUBLIC_ANALYTICS_DEBUG: el.getAttribute('data-debug') ?? undefined,
  }, { production: false });
}

/**
 * Initialises PostHog from the layout's config element when the environment and consent allow it,
 * then aligns the identity with the member session. Safe to call more than once.
 */
export function bootAnalytics(): void {
  try {
    if (typeof window === 'undefined' || browserClient.isActive()) return;
    const config = readConfig();
    if (!config) return;
    const devBuild = import.meta.env.DEV === true;
    if (!shouldCaptureOn(window.location.hostname, config, devBuild)) return;
    if (consentState(browserConsentEnvironment()) !== 'granted') return;
    const ph = getPostHog();
    if (!ph) return;
    ph.init(config.key, { ...postHogInitOptions(config, window.location.pathname), ...PERFORMANCE_CAPTURE_OPTIONS });
    browserClient.activate(config.debug);
    void browserClient.syncIdentity(window.location.pathname);
  } catch (err) {
    console.debug('analytics: boot failed', err instanceof Error ? err.message : 'unknown');
  } finally {
    // Analytics stays off on this page: events queued by components that mounted first are dropped.
    if (typeof window !== 'undefined' && !browserClient.isActive()) browserClient.settle();
  }
}
