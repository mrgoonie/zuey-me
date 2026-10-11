/**
 * Browser analytics API: typed `track()`, `identify()`, `reset()`, opt-out/opt-in and the boot step
 * run from the layout. Nothing here ever throws into the caller; when consent is missing, the
 * environment is local/dev, or PostHog failed to load, every call is a silent no-op.
 */
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
}

export interface AnalyticsClient {
  /** Marks the client live (consent and environment already checked by the caller). */
  activate(debug: boolean): void;
  isActive(): boolean;
  track<E extends ClientEventName>(event: E, properties: EventProperties<E>): void;
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

  const each = (run: (d: ClientDestination) => void): void => {
    for (const d of deps.destinations) {
      try {
        run(d);
      } catch (err) {
        deps.debug(`analytics: ${d.name} failed`, err instanceof Error ? err.message : err);
      }
    }
  };
  const live = (): boolean => active && consentState(deps.consent()) === 'granted';

  const client: AnalyticsClient = {
    activate(on) {
      active = true;
      debug = on;
    },
    isActive: live,
    track(event, properties) {
      try {
        if (!live()) return;
        const checked = validateEvent(event, properties, 'client');
        if (!checked.ok) {
          deps.debug('analytics: event rejected', checked.error);
          return;
        }
        const props = { ...checked.properties, event_version: checked.version, schema_version: ANALYTICS_SCHEMA_VERSION };
        if (debug) deps.debug(`analytics: ${event}`, props);
        each(d => d.capture(event, props));
      } catch (err) {
        deps.debug('analytics: track failed', err instanceof Error ? err.message : err);
      }
    },
    identify(memberId) {
      try {
        if (!live()) return;
        if (!isValidDistinctId(memberId)) {
          deps.debug('analytics: identify rejected a value that is not a member id');
          return;
        }
        const previous = read(deps.local(), IDENTITY_STORAGE_KEY);
        if (previous === memberId) return;
        // Never let a second person inherit the first one's identity on a shared device.
        if (previous !== null) each(d => d.reset());
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
        each(d => d.reset());
      } catch (err) {
        deps.debug('analytics: reset failed', err instanceof Error ? err.message : err);
      }
    },
    async syncIdentity(pathname) {
      try {
        if (!live()) return;
        const now = deps.now();
        const cached = isAuthPath(pathname) ? null : parseIdentityCache(read(deps.session(), IDENTITY_CACHE_KEY), now);
        let current: string | null;
        if (cached) {
          current = cached.memberId;
        } else {
          const fetched = parseIdentityResponse(await deps.fetchIdentity());
          // Unknown (network error, odd response): leave the identity as it is.
          if (fetched === undefined) return;
          current = fetched;
          write(deps.session(), IDENTITY_CACHE_KEY, JSON.stringify({ memberId: current, at: now }));
        }
        const previous = read(deps.local(), IDENTITY_STORAGE_KEY);
        for (const step of planIdentity(previous, current)) {
          if (step === 'reset') {
            write(deps.local(), IDENTITY_STORAGE_KEY, null);
            each(d => d.reset());
          } else if (current !== null) {
            client.identify(current);
          }
        }
      } catch (err) {
        deps.debug('analytics: identity sync failed', err instanceof Error ? err.message : err);
      }
    },
    optOut() {
      setOptOut(true, deps.consent());
      each(d => d.optOut());
      client.reset();
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
});

/** Sends a taxonomy event from the browser. Unknown properties or PII drop the event. */
export function track<E extends ClientEventName>(event: E, properties: EventProperties<E>): void {
  browserClient.track(event, properties);
}

/** Links this browser to a verified member id. Emails, names and other non-id values are refused. */
export function identify(memberId: string): void {
  browserClient.identify(memberId);
}

/** Forgets the identified member (call on sign-out and account deletion). */
export function reset(): void {
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

const LOCAL_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0|.+\.local|.+\.localhost)$/i;

export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOST_RE.test(hostname);
}

/** Capture only on real hosts in production builds, unless PUBLIC_ANALYTICS_DEBUG is set. */
export function shouldCaptureOn(hostname: string, config: PostHogConfig, devBuild: boolean): boolean {
  if (config.debug) return true;
  return !devBuild && !isLocalHostname(hostname);
}

export const CONFIG_ELEMENT_ID = 'zuey-analytics';

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
    ph.init(config.key, postHogInitOptions(config, window.location.pathname));
    browserClient.activate(config.debug);
    void browserClient.syncIdentity(window.location.pathname);
  } catch (err) {
    console.debug('analytics: boot failed', err instanceof Error ? err.message : 'unknown');
  }
}
