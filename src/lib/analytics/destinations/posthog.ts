/**
 * PostHog destination: environment-driven configuration, the browser adapter over the `window.posthog`
 * snippet, and the server adapter over the HTTP capture API (web-standard `fetch` only).
 */
import { canTrack } from '../consent';
import { isGuestDistinctId } from '../identity';
import { hasPrivateIdentifier, isSensitivePath, scrubValue } from '../pii';
import type { ClientDestination, DestinationResult, ServerAnalyticsEvent, ServerDestination } from './types';

/** Project "Zuey.me". Used only by production builds that have no PUBLIC_POSTHOG_KEY configured. */
export const DEFAULT_POSTHOG_KEY = 'phc_zTPJwFiZZekHoxSj5PRg8ey4Ja7sKL7GXEGxjSKtZMPk';
export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

export interface AnalyticsEnv {
  PUBLIC_POSTHOG_KEY?: string;
  PUBLIC_POSTHOG_HOST?: string;
  PUBLIC_ANALYTICS_DEBUG?: string;
}

export interface PostHogConfig {
  key: string;
  /** Origin of the ingestion host, without a trailing slash. */
  host: string;
  /** Capture on localhost/dev and log to the console. */
  debug: boolean;
}

const KEY_RE = /^phc_[A-Za-z0-9_-]{20,100}$/;

