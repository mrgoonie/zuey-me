/**
 * Edge cache for anonymous SSR HTML of the public landing pages (/, /articles, /articles/<slug>, /pricing).
 *
 * Each request otherwise renders on the worker and queries D1 (0.6–3.8 s TTFB in production). Anonymous
 * visitors all see the same page per URL and locale, so it is kept in the colo's Cache API:
 *
 * - Only GET requests without an Authorization header or a member/admin session cookie are served or stored.
 *   Signed-in readers can see paid text and personal UI, so they always bypass.
 * - The key is the URL (tracking parameters dropped, the rest sorted) plus the resolved locale
 *   (?lang, then the zuey_locale cookie, then Accept-Language). Other cookies (analytics, referral) are ignored.
 * - Only 200 HTML responses without Set-Cookie and without a private/no-store Cache-Control are stored.
 * - Freshness: EDGE_HTML_FRESH_S, then up to EDGE_HTML_STALE_S of stale-while-revalidate (served at once and
 *   refreshed in the background). Publishing does not purge: Cache API deletes reach only one colo, so the
 *   short TTL bounds staleness instead (a published or updated article shows within about a minute).
 */
import { resolveLocale } from './i18n/locales';

export const EDGE_HTML_FRESH_S = 60;
export const EDGE_HTML_STALE_S = 600;
export const EDGE_CACHE_HEADER = 'X-Edge-Cache';
const STORED_AT_HEADER = 'X-Edge-Stored-At';

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
  if (request.headers.has('authorization')) return 'authorization';
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

/** Labels a cached copy for the client (dropping the internal timestamp). */
function fromCache(response: Response, status: EdgeCacheStatus): Response {
  const out = new Response(response.body, response);
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

/** Renders and stores a copy when the response allows it; returns the response to send. */
async function renderAndStore(cache: EdgeCache, key: Request, render: () => Promise<Response>, now: number): Promise<Response> {
  const response = await render();
  if (!isStorableResponse(response)) return response;
  const stored = new Response(response.clone().body, response);
  stored.headers.set(STORED_AT_HEADER, String(now));
  // The Cache API honours max-age only; the stored copy lives for the fresh and the stale window.
  stored.headers.set('Cache-Control', `public, max-age=${EDGE_HTML_FRESH_S + EDGE_HTML_STALE_S}`);
  await cache.put(key, stored);
  return response;
}

export interface EdgeCacheOptions {
  cache: EdgeCache | undefined;
  waitUntil?: (promise: Promise<unknown>) => void;
  now?: () => number;
}

/** Serves the request from the edge cache when allowed, otherwise renders it (storing what may be shared). */
export async function serveWithEdgeCache(request: Request, url: URL, render: () => Promise<Response>, opts: EdgeCacheOptions): Promise<Response> {
  const { cache, waitUntil } = opts;
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
      waitUntil(renderAndStore(cache, key, render, now).catch(() => undefined));
      return fromCache(cached, 'STALE');
    }
  }
  return labelled(await renderAndStore(cache, key, render, now), 'MISS');
}
