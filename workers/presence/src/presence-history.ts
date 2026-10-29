/**
 * 24-hour presence history for the PresenceHub: one aggregate per 5-minute bucket, kept in the hub's own
 * Durable Object storage (never D1).
 *
 * Per bucket the recorder keeps the peak unique `active` count and the per-category counts *at the moment of
 * that peak* (not independent per-category peaks), so a bucket's categories always add up to its peak and
 * describe one real moment.
 *
 * Storage: a single key (HISTORY_STORAGE_KEY) holding every recorded bucket of the window as compact numeric
 * tuples `[startMs, peak, ...countsInActivityCategoryOrder]`, plus `savedAt`. Raw counts stay inside the DO;
 * suppression (PRESENCE_MIN_GROUP) is applied when the history is published.
 *
 * Write-on-rise: a hibernating Durable Object loses its memory about 10 s after its last event, even with an
 * alarm pending, so no peak may wait in memory for a later write. The recorder writes during the same
 * observation whenever the current bucket's peak rises or a new bucket starts with someone live; one
 * observation writes at most once. Writes per bucket are therefore bounded by the number of times its peak
 * rises (at most the peak itself). Nothing is recorded while nobody is live, so idle time costs no writes and
 * no alarms. The in-memory copy is only a cache, loaded lazily from storage after each wake. A failed write
 * is logged and retried on the next observation.
 */
import {
  ACTIVITY_CATEGORIES, PRESENCE_CONTRACT_VERSION, PRESENCE_HISTORY_BUCKETS, PRESENCE_HISTORY_BUCKET_MS,
  type ActivityCategory, type PresenceHistory, type PresenceHistoryBucket,
} from '../../../src/lib/presence/contract';
import { countCategories, suppressedCategories } from './presence-state';
import type { DurableObjectStorageLike } from './runtime-types';

export const HISTORY_STORAGE_KEY = 'history';

const TUPLE_LENGTH = 2 + ACTIVITY_CATEGORIES.length;

interface HistoryBucket {
  /** Epoch ms of the bucket start (a multiple of PRESENCE_HISTORY_BUCKET_MS). */
  t: number;
  peak: number;
  /** Unique visitors per category at the moment of the peak, in ACTIVITY_CATEGORIES order. */
  counts: number[];
}

interface StoredHistory {
  savedAt: number;
  b: number[][];
}

export interface HistoryStats {
  buckets: number;
  oldest: string | null;
  storageBytes: number;
}

export const bucketStart = (ms: number): number => Math.floor(ms / PRESENCE_HISTORY_BUCKET_MS) * PRESENCE_HISTORY_BUCKET_MS;

/** Start of the oldest bucket in the 24 h window that ends with the bucket containing `now`. */
export const windowStart = (now: number): number => bucketStart(now) - (PRESENCE_HISTORY_BUCKETS - 1) * PRESENCE_HISTORY_BUCKET_MS;

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function isBucketTuple(v: unknown): v is number[] {
  return Array.isArray(v) && v.length === TUPLE_LENGTH && v.every(isCount) && (v[0] ?? 1) % PRESENCE_HISTORY_BUCKET_MS === 0;
}

function readStoredHistory(v: unknown): StoredHistory | null {
  if (typeof v !== 'object' || v === null) return null;
  if (!('savedAt' in v) || typeof v.savedAt !== 'number' || !('b' in v) || !Array.isArray(v.b)) return null;
  const b: number[][] = [];
  for (const tuple of v.b) if (isBucketTuple(tuple)) b.push(tuple);
  return { savedAt: v.savedAt, b };
}

function toBucket(tuple: readonly number[]): HistoryBucket {
  return { t: tuple[0] ?? 0, peak: tuple[1] ?? 0, counts: tuple.slice(2) };
}

const toTuple = (b: HistoryBucket): number[] => [b.t, b.peak, ...b.counts];

function countsOf(cats: readonly ActivityCategory[]): number[] {
  const counts = countCategories(cats);
  return ACTIVITY_CATEGORIES.map((id) => counts.get(id) ?? 0);
}

