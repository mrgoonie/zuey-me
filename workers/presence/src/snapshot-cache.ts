/**
 * Cache in front of the PresenceHub for GET /v1/snapshot and GET /v1/history (see hub-response-cache.ts for the
 * memo + edge cache + stale fallback layers). Entries hold only public aggregates, never CORS headers.
 */
import {
  PRESENCE_CONTRACT_VERSION, PRESENCE_HISTORY_BUCKETS, type PresenceHistory, type PresenceSnapshot,
} from '../../../src/lib/presence/contract';
import { createHubResponseCache } from './hub-response-cache';

export const SNAPSHOT_MEMO_MS = 2_000;
export const SNAPSHOT_EDGE_CACHE_SECONDS = 5;
export const SNAPSHOT_MAX_STALE_MS = 5 * 60_000;
export const SNAPSHOT_CACHE_PATH = '/__presence-cache/v1/snapshot';

/** History changes at most once per 5-minute bucket, so a minute of caching is plenty fresh. */
export const HISTORY_MEMO_MS = 30_000;
export const HISTORY_EDGE_CACHE_SECONDS = 60;
export const HISTORY_MAX_STALE_MS = 15 * 60_000;
export const HISTORY_CACHE_PATH = '/__presence-cache/v1/history';

export function isPresenceSnapshot(v: unknown): v is PresenceSnapshot {
  return typeof v === 'object' && v !== null && 'v' in v && v.v === PRESENCE_CONTRACT_VERSION && 'active' in v && typeof v.active === 'number'
    && 'owner' in v && typeof v.owner === 'object' && v.owner !== null && 'categories' in v && Array.isArray(v.categories);
}

export function isPresenceHistory(v: unknown): v is PresenceHistory {
  return typeof v === 'object' && v !== null && 'v' in v && v.v === PRESENCE_CONTRACT_VERSION && 'at' in v && typeof v.at === 'string'
    && 'bucketMinutes' in v && v.bucketMinutes === 5
    && 'buckets' in v && Array.isArray(v.buckets) && v.buckets.length === PRESENCE_HISTORY_BUCKETS;
}

const snapshotCache = createHubResponseCache<PresenceSnapshot>({
  path: SNAPSHOT_CACHE_PATH, memoMs: SNAPSHOT_MEMO_MS, edgeSeconds: SNAPSHOT_EDGE_CACHE_SECONDS, maxStaleMs: SNAPSHOT_MAX_STALE_MS,
  isValid: isPresenceSnapshot, label: 'snapshot',
});

const historyCache = createHubResponseCache<PresenceHistory>({
  path: HISTORY_CACHE_PATH, memoMs: HISTORY_MEMO_MS, edgeSeconds: HISTORY_EDGE_CACHE_SECONDS, maxStaleMs: HISTORY_MAX_STALE_MS,
  isValid: isPresenceHistory, label: 'history',
});

/** Clears both isolate memos (tests, and nothing else, need a cold isolate). */
export function resetSnapshotCache(): void {
  snapshotCache.reset();
  historyCache.reset();
}

/** Current public snapshot; `cacheOrigin` is the Worker's own origin, used for the edge-cache key. */
export const cachedSnapshot = (cacheOrigin: string, fromHub: () => Promise<PresenceSnapshot | null>): Promise<PresenceSnapshot | null> =>
  snapshotCache.get(cacheOrigin, fromHub);

/** Current public 24 h history, cached like the snapshot. */
export const cachedHistory = (cacheOrigin: string, fromHub: () => Promise<PresenceHistory | null>): Promise<PresenceHistory | null> =>
  historyCache.get(cacheOrigin, fromHub);
