/**
 * Edge cache for anonymous SSR HTML of the public landing pages (/, /articles, /articles/<slug>, /pricing).
 *
 * Each request otherwise renders on the worker and queries D1 (0.6–3.8 s TTFB in production). Anonymous
 * visitors all see the same page per URL and locale, so it is kept in the colo's Cache API:
 *
 * - Only GET requests without an Authorization or X-API-Key header or a member/admin session cookie are served
 *   or stored. Signed-in readers can see paid text and personal UI, so they always bypass.
 * - The key is the URL (tracking parameters dropped, the rest sorted) plus the resolved locale
 *   (?lang, then the zuey_locale cookie, then Accept-Language). Other cookies (analytics, referral) are ignored.
 * - Only 200 HTML responses without Set-Cookie (including cookies Astro adds after the middleware, checked
 *   through `canStore`) and without a private/no-store Cache-Control are stored. Clients get the page's own
 *   Cache-Control back on HIT and STALE; the longer edge lifetime stays on the stored copy.
 * - Freshness: EDGE_HTML_FRESH_S, then up to EDGE_HTML_STALE_S of stale-while-revalidate (served at once and
 *   refreshed in the background). Publishing does not purge: Cache API deletes reach only one colo, so the
 *   short TTL bounds staleness instead: a change normally shows within about a minute of the next visit, and at
 *   most after EDGE_HTML_FRESH_S + EDGE_HTML_STALE_S (11 minutes) when the stale copy is the one served.
 */
import { resolveLocale } from './i18n/locales';

export const EDGE_HTML_FRESH_S = 60;
export const EDGE_HTML_STALE_S = 600;
export const EDGE_CACHE_HEADER = 'X-Edge-Cache';
const STORED_AT_HEADER = 'X-Edge-Stored-At';
/** The page's own Cache-Control ('' when it had none), restored for clients on HIT and STALE. */
const ORIGIN_CACHE_CONTROL_HEADER = 'X-Edge-Origin-Cache-Control';

/** Cookies that identify a signed-in member or admin; any of them disables the cache. */
const SESSION_COOKIES = ['zuey_member', 'zuey_session', 'zuey_member_oauth'];
/** Query parameters that make the response private (search) or admin-only (draft preview). */
const BYPASS_PARAMS = ['q', 'preview'];
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TRACKING_PARAM_RE = /^(utm_.+|fbclid|gclid|msclkid|ref)$/;

export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export type EdgeCacheStatus = 'HIT' | 'STALE' | 'MISS' | 'BYPASS';

export function isEdgeCachedPath(pathname: string): boolean {
  if (pathname === '/' || pathname === '/articles' || pathname === '/pricing') return true;
  const m = /^\/articles\/([^/]+)$/.exec(pathname);
  return m !== null && SLUG_RE.test(m[1]);
}

function hasSessionCookie(cookieHeader: string): boolean {
  return cookieHeader.split(';').some(part => SESSION_COOKIES.includes(part.split('=')[0].trim()));
}

/** Why a request must skip the edge cache, or null when it may be served from it. */
export function edgeCacheBypassReason(request: Request, url: URL): string | null {
  if (request.method !== 'GET') return 'method';
  if (!isEdgeCachedPath(url.pathname)) return 'path';
  if (request.headers.has('authorization') || request.headers.has('x-api-key')) return 'authorization';
  if (hasSessionCookie(request.headers.get('cookie') || '')) return 'session';
  if (BYPASS_PARAMS.some(p => url.searchParams.has(p))) return 'query';
  return null;
}

export function edgeCacheKey(request: Request, url: URL): Request {
  const key = new URL(url.pathname, url.origin);
  const params = [...url.searchParams].filter(([k]) => !TRACKING_PARAM_RE.test(k)).sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of params) key.searchParams.append(k, v);
  key.searchParams.set('__locale', resolveLocale(request));
  return new Request(key.toString(), { method: 'GET' });
}

export function isStorableResponse(response: Response): boolean {
  if (response.status !== 200 || response.headers.has('set-cookie')) return false;
  if (!(response.headers.get('content-type') || '').includes('text/html')) return false;
  return !/\b(private|no-store)\b/i.test(response.headers.get('cache-control') || '');
}

