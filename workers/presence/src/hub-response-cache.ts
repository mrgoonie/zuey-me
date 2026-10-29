/**
 * Short-lived cache in front of the single PresenceHub for a public read route, so a request flood (a curl
 * loop, many open Activity Monitors) cannot saturate the one global Durable Object:
 *
 *   1. per-isolate memo: one hub (or edge cache) read per `memoMs`, concurrent misses share it;
 *   2. `caches.default` (shared by isolates in one colo) keyed on a fixed internal path, `edgeSeconds`;
 *   3. the hub itself.
 *
 * When the hub fails, the last good value is served for at most `maxStaleMs`, then null (503).
 * Entries hold only the public aggregate body, never CORS headers (added per request by the caller).
 */
import type { EdgeCacheLike } from './runtime-types';

export interface HubResponseCacheOptions<T> {
  /** Path of the edge-cache key on the Worker's own host; never routed, so no client request can hit or poison it. */
  path: string;
  memoMs: number;
  edgeSeconds: number;
  maxStaleMs: number;
  /** Validates both hub answers and edge-cache entries. */
  isValid: (v: unknown) => v is T;
  /** Used in log lines only. */
  label: string;
}

export interface HubResponseCache<T> {
  /** Current value through the memo and edge cache; null when none is available or the last good one is too old. */
  get(cacheOrigin: string, fromHub: () => Promise<T | null>): Promise<T | null>;
  /** Clears the isolate memo (tests, and nothing else, need a cold isolate). */
  reset(): void;
}

function isEdgeCache(v: unknown): v is EdgeCacheLike {
  return typeof v === 'object' && v !== null && 'match' in v && typeof v.match === 'function' && 'put' in v && typeof v.put === 'function';
}

/** `caches.default` on Workers; null where the Cache API does not exist (tests, other runtimes). */
function edgeCache(): EdgeCacheLike | null {
  const storage: unknown = Reflect.get(globalThis, 'caches');
  if (typeof storage !== 'object' || storage === null || !('default' in storage)) return null;
  const cache: unknown = storage.default;
  return isEdgeCache(cache) ? cache : null;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : 'unknown error');

export function createHubResponseCache<T>(opts: HubResponseCacheOptions<T>): HubResponseCache<T> {
  let lastGood: { value: T; at: number } | null = null;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<T | null> | null = null;

  const fallback = (now: number): T | null => (lastGood && now - lastGood.at <= opts.maxStaleMs ? lastGood.value : null);

  async function readEdge(cache: EdgeCacheLike, key: string): Promise<T | null> {
    try {
      const res = await cache.match(new Request(key));
      if (!res) return null;
      const body: unknown = await res.json();
      return opts.isValid(body) ? body : null;
    } catch (err) {
      console.error(`presence ${opts.label} cache read failed`, errorMessage(err));
      return null;
    }
  }

  async function writeEdge(cache: EdgeCacheLike, key: string, value: T): Promise<void> {
    try {
      await cache.put(new Request(key), new Response(JSON.stringify(value), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${opts.edgeSeconds}` },
      }));
    } catch (err) {
      console.error(`presence ${opts.label} cache write failed`, errorMessage(err));
    }
  }

  async function load(cacheOrigin: string, fromHub: () => Promise<T | null>): Promise<T | null> {
    lastAttemptAt = Date.now();
    const cache = edgeCache();
    const key = `${cacheOrigin}${opts.path}`;
    let value = cache ? await readEdge(cache, key) : null;
    if (!value) {
      try {
        value = await fromHub();
      } catch (err) {
        console.error(`presence ${opts.label} failed`, errorMessage(err));
        value = null;
      }
      if (value && cache) await writeEdge(cache, key, value);
    }
    if (value) lastGood = { value, at: Date.now() };
    return fallback(Date.now());
  }

  return {
    get(cacheOrigin, fromHub) {
      // Concurrent misses wait for the one read already in flight instead of starting their own.
      if (inflight) return inflight;
      const now = Date.now();
      if (now - lastAttemptAt < opts.memoMs) return Promise.resolve(fallback(now));
      inflight = load(cacheOrigin, fromHub).finally(() => {
        inflight = null;
      });
      return inflight;
    },
    reset() {
      lastGood = null;
      lastAttemptAt = Number.NEGATIVE_INFINITY;
      inflight = null;
    },
  };
}
