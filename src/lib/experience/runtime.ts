import type { FetchLike } from '../integrations/google-calendar';
import { membersRuntime } from '../members/runtime';

/** Minimal JSON cache: Cloudflare's Cache API in production, an in-memory map in dev/tests. */
export interface JsonCache {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function isCacheLike(value: unknown): value is CacheLike {
  return typeof value === 'object' && value !== null
    && 'match' in value && typeof value.match === 'function'
    && 'put' in value && typeof value.put === 'function';
}

/** `caches.default` exists only on Cloudflare Workers; browsers/Bun expose CacheStorage without it. */
function edgeCache(): CacheLike | null {
  if (typeof globalThis.caches !== 'object' || globalThis.caches === null) return null;
  const def: unknown = Reflect.get(globalThis.caches, 'default');
  return isCacheLike(def) ? def : null;
}

const CACHE_ORIGIN = 'https://cache.zuey.internal/';

function cacheRequest(key: string): Request {
  return new Request(`${CACHE_ORIGIN}${encodeURIComponent(key)}`);
}

export function createMemoryCache(now: () => number): JsonCache & { clear(): void } {
  const store = new Map<string, { value: string; expires: number }>();
  return {
    async get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.expires <= now()) {
        store.delete(key);
        return null;
      }
      return JSON.parse(hit.value);
    },
    async put(key, value, ttlSeconds) {
      store.set(key, { value: JSON.stringify(value), expires: now() + ttlSeconds * 1000 });
    },
    clear() {
      store.clear();
    },
  };
}

function createEdgeJsonCache(cache: CacheLike): JsonCache {
  return {
    async get(key) {
      try {
        const res = await cache.match(cacheRequest(key));
        return res ? await res.json() : null;
      } catch {
        return null;
      }
    },
    async put(key, value, ttlSeconds) {
      try {
        await cache.put(cacheRequest(key), new Response(JSON.stringify(value), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttlSeconds}` },
        }));
      } catch {
        // Cache writes are best-effort; the response is still served.
      }
    },
  };
}

const memoryCache = createMemoryCache(() => experienceRuntime.now());

/** Injectable side effects so tests can control time, outbound HTTP and caching. */
export const experienceRuntime: { fetch: FetchLike; now: () => number; cache: () => JsonCache } = {
  fetch: (input, init) => fetch(input, init),
  /** Shares the membership clock so subscriptions, notices and caches agree on "now". */
  now: () => membersRuntime.now(),
  cache: () => {
    const edge = edgeCache();
    return edge ? createEdgeJsonCache(edge) : memoryCache;
  },
};

/** Clears the in-memory fallback cache (tests). */
export function clearMemoryCache(): void {
  memoryCache.clear();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}

export function readNumber(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Fetch with a hard timeout so a hung upstream never pins the request. */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await experienceRuntime.fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
