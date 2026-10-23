import { hashString, type D1DatabaseLike } from '../../db/store';
import {
  LAB200_FEEDS, parseLab200Feed, parseLab200Items,
  type Lab200Course, type Lab200Kind, type Lab200LearningPath,
} from './catalog';

/** A feed older than this is refreshed in the background after the response. */
export const LAB200_STALE_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
/** Upper bound on one feed response (courses.json was ~57 KB in October 2026). */
export const LAB200_MAX_FEED_BYTES = 1024 * 1024;

export interface Lab200Feed<T> {
  items: T[];
  /** Locale 200lab reported for this feed (e.g. "vi"); null before the first sync. */
  locale: string | null;
  /** Last valid fetch of this feed (ISO); null when it was never fetched. */
  syncedAt: string | null;
}

export interface Lab200Catalog {
  courses: Lab200Feed<Lab200Course>;
  learningPaths: Lab200Feed<Lab200LearningPath>;
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface Lab200Options {
  fetchImpl?: FetchImpl;
  /** Cloudflare `ctx.waitUntil`; without it a stale refresh runs detached (dev, tests). */
  waitUntil?: (promise: Promise<unknown>) => void;
  now?: () => Date;
}

/** D1 `kind` value for each feed. */
const ROW_KIND: Record<Lab200Kind, string> = { courses: 'courses', learningPaths: 'learning_paths' };

interface CatalogRow {
  kind: string;
  items_json: string;
  locale: string | null;
  synced_at: string | null;
  checked_at: string;
}

export function emptyLab200Catalog(): Lab200Catalog {
  return {
    courses: { items: [], locale: null, syncedAt: null },
    learningPaths: { items: [], locale: null, syncedAt: null },
  };
}

/** Body text, refusing anything larger than `max` bytes (by header or while streaming). */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new Error(`response larger than ${max} bytes`);
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      reader.cancel().catch(() => {});
      throw new Error(`response larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Fetch and validate one feed from its fixed 200lab URL. Redirects are not followed; HTTP errors,
 * timeouts, oversized bodies, invalid JSON and feeds that fail validation all throw.
 */
export async function fetchLab200Feed(kind: 'courses', fetchImpl?: FetchImpl): Promise<{ locale: string; items: Lab200Course[] }>;
export async function fetchLab200Feed(kind: 'learningPaths', fetchImpl?: FetchImpl): Promise<{ locale: string; items: Lab200LearningPath[] }>;
export async function fetchLab200Feed(kind: Lab200Kind, fetchImpl?: FetchImpl): Promise<{ locale: string; items: Array<Lab200Course | Lab200LearningPath> }>;
export async function fetchLab200Feed(kind: Lab200Kind, fetchImpl: FetchImpl = fetch): Promise<{ locale: string; items: Array<Lab200Course | Lab200LearningPath> }> {
  const { url } = LAB200_FEEDS[kind];
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status !== 200) throw new Error(`${url} returned HTTP ${res.status}`);
  const payload: unknown = JSON.parse(await readCapped(res, LAB200_MAX_FEED_BYTES));
  const parsed = parseLab200Feed(kind, payload);
  if (!parsed.ok) throw new Error(`${url} rejected: ${parsed.reason}`);
  return { locale: parsed.locale, items: parsed.items };
}

/**
 * Refresh one feed unless another request checked it within `LAB200_STALE_MS` (the conditional
 * update on `checked_at` lets exactly one request win). Returns true when a valid feed was saved.
 * Any failure keeps the previous items and `synced_at`, and so does a feed with fewer than half as
 * many valid items as the saved copy (schema drift upstream must not shrink the last good catalog).
 * An unchanged feed (same content hash) only moves `synced_at`.
 */
export async function refreshLab200Feed(d1: D1DatabaseLike, kind: Lab200Kind, opts: Lab200Options = {}): Promise<boolean> {
  const now = (opts.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - LAB200_STALE_MS).toISOString();
  const claim = await d1
    .prepare('UPDATE lab200_catalog SET checked_at = ? WHERE kind = ? AND checked_at < ?')
    .bind(now.toISOString(), ROW_KIND[kind], cutoff)
    .run();
  if (!claim.meta?.changes) return false;
  try {
    const feed = await fetchLab200Feed(kind, opts.fetchImpl);
    const saved = await d1
      .prepare('SELECT content_hash, CASE WHEN json_valid(items_json) THEN json_array_length(items_json) ELSE 0 END AS saved_count FROM lab200_catalog WHERE kind = ?')
      .bind(ROW_KIND[kind])
      .first<{ content_hash: string; saved_count: number }>();
    const savedCount = saved?.saved_count ?? 0;
    if (feed.items.length * 2 < savedCount) {
      throw new Error(`only ${feed.items.length} valid items against ${savedCount} saved`);
    }
    const json = JSON.stringify(feed.items);
    const hash = await hashString(`${feed.locale}\n${json}`);
    if (saved?.content_hash === hash) {
      await d1.prepare('UPDATE lab200_catalog SET synced_at = ? WHERE kind = ?').bind(now.toISOString(), ROW_KIND[kind]).run();
      return true;
    }
    await d1
      .prepare('UPDATE lab200_catalog SET items_json = ?, locale = ?, content_hash = ?, synced_at = ? WHERE kind = ?')
      .bind(json, feed.locale, hash, now.toISOString(), ROW_KIND[kind])
      .run();
    return true;
  } catch (err) {
    console.warn(`200lab ${kind} refresh failed; keeping the last good copy:`, err);
    return false;
  }
}

async function readRows(d1: D1DatabaseLike): Promise<Map<string, CatalogRow>> {
  const { results } = await d1
    .prepare('SELECT kind, items_json, locale, synced_at, checked_at FROM lab200_catalog')
    .all<CatalogRow>();
  return new Map((results ?? []).map(r => [r.kind, r]));
}

interface FeedSource<T> {
  kind: Lab200Kind;
  parse: (list: unknown) => T[];
  fetchLive: () => Promise<{ locale: string; items: T[] }>;
}

async function loadFeed<T>(
  d1: D1DatabaseLike | undefined,
  rows: Map<string, CatalogRow>,
  src: FeedSource<T>,
  opts: Lab200Options,
): Promise<Lab200Feed<T>> {
  const now = (opts.now ?? (() => new Date()))();
  if (!d1) {
    try {
      const feed = await src.fetchLive();
      return { items: feed.items, locale: feed.locale, syncedAt: now.toISOString() };
    } catch {
      return { items: [], locale: null, syncedAt: null };
    }
  }
  let row = rows.get(ROW_KIND[src.kind]);
  if (!row) return { items: [], locale: null, syncedAt: null };
  const parseRow = (r: CatalogRow): T[] => {
    try {
      return src.parse(JSON.parse(r.items_json));
    } catch {
      return [];
    }
  };
  let items = parseRow(row);
  if (items.length === 0) {
    if (await refreshLab200Feed(d1, src.kind, opts)) {
      row = (await readRows(d1)).get(ROW_KIND[src.kind]) ?? row;
      items = parseRow(row);
    }
  } else if (now.getTime() - Date.parse(row.checked_at) >= LAB200_STALE_MS) {
    const job = refreshLab200Feed(d1, src.kind, opts).catch(() => false);
    opts.waitUntil?.(job);
  }
  return { items, locale: row.locale, syncedAt: row.synced_at };
}

/**
 * Both catalogs for the 200lab app. Reads D1 and never waits for 200lab, except for a feed that
 * has no items yet (first request). Each stale feed is refreshed independently after the response,
 * so an outage of one feed never blocks or wipes the other. Without D1 (local dev) both are fetched live.
 */
export async function getLab200Catalog(d1: D1DatabaseLike | undefined, opts: Lab200Options = {}): Promise<Lab200Catalog> {
  let rows = new Map<string, CatalogRow>();
  if (d1) {
    try {
      rows = await readRows(d1);
    } catch (err) {
      // Code deployed before migration 0030: show an honest empty catalog instead of a 500.
      if (!/no such table: lab200_catalog/.test(err instanceof Error ? err.message : String(err))) throw err;
      console.warn('200lab: table lab200_catalog is missing (apply migration 0030); serving an empty catalog');
      return emptyLab200Catalog();
    }
  }
  const [courses, learningPaths] = await Promise.all([
    loadFeed(d1, rows, {
      kind: 'courses',
      parse: list => parseLab200Items('courses', list),
      fetchLive: () => fetchLab200Feed('courses', opts.fetchImpl),
    }, opts),
    loadFeed(d1, rows, {
      kind: 'learningPaths',
      parse: list => parseLab200Items('learningPaths', list),
      fetchLive: () => fetchLab200Feed('learningPaths', opts.fetchImpl),
    }, opts),
  ]);
  return { courses, learningPaths };
}