function publish(b: HistoryBucket): PresenceHistoryBucket {
  const counts = new Map<ActivityCategory, number>();
  ACTIVITY_CATEGORIES.forEach((id, i) => counts.set(id, b.counts[i] ?? 0));
  return { t: new Date(b.t).toISOString(), peak: b.peak, categories: suppressedCategories(b.peak, counts) };
}

export class PresenceHistoryRecorder {
  /** Recorded buckets, oldest first; the last one may be the bucket being filled. */
  private buckets: HistoryBucket[] = [];
  private loaded = false;
  /** In-memory buckets differ from storage (only between a failed write and its retry). */
  private dirty = false;
  private storageBytes = 0;

  constructor(private readonly storage: Pick<DurableObjectStorageLike, 'get' | 'put'>) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    const raw: unknown = await this.storage.get(HISTORY_STORAGE_KEY);
    const stored = readStoredHistory(raw);
    if (raw !== undefined && stored === null) console.error('presence history in storage is malformed; starting empty');
    if (stored) {
      this.buckets = stored.b.map(toBucket).sort((a, b) => a.t - b.t);
      this.storageBytes = JSON.stringify(stored).length;
    }
    this.loaded = true;
  }

  private prune(now: number): void {
    const oldest = windowStart(now);
    if (this.buckets.length > 0 && (this.buckets[0]?.t ?? oldest) < oldest) this.buckets = this.buckets.filter((b) => b.t >= oldest);
  }

  /**
   * Records the current counted visitors (one category per unique key) and, when the bucket's peak rose or a
   * new bucket started, writes before returning. A storage failure is logged and retried on a later
   * observation; presence itself keeps working.
   */
  async observe(now: number, cats: readonly ActivityCategory[]): Promise<void> {
    await this.load();
    const t = bucketStart(now);
    const active = cats.length;
    const last = this.buckets.at(-1);
    if (last && last.t === t) {
      if (active > last.peak) {
        last.peak = active;
        last.counts = countsOf(cats);
        this.dirty = true;
      }
    } else if (active > 0 && (!last || last.t < t)) {
      this.buckets.push({ t, peak: active, counts: countsOf(cats) });
      this.dirty = true;
    }
    if (this.dirty) await this.write(now);
  }

  private async write(now: number): Promise<void> {
    this.prune(now);
    const stored: StoredHistory = { savedAt: now, b: this.buckets.map(toTuple) };
    try {
      await this.storage.put(HISTORY_STORAGE_KEY, stored);
      this.dirty = false;
      this.storageBytes = JSON.stringify(stored).length;
    } catch (err) {
      console.error('presence history write failed', err instanceof Error ? err.message : 'unknown error');
    }
  }

  /** The published 24 h history: PRESENCE_HISTORY_BUCKETS buckets oldest first, gaps as peak 0, suppressed. */
  async toHistory(now: number): Promise<PresenceHistory> {
    await this.load();
    this.prune(now);
    const byStart = new Map<number, HistoryBucket>();
    for (const b of this.buckets) byStart.set(b.t, b);
    const first = windowStart(now);
    const buckets: PresenceHistoryBucket[] = [];
    for (let i = 0; i < PRESENCE_HISTORY_BUCKETS; i += 1) {
      const t = first + i * PRESENCE_HISTORY_BUCKET_MS;
      buckets.push(publish(byStart.get(t) ?? { t, peak: 0, counts: [] }));
    }
    return { v: PRESENCE_CONTRACT_VERSION, at: new Date(now).toISOString(), bucketMinutes: 5, buckets };
  }

  /** Recorded (non-empty) buckets in the window and the approximate size of the stored value. */
  async stats(now: number): Promise<HistoryStats> {
    await this.load();
    this.prune(now);
    const oldest = this.buckets[0];
    return { buckets: this.buckets.length, oldest: oldest ? new Date(oldest.t).toISOString() : null, storageBytes: this.storageBytes };
  }
}
