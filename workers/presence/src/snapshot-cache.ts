/**
 * Short-lived cache in front of the single PresenceHub for GET /v1/snapshot, so a request flood (a curl
 * loop, many open Activity Monitors) cannot saturate the one global Durable Object:
 *
 *   1. per-isolate memo: one hub (or edge cache) read per SNAPSHOT_MEMO_MS, concurrent misses share it;
 *   2. `caches.default` (shared by isolates in one colo) keyed on a fixed internal path, SNAPSHOT_EDGE_CACHE_SECONDS;
 *   3. the hub itself.
 *
 * When the hub fails, the last good snapshot is served for at most SNAPSHOT_MAX_STALE_MS, then null (503).
 * Entries hold only the public aggregate snapshot, never CORS headers (added per request by the caller).
 */
import { PRESENCE_CONTRACT_VERSION, type PresenceSnapshot } from '../../../src/lib/presence/contract';
import type { EdgeCacheLike } from './runtime-types';

export const SNAPSHOT_MEMO_MS = 2_000;
export const SNAPSHOT_EDGE_CACHE_SECONDS = 5;
export const SNAPSHOT_MAX_STALE_MS = 5 * 60_000;
/** Path of the edge-cache key on the Worker's own host; never routed, so no client request can hit or poison it. */
export const SNAPSHOT_CACHE_PATH = '/__presence-cache/v1/snapshot';

export function isPresenceSnapshot(v: unknown): v is PresenceSnapshot {
  return typeof v === 'object' && v !== null && 'v' in v && v.v === PRESENCE_CONTRACT_VERSION && 'active' in v && typeof v.active === 'number'
    && 'owner' in v && typeof v.owner === 'object' && v.owner !== null && 'categories' in v && Array.isArray(v.categories);
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

interface GoodSnapshot {
  snapshot: PresenceSnapshot;
  /** Epoch ms this isolate last obtained it. */
  at: number;
}

let lastGood: GoodSnapshot | null = null;
let lastAttemptAt = Number.NEGATIVE_INFINITY;
let inflight: Promise<PresenceSnapshot | null> | null = null;

/** Clears the isolate memo (tests, and nothing else, need a cold isolate). */
export function resetSnapshotCache(): void {
  lastGood = null;
  lastAttemptAt = Number.NEGATIVE_INFINITY;
  inflight = null;
}

function fallback(now: number): PresenceSnapshot | null {
  return lastGood && now - lastGood.at <= SNAPSHOT_MAX_STALE_MS ? lastGood.snapshot : null;
}

async function readEdge(cache: EdgeCacheLike, key: string): Promise<PresenceSnapshot | null> {
  try {
    const res = await cache.match(new Request(key));
    if (!res) return null;
    const body: unknown = await res.json();
    return isPresenceSnapshot(body) ? body : null;
  } catch (err) {
    console.error('presence snapshot cache read failed', err instanceof Error ? err.message : 'unknown error');
    return null;
  }
}

async function writeEdge(cache: EdgeCacheLike, key: string, snapshot: PresenceSnapshot): Promise<void> {
  try {
    await cache.put(new Request(key), new Response(JSON.stringify(snapshot), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${SNAPSHOT_EDGE_CACHE_SECONDS}` },
    }));
  } catch (err) {
    console.error('presence snapshot cache write failed', err instanceof Error ? err.message : 'unknown error');
  }
}

async function load(cacheOrigin: string, fromHub: () => Promise<PresenceSnapshot | null>): Promise<PresenceSnapshot | null> {
  lastAttemptAt = Date.now();
  const cache = edgeCache();
  const key = `${cacheOrigin}${SNAPSHOT_CACHE_PATH}`;
  let snapshot = cache ? await readEdge(cache, key) : null;
  if (!snapshot) {
    try {
      snapshot = await fromHub();
    } catch (err) {
      console.error('presence snapshot failed', err instanceof Error ? err.message : 'unknown error');
      snapshot = null;
    }
    if (snapshot && cache) await writeEdge(cache, key, snapshot);
  }
  if (snapshot) lastGood = { snapshot, at: Date.now() };
  return fallback(Date.now());
}

/**
 * Current public snapshot through the memo and edge cache; null when none is available (or the last good
 * one is older than SNAPSHOT_MAX_STALE_MS). `cacheOrigin` is the Worker's own origin, used for the cache key.
 */
export function cachedSnapshot(cacheOrigin: string, fromHub: () => Promise<PresenceSnapshot | null>): Promise<PresenceSnapshot | null> {
  // Concurrent misses wait for the one read already in flight instead of starting their own.
  if (inflight) return inflight;
  const now = Date.now();
  if (now - lastAttemptAt < SNAPSHOT_MEMO_MS) return Promise.resolve(fallback(now));
  inflight = load(cacheOrigin, fromHub).finally(() => {
    inflight = null;
  });
  return inflight;
}
