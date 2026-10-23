/**
 * GA4 destination: the browser adapter over `gtag.js` (page views and `begin_checkout`) and the server
 * adapter over the Measurement Protocol (`purchase` and `refund` from the analytics outbox). Each GA4 event
 * has exactly one emitter, so nothing is counted twice. Web-standard APIs only.
 */
import { consentState, type ConsentEnvironment } from '../consent';
import type { AnalyticsProperties } from '../events';
import { isGuestDistinctId } from '../identity';
import { hasPrivateIdentifier, scrubUrl } from '../pii';
import type { FetchLike } from './posthog';
import type { ClientDestination, DestinationResult, ServerAnalyticsEvent, ServerDestination } from './types';

export const GA4_SCRIPT_URL = 'https://www.googletagmanager.com/gtag/js';
export const GA4_MP_ENDPOINT = 'https://www.google-analytics.com/mp/collect';

/** The browser sends these to GA4 (page views come from `config`). */
export const GA4_CLIENT_EVENTS: readonly string[] = ['begin_checkout'];
/** Only the server sends these to GA4, from verified payment state. */
export const GA4_SERVER_EVENTS: readonly string[] = ['purchase', 'refund'];

const MEASUREMENT_ID_RE = /^G-[A-Z0-9]{4,16}$/;

/** The measurement id (`G-…`, a public identifier) or null when it is missing or malformed. */
export function resolveGa4MeasurementId(raw: string | undefined | null): string | null {
  const id = raw?.trim().toUpperCase() ?? '';
  return MEASUREMENT_ID_RE.test(id) ? id : null;
}

/** Consent Mode v2 defaults: everything denied until the site's own consent check passes. */
export const GA4_CONSENT_DEFAULTS = {
  ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied',
} as const;
/** Granted after the check: analytics storage only. Advertising stays denied. */
export const GA4_CONSENT_GRANTED = { analytics_storage: 'granted' } as const;

/** Shown instead of the page title on pages whose title may name an order or booking. */
export const GA4_PRIVATE_TITLE = 'zuey.me';