/** Labels a cached copy for the client: restores the page's Cache-Control and drops the internal headers. */
function fromCache(response: Response, status: EdgeCacheStatus): Response {
  const out = new Response(response.body, response);
  const originCacheControl = out.headers.get(ORIGIN_CACHE_CONTROL_HEADER);
  if (originCacheControl) out.headers.set('Cache-Control', originCacheControl);
  else out.headers.delete('Cache-Control');
  out.headers.delete(ORIGIN_CACHE_CONTROL_HEADER);
  out.headers.delete(STORED_AT_HEADER);
  out.headers.set(EDGE_CACHE_HEADER, status);
  return out;
}

/** Labels a freshly rendered response; copies it when its headers are immutable. */
function labelled(response: Response, status: EdgeCacheStatus): Response {
  try {
    response.headers.set(EDGE_CACHE_HEADER, status);
    return response;
  } catch {
    const out = new Response(response.body, response);
    out.headers.set(EDGE_CACHE_HEADER, status);
    return out;
  }
}

/**
 * Renders the page and, when it may be shared, starts storing a copy. The response is returned at once so it
 * streams to the client; `stored` settles when the copy is in the cache and never rejects (a failed put only
 * means the next visitor renders again).
 */
async function renderAndStore(
  cache: EdgeCache, key: Request, render: () => Promise<Response>, now: number, canStore: () => boolean,
): Promise<{ response: Response; stored: Promise<void> | null }> {
  const response = await render();
  if (!isStorableResponse(response) || !canStore()) return { response, stored: null };
  const copy = new Response(response.clone().body, response);
  copy.headers.set(ORIGIN_CACHE_CONTROL_HEADER, response.headers.get('cache-control') || '');
  copy.headers.set(STORED_AT_HEADER, String(now));
  // The Cache API honours max-age only; the stored copy lives for the fresh and the stale window.
  copy.headers.set('Cache-Control', `public, max-age=${EDGE_HTML_FRESH_S + EDGE_HTML_STALE_S}`);
  return { response, stored: cache.put(key, copy).catch(() => undefined) };
}

/**
 * Keys this isolate is already revalidating, so a burst of STALE hits renders the page once rather than once
 * per request. Other isolates and colos may still refresh the same key; that costs a render, not correctness.
 */
const revalidating = new Set<string>();

export interface EdgeCacheOptions {
  cache: EdgeCache | undefined;
  waitUntil?: (promise: Promise<unknown>) => void;
  now?: () => number;
  /**
   * Checked after rendering, before storing. The middleware passes a check for cookies set through
   * Astro.cookies, which the adapter adds to the response only after the middleware returns.
   */
  canStore?: () => boolean;
}

/** Serves the request from the edge cache when allowed, otherwise renders it (storing what may be shared). */
export async function serveWithEdgeCache(request: Request, url: URL, render: () => Promise<Response>, opts: EdgeCacheOptions): Promise<Response> {
  const { cache, waitUntil } = opts;
  const canStore = opts.canStore ?? (() => true);
  const now = (opts.now ?? Date.now)();
  if (!cache || edgeCacheBypassReason(request, url) !== null) {
    const response = await render();
    return isEdgeCachedPath(url.pathname) ? labelled(response, 'BYPASS') : response;
  }
  const key = edgeCacheKey(request, url);
  const cached = await cache.match(key).catch(() => undefined);
  if (cached) {
    const age = (now - Number(cached.headers.get(STORED_AT_HEADER) || 0)) / 1000;
    if (age <= EDGE_HTML_FRESH_S) return fromCache(cached, 'HIT');
    if (age <= EDGE_HTML_FRESH_S + EDGE_HTML_STALE_S && waitUntil) {
      if (!revalidating.has(key.url)) {
        revalidating.add(key.url);
        waitUntil(
          renderAndStore(cache, key, render, now, canStore)
            .then(({ response, stored }) => stored ?? response.body?.cancel())
            .catch(() => undefined)
            .finally(() => revalidating.delete(key.url)),
        );
      }
      return fromCache(cached, 'STALE');
    }
  }
  const { response, stored } = await renderAndStore(cache, key, render, now, canStore);
  if (stored) {
    if (waitUntil) waitUntil(stored);
    else await stored;
  }
  return labelled(response, 'MISS');
}