export function isTruthyFlag(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function normaliseHost(raw: string | undefined, debug: boolean): string | null {
  const value = raw?.trim() || DEFAULT_POSTHOG_HOST;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !(debug && url.protocol === 'http:')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Resolves the PostHog project from the environment. The built-in key is a fallback for production
 * builds only, so `astro dev` without a key stays off. Production builds (including `*.pages.dev`
 * previews) do resolve a key; the browser then captures only on the production hostnames
 * (`shouldCaptureOn`). Returns null when analytics must stay off (no key, malformed key or host).
 */
export function resolvePostHogConfig(env: AnalyticsEnv, options: { production: boolean }): PostHogConfig | null {
  const debug = isTruthyFlag(env.PUBLIC_ANALYTICS_DEBUG);
  const key = env.PUBLIC_POSTHOG_KEY?.trim() || (options.production ? DEFAULT_POSTHOG_KEY : '');
  if (!KEY_RE.test(key)) return null;
  const host = normaliseHost(env.PUBLIC_POSTHOG_HOST, debug);
  if (!host) return null;
  return { key, host, debug };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Merges runtime bindings (Cloudflare) over build-time `import.meta.env`. */
export function analyticsEnvFrom(runtime: AnalyticsEnv | undefined): AnalyticsEnv {
  const build: Record<string, unknown> = import.meta.env ?? {};
  return {
    PUBLIC_POSTHOG_KEY: stringOrUndefined(runtime?.PUBLIC_POSTHOG_KEY) ?? stringOrUndefined(build.PUBLIC_POSTHOG_KEY),
    PUBLIC_POSTHOG_HOST: stringOrUndefined(runtime?.PUBLIC_POSTHOG_HOST) ?? stringOrUndefined(build.PUBLIC_POSTHOG_HOST),
    PUBLIC_ANALYTICS_DEBUG: stringOrUndefined(runtime?.PUBLIC_ANALYTICS_DEBUG) ?? stringOrUndefined(build.PUBLIC_ANALYTICS_DEBUG),
  };
}

/** True for Vite production builds (`astro build`); false in dev and under `bun test`. */
export function isProductionBuild(): boolean {
  const build: Record<string, unknown> = import.meta.env ?? {};
  return build.PROD === true;
}

// ---------------------------------------------------------------------------------------------------
// Browser adapter

/**
 * The subset of posthog-js (or its queueing snippet stub) this app calls. Before `init()` the snippet
 * stub only exposes `init`; it attaches `capture`, `identify` and the rest when `init()` runs, and the
 * loaded library replaces them later. So only `init` is guaranteed and every other method is optional.
 */
export interface PostHogLike {
  init(key: string, config: Record<string, unknown>): unknown;
  get_distinct_id?(): unknown;
  capture?(event: string, properties?: Record<string, unknown>): unknown;
  identify?(distinctId: string): unknown;
  reset?(): unknown;
  opt_out_capturing?(): unknown;
  opt_in_capturing?(): unknown;
}

function isPostHogLike(value: unknown): value is PostHogLike {
  if (typeof value !== 'object' && typeof value !== 'function') return false;
  if (value === null) return false;
  return 'init' in value && typeof Reflect.get(value, 'init') === 'function';
}

/** `window.posthog` when the snippet has run, else null (server, blocked script, tests). */
export function getPostHog(): PostHogLike | null {
  if (typeof window === 'undefined') return null;
  const candidate: unknown = Reflect.get(window, 'posthog');
  return isPostHogLike(candidate) ? candidate : null;
}

/** posthog-js `before_send` payload (only the members the scrubber touches). */
export interface CaptureResultLike {
  properties?: Record<string, unknown>;
  $set?: Record<string, unknown>;
  $set_once?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value, 'https://relative.invalid').pathname;
  } catch {
    return null;
  }
}

/**
 * `before_send` hook: strips sensitive URL parameters (the whole query on account, billing and booking
 * pages), replaces order codes and booking ids in paths, and redacts emails, JWTs and secret tokens
 * from every property PostHog attaches automatically (current URL, referrer, `$initial_*`, autocapture
 * element chain). The page title is blanked on order and booking pages. Drops the event if scrubbing
 * itself fails, so an unexpected shape can never leak raw data.
 */
export function scrubCaptureResult<T extends CaptureResultLike>(result: T | null): T | null {
  if (!result) return result;
  try {
    const scrubbed = { ...result };
    for (const field of ['properties', '$set', '$set_once'] as const) {
      const value = result[field];
      if (value === undefined) continue;
      const clean = scrubValue(value);
      if (!isRecord(clean)) return null;
      scrubbed[field] = clean;
    }
    const raw = result.properties;
    const path = raw ? pathOf(raw.$current_url) ?? pathOf(raw.$pathname) : null;
    if (path && hasPrivateIdentifier(path) && scrubbed.properties) {
      scrubbed.properties = { ...scrubbed.properties, title: '' };
    }
    return scrubbed;
  } catch {
    return null;
  }
}

export { isSensitivePath };

/** The members of the loaded posthog-js instance the `loaded` callback touches. */
interface LoadedPostHogLike {
  debug?: (on?: boolean) => void;
  opt_out_capturing?: () => unknown;
}

/**
 * posthog-js init options. Session replay stays off until a masking review enables it explicitly.
 * `canCapture` is re-read in `loaded`, which posthog-js runs before its automatic `$pageview`: a visitor
 * who opted out while `array.js` was still downloading is opted out there, so nothing is ever sent.
 */
export function postHogInitOptions(
  config: PostHogConfig,
  pathname: string,
  canCapture: () => boolean = () => canTrack(),
): Record<string, unknown> {
  return {
    api_host: config.host,
    person_profiles: 'identified_only',
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: !isSensitivePath(pathname),
    disable_session_recording: true,
    respect_dnt: true,
    before_send: scrubCaptureResult,
    loaded: (ph: LoadedPostHogLike) => {
      if (config.debug && typeof ph.debug === 'function') ph.debug(true);
      if (!canCapture() && typeof ph.opt_out_capturing === 'function') ph.opt_out_capturing();
    },
  };
}

function safely(run: () => unknown): void {
  try {
    run();
  } catch (err) {
    console.debug('analytics: posthog call failed', err instanceof Error ? err.message : 'unknown');
  }
}

/** Browser adapter over `window.posthog`. Every call is a silent no-op when PostHog is absent. */
export const postHogClientDestination: ClientDestination = {
  name: 'posthog',
  capture: (event, properties) => safely(() => getPostHog()?.capture?.(event, properties)),
  identify: memberId => safely(() => getPostHog()?.identify?.(memberId)),
  reset: () => safely(() => getPostHog()?.reset?.()),
  optOut: () => safely(() => getPostHog()?.opt_out_capturing?.()),
  optIn: () => safely(() => getPostHog()?.opt_in_capturing?.()),
  distinctId: () => {
    try {
      const id: unknown = getPostHog()?.get_distinct_id?.();
      return typeof id === 'string' ? id : null;
    } catch {
      return null;
    }
  },
};

// ---------------------------------------------------------------------------------------------------
// Server adapter

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Sent with every server event: the request comes from a Cloudflare egress IP, so GeoIP is disabled to keep it
 * from overwriting the location PostHog derived from the member's own browser.
 */
export const SERVER_EVENT_FLAGS = { $lib: 'zuey-me-server', $geoip_disable: true } as const;
/** Booking guests are one-off hashed ids: their events never create a PostHog person profile. */
export const GUEST_EVENT_FLAGS = { $process_person_profile: false } as const;

/** Server adapter posting one event to PostHog's capture endpoint. Resolves with a result, never rejects. */
export function createPostHogServerDestination(config: PostHogConfig, fetchImpl: FetchLike = fetch): ServerDestination {
  return {
    name: 'posthog',
    async send(event: ServerAnalyticsEvent, signal: AbortSignal): Promise<DestinationResult> {
      try {
        const res = await fetchImpl(`${config.host}/i/v0/e/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: config.key,
            event: event.event,
            distinct_id: event.distinctId,
            uuid: event.uuid,
            timestamp: event.occurredAt,
            properties: { ...event.properties, ...SERVER_EVENT_FLAGS, ...(isGuestDistinctId(event.distinctId) ? GUEST_EVENT_FLAGS : {}) },
          }),
          signal,
        });
        if (res.ok) return { destination: 'posthog', ok: true, status: res.status };
        return { destination: 'posthog', ok: false, reason: 'http', status: res.status };
      } catch (err) {
        if (signal.aborted) return { destination: 'posthog', ok: false, reason: 'timeout' };
        return { destination: 'posthog', ok: false, reason: 'network', message: err instanceof Error ? err.message : 'unknown' };
      }
    },
  };
}