function num(props: AnalyticsProperties, key: string): number | undefined {
  const v = props[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function text(props: AnalyticsProperties, key: string): string | undefined {
  const v = props[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** One GA4 `items[]` entry from the taxonomy properties: the plan or course, categorised by order type. */
export function ga4Items(props: AnalyticsProperties, price: number | undefined): Array<Record<string, string | number>> {
  const category = text(props, 'order_type') ?? 'order';
  const id = text(props, 'plan') ?? text(props, 'course') ?? category;
  const months = num(props, 'months');
  return [{
    item_id: id, item_name: id, item_category: category, quantity: 1,
    ...(months !== undefined ? { item_variant: `${months}m` } : {}),
    ...(price !== undefined ? { price } : {}),
  }];
}

/** `value` and `currency` are sent together or not at all (GA4 rejects a value without a currency). */
function money(props: AnalyticsProperties, amountKey: string): { value?: number; currency?: string } {
  const value = num(props, amountKey);
  const currency = text(props, 'currency');
  return value !== undefined && currency ? { value, currency } : {};
}

/** GA4 `begin_checkout` parameters from the taxonomy event. */
export function beginCheckoutParams(props: AnalyticsProperties): Record<string, unknown> {
  const m = money(props, 'value');
  return { ...m, items: ga4Items(props, m.value) };
}

// ---------------------------------------------------------------------------------------------------
// Browser adapter

/** The parts of `window` and `document` the gtag boot touches; structural so tests need no DOM. */
export interface Ga4BrowserHost {
  win: object & { location: { href: string; pathname: string; hostname: string } };
  doc: {
    referrer: string;
    title: string;
    cookie: string;
    createElement(tag: 'script'): { async: boolean; src: string };
    head: { appendChild(node: unknown): unknown };
  };
}

type Gtag = (...args: unknown[]) => void;

/**
 * Free-text search parameters (GA4 site search reads these names, plus common variants). Search words are
 * never sent to GA4, whatever the shared URL scrubber keeps.
 */
export const GA4_SEARCH_PARAMS: readonly string[] = ['q', 's', 'search', 'query', 'keyword', 'keywords', 'term', 'search_term', 'searchterm'];

/** Removes free-text search parameters from an absolute URL; an unparsable one loses its whole query. */
export function dropSearchParams(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.split(/[?#]/)[0] ?? '';
  }
  const names = [...parsed.searchParams.keys()].filter(k => GA4_SEARCH_PARAMS.includes(k.toLowerCase()));
  if (names.length === 0) return url;
  for (const name of names) parsed.searchParams.delete(name);
  return parsed.toString();
}

/** Page fields gtag would otherwise read raw from `location`, `document.referrer` and `document.title`. */
export function ga4PageFields(href: string, pathname: string, referrer: string, title: string): Record<string, string> {
  return {
    page_location: dropSearchParams(scrubUrl(href)),
    ...(referrer ? { page_referrer: dropSearchParams(scrubUrl(referrer)) } : {}),
    page_title: hasPrivateIdentifier(pathname) ? GA4_PRIVATE_TITLE : title,
  };
}

/** The cookie and location parts of `document` / `window` that GA cookie cleanup needs. */
export interface Ga4CookieHost {
  win: { location: { hostname: string } };
  doc: { cookie: string };
}

/**
 * Removes the `_ga` / `_ga_<stream>` cookies gtag set on this host and its parent domain. Also run on every
 * page load without consent, so cookies left from before Do Not Track or GPC was switched on never linger
 * (and never reach the checkout request that reads them for attribution).
 */
export function deleteGaCookies(host: Ga4CookieHost): void {
  const names = host.doc.cookie.split(';').map(c => c.split('=')[0]?.trim() ?? '').filter(n => n === '_ga' || n.startsWith('_ga_'));
  const hostname = host.win.location.hostname;
  const domains = [null, hostname, `.${hostname.replace(/^www\./, '')}`];
  for (const name of names) {
    for (const domain of domains) {
      host.doc.cookie = `${name}=; Max-Age=0; path=/${domain ? `; domain=${domain}` : ''}`;
    }
  }
}

export interface Ga4Client {
  /**
   * Installs gtag with Consent Mode defaults, then loads `gtag/js` and sends the page view, only when consent
   * reads `granted` (no opt-out, Do Not Track or Global Privacy Control). Returns whether it started.
   * `memberId` is the member this browser is already identified as, so the first page view carries it.
   */
  start(host: Ga4BrowserHost, measurementId: string, consent: ConsentEnvironment, memberId?: string | null): boolean;
  destination: ClientDestination;
}

export function createGa4Client(): Ga4Client {
  let state: { host: Ga4BrowserHost; id: string; gtag: Gtag } | null = null;
  let userId: string | null = null;

  const call = (...args: unknown[]): void => {
    try {
      state?.gtag(...args);
    } catch (err) {
      console.debug('analytics: gtag call failed', err instanceof Error ? err.message : 'unknown');
    }
  };
  const setDisabled = (disabled: boolean): void => {
    if (state) Reflect.set(state.host.win, `ga-disable-${state.id}`, disabled);
  };

  return {
    start(host, measurementId, consent, memberId = null) {
      try {
        if (state) return true;
        if (consentState(consent) !== 'granted') return false;
        const existing: unknown = Reflect.get(host.win, 'dataLayer');
        const dataLayer: unknown[] = Array.isArray(existing) ? existing : [];
        Reflect.set(host.win, 'dataLayer', dataLayer);
        // gtag.js only reads `arguments` objects from the data layer, so this must stay a plain function.
        const gtag: Gtag = function gtag() {
          dataLayer.push(arguments);
        };
        Reflect.set(host.win, 'gtag', gtag);
        state = { host, id: measurementId, gtag };
        setDisabled(false);
        const { location } = host.win;
        const page = ga4PageFields(location.href, location.pathname, host.doc.referrer, host.doc.title);
        call('consent', 'default', GA4_CONSENT_DEFAULTS);
        call('consent', 'update', GA4_CONSENT_GRANTED);
        call('js', new Date());
        // Every later hit (begin_checkout, enhanced measurement) reuses these scrubbed fields.
        call('set', page);
        if (memberId) {
          userId = memberId;
          call('set', { user_id: memberId });
        }
        // No automatic page view (it would read the raw URL): the one page view is sent below with scrubbed fields.
        call('config', measurementId, { allow_google_signals: false, allow_ad_personalization_signals: false, send_page_view: false });
        call('event', 'page_view', page);
        const script = host.doc.createElement('script');
        script.async = true;
        script.src = `${GA4_SCRIPT_URL}?id=${encodeURIComponent(measurementId)}`;
        host.doc.head.appendChild(script);
        return true;
      } catch (err) {
        console.debug('analytics: gtag boot failed', err instanceof Error ? err.message : 'unknown');
        return false;
      }
    },
    destination: {
      name: 'ga4',
      active: () => state !== null,
      capture(event, properties) {
        if (event === 'begin_checkout') call('event', 'begin_checkout', beginCheckoutParams(properties));
      },
      identify(memberId) {
        userId = memberId;
        call('set', { user_id: memberId });
      },
      reset() {
        userId = null;
        call('set', { user_id: null });
      },
      optOut() {
        call('consent', 'update', { analytics_storage: 'denied' });
        setDisabled(true);
        try {
          if (state) deleteGaCookies(state.host);
        } catch {
          // Cookies are blocked or read-only: gtag is disabled either way.
        }
      },
      optIn() {
        setDisabled(false);
        call('consent', 'update', GA4_CONSENT_GRANTED);
      },
      distinctId: () => userId,
    },
  };
}

/** The page's GA4 client (one per page load). */
export const ga4Browser = createGa4Client();

// ---------------------------------------------------------------------------------------------------
// Server adapter (Measurement Protocol)

export interface Ga4ServerConfig {
  measurementId: string;
  /** Measurement Protocol API secret (server-only Cloudflare secret `GA4_API_SECRET`). */
  apiSecret: string;
}

/** Null (server path off) unless both the measurement id and the API secret are set. */
export function resolveGa4ServerConfig(env: { PUBLIC_GA4_MEASUREMENT_ID?: string; GA4_API_SECRET?: string }): Ga4ServerConfig | null {
  const measurementId = resolveGa4MeasurementId(env.PUBLIC_GA4_MEASUREMENT_ID);
  const apiSecret = env.GA4_API_SECRET?.trim() ?? '';
  if (!measurementId || apiSecret === '') return null;
  return { measurementId, apiSecret };
}

/**
 * Fallback GA4 `client_id` for a server event: `<u32>.<u32>` from SHA-256 of the distinct id. Used when no
 * browser GA id was captured at checkout start (`ga4-attribution.ts`): outbox events come from webhooks and the
 * scheduler, so no `_ga` cookie is at hand; the member is still joined through `user_id`.
 */
export async function ga4ClientId(distinctId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ga4:${distinctId}`)));
  const view = new DataView(digest.buffer);
  return `${view.getUint32(0)}.${view.getUint32(4)}`;
}

/** GA4 accepts `timestamp_micros` up to 72 hours back; older events are sent without one (receipt time). */
export const MP_MAX_BACKDATE_MS = 71 * 60 * 60 * 1000;

/** Measurement Protocol body for a `purchase` or `refund`, or null for any other event or an unusable payload. */
export async function measurementProtocolPayload(event: ServerAnalyticsEvent, nowMs: number): Promise<Record<string, unknown> | null> {
  if (!GA4_SERVER_EVENTS.includes(event.event)) return null;
  const props = event.properties;
  const m = money(props, 'amount');
  if (event.event === 'purchase' && m.value === undefined) return null;
  // A refund that names no known purchase would show in GA4 as a refund of nothing: skipped.
  const transactionId = text(props, 'transaction_id') ?? (event.event === 'purchase' ? event.uuid : undefined);
  if (!transactionId) return null;
  // The browser's GA ids captured at checkout start join the event to that web session; otherwise a stable hash.
  const gaClientId = text(props, 'ga_client_id');
  const gaSessionId = text(props, 'ga_session_id');
  const at = Date.parse(event.occurredAt);
  const backdate = Number.isFinite(at) && at <= nowMs && nowMs - at <= MP_MAX_BACKDATE_MS;
  return {
    client_id: gaClientId ?? await ga4ClientId(event.distinctId),
    ...(isGuestDistinctId(event.distinctId) ? {} : { user_id: event.distinctId }),
    ...(backdate ? { timestamp_micros: at * 1000 } : {}),
    non_personalized_ads: true,
    consent: { ad_user_data: 'DENIED', ad_personalization: 'DENIED' },
    events: [{
      name: event.event,
      params: {
        transaction_id: transactionId,
        ...(gaSessionId && /^\d{1,20}$/.test(gaSessionId) ? { session_id: gaSessionId } : {}),
        ...m,
        ...(m.value !== undefined ? { items: ga4Items(props, m.value) } : {}),
      },
    }],
  };
}

/** Server adapter posting `purchase` / `refund` to the Measurement Protocol. Resolves, never rejects. */
export function createGa4ServerDestination(
  config: Ga4ServerConfig, fetchImpl: FetchLike = fetch, now: () => number = Date.now,
): ServerDestination {
  return {
    name: 'ga4',
    secondary: true,
    accepts: event => GA4_SERVER_EVENTS.includes(event),
    async send(event, signal): Promise<DestinationResult> {
      try {
        const body = await measurementProtocolPayload(event, now());
        if (!body) return { destination: 'ga4', ok: false, reason: 'invalid' };
        const url = `${GA4_MP_ENDPOINT}?measurement_id=${encodeURIComponent(config.measurementId)}&api_secret=${encodeURIComponent(config.apiSecret)}`;
        const res = await fetchImpl(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
        });
        if (res.ok) return { destination: 'ga4', ok: true, status: res.status };
        return { destination: 'ga4', ok: false, reason: 'http', status: res.status };
      } catch {
        // No error message: the request URL carries the API secret.
        if (signal.aborted) return { destination: 'ga4', ok: false, reason: 'timeout' };
        return { destination: 'ga4', ok: false, reason: 'network' };
      }
    },
  };
}
