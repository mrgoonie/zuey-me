import { AppError } from '../http';
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AnyMdClient, hasTag, parseDocumentSummary, READS_TAG } from './anymd-client';
import type { AnyMdDocumentSummary, AnyMdLibraryPage, FetchLike } from './anymd-client';
import { createSummarizer } from './summarizer';
import type { Summarizer } from './summarizer';
import { finishSyncRun, getRead, hideReadsNotIn, insertSyncRun, upsertRead } from './store';
import type { ReadsSyncRun } from './store';

/** Safety cap on library pagination (100 items per page). */
export const MAX_LIBRARY_PAGES = 50;
const MAX_ERROR_LENGTH = 2000;
/** Tagged items per batch for the manual paths (Studio button, MCP `reads_sync`); matches the scheduled workflow. */
export const DEFAULT_SYNC_BATCH_LIMIT = 3;
export const MAX_SYNC_BATCH_LIMIT = 100;
/** `job_cursors` row holding the library crawl of an unfinished batched pass. */
const SNAPSHOT_JOB = 'reads_sync';
/** A follow-up batch reuses the pass's crawl only while it is this fresh; older snapshots are re-crawled. */
export const LIBRARY_SNAPSHOT_TTL_MS = 15 * 60_000;
/** Stay well under D1's 2 MB value limit; a bigger library just re-crawls per batch. */
const MAX_SNAPSHOT_BYTES = 1_000_000;

export interface SyncReadsOptions {
  d1: D1DatabaseLike;
  apiKey: string;
  summarizer: Summarizer;
  fetchImpl?: FetchLike;
  now?: () => Date;
  baseUrl?: string;
  /** Tagged items to skip before this batch (position in crawl order). Defaults to 0. */
  offset?: number;
  /** Max tagged items to summarize in this call; omit to process every remaining item. */
  limit?: number;
}

/**
 * A sync run plus the offset for the next batch (`null` when this call finished the whole set) and whether
 * the library list came from a fresh crawl or the snapshot saved by the first batch of this pass.
 */
export type ReadsSyncBatch = ReadsSyncRun & { next_offset: number | null; library: 'crawled' | 'cached' };

/**
 * Validates optional `offset` / `limit` batch fields (REST body or MCP arguments).
 * Absent fields stay absent; the caller decides the default.
 */
export function parseSyncBatch(raw: unknown): Pick<SyncReadsOptions, 'offset' | 'limit'> {
  if (typeof raw !== 'object' || raw === null) return {};
  const batch: Pick<SyncReadsOptions, 'offset' | 'limit'> = {};
  if ('offset' in raw && raw.offset !== undefined) {
    if (typeof raw.offset !== 'number' || !Number.isInteger(raw.offset) || raw.offset < 0) {
      throw new AppError(400, 'invalid_offset', 'offset must be a non-negative integer');
    }
    batch.offset = raw.offset;
  }
  if ('limit' in raw && raw.limit !== undefined) {
    if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > MAX_SYNC_BATCH_LIMIT) {
      throw new AppError(400, 'invalid_limit', `limit must be an integer between 1 and ${MAX_SYNC_BATCH_LIMIT}`);
    }
    batch.limit = raw.limit;
  }
  return batch;
}

interface LibrarySnapshot {
  crawled_at: number;
  fetched: number;
  items: AnyMdDocumentSummary[];
}

/** Loads the crawl saved by this pass's first batch, or null when absent, stale or unreadable. */
async function loadLibrarySnapshot(d1: D1DatabaseLike, nowMs: number): Promise<LibrarySnapshot | null> {
  const row = await d1.prepare('SELECT cursor FROM job_cursors WHERE job = ?').bind(SNAPSHOT_JOB).first<Record<string, unknown>>();
  if (!row || typeof row.cursor !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.cursor);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || !('crawled_at' in parsed) || !('fetched' in parsed) || !('items' in parsed)) return null;
  const { crawled_at, fetched, items } = parsed;
  if (typeof crawled_at !== 'number' || typeof fetched !== 'number' || !Array.isArray(items)) return null;
  if (nowMs - crawled_at > LIBRARY_SNAPSHOT_TTL_MS || nowMs < crawled_at) return null;
  const tagged: AnyMdDocumentSummary[] = [];
  for (const raw of items) {
    const item = parseDocumentSummary(raw);
    if (!item) return null;
    tagged.push(item);
  }
  return { crawled_at, fetched, items: tagged };
}

async function saveLibrarySnapshot(d1: D1DatabaseLike, snapshot: LibrarySnapshot | null, nowIso: string): Promise<void> {
  const json = snapshot ? JSON.stringify(snapshot) : '';
  if (!snapshot || json.length > MAX_SNAPSHOT_BYTES) {
    await d1.prepare('DELETE FROM job_cursors WHERE job = ?').bind(SNAPSHOT_JOB).run();
    return;
  }
  await d1
    .prepare('INSERT INTO job_cursors (job, cursor, updated_at) VALUES (?, ?, ?) ON CONFLICT (job) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at')
    .bind(SNAPSHOT_JOB, json, nowIso)
    .run();
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function describeError(err: unknown): string {
  if (err instanceof AppError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : 'unknown error';
}

/**
 * Crawls the AnyMD library, keeps items tagged `zuey-reads`, summarizes new or changed content,
 * and hides rows that lost the tag. Raw article markdown is only hashed and summarized, never stored.
 */
export async function syncReads(opts: SyncReadsOptions): Promise<ReadsSyncBatch> {
  const now = opts.now ?? (() => new Date());
  const client = new AnyMdClient(opts.apiKey, opts.fetchImpl, opts.baseUrl);
  const errors: string[] = [];
  const run: ReadsSyncRun = {
    id: crypto.randomUUID(),
    started_at: now().toISOString(),
    finished_at: null,
    status: 'running',
    fetched: 0,
    tagged: 0,
    summarized: 0,
    unchanged: 0,
    hidden: 0,
    error: null,
  };
  await insertSyncRun(opts.d1, run);

  let nextOffset: number | null = null;
  let library: ReadsSyncBatch['library'] = 'crawled';
  const finish = async (status: ReadsSyncRun['status']): Promise<ReadsSyncBatch> => {
    run.status = status;
    run.finished_at = now().toISOString();
    run.error = errors.length ? errors.join('\n').slice(0, MAX_ERROR_LENGTH) : null;
    await finishSyncRun(opts.d1, run);
    return { ...run, next_offset: nextOffset, library };
  };

  const offset = Math.max(0, opts.offset ?? 0);
  // 1. Follow-up batches of a pass reuse the crawl saved by its first batch: AnyMD has no tag filter, so a
  // crawl reads the whole library, and repeating it per batch is the slowest part of a small batch. The
  // snapshot also freezes the tagged order, so items added mid-pass cannot shift the remaining offsets.
  const snapshot = offset > 0 ? await loadLibrarySnapshot(opts.d1, now().getTime()) : null;
  const tagged: AnyMdDocumentSummary[] = snapshot ? snapshot.items : [];
  let crawlComplete = snapshot !== null;
  if (snapshot) {
    library = 'cached';
    run.fetched = snapshot.fetched;
  }
  let cursor: number | null = null;
  for (let page = 0; !snapshot && page < MAX_LIBRARY_PAGES; page++) {
    let result: AnyMdLibraryPage;
    try {
      result = await client.listLibrary(cursor);
    } catch (err) {
      errors.push(`library page ${page + 1}: ${describeError(err)}`);
      if (page === 0) {
        await finish('failed');
        throw err;
      }
      break;
    }
    run.fetched += result.items.length;
    for (const item of result.items) if (hasTag(item.tags, READS_TAG)) tagged.push(item);
    if (result.next_cursor === null || result.items.length === 0) {
      crawlComplete = true;
      break;
    }
    cursor = result.next_cursor;
  }
  if (!crawlComplete && errors.length === 0) errors.push(`library crawl stopped at the ${MAX_LIBRARY_PAGES}-page safety cap`);
  run.tagged = tagged.length;

  // 2. Summarize new/changed items; skip the LLM when the content hash is unchanged.
  // A bounded batch keeps each HTTP request under the edge timeout; the caller loops on next_offset.
  const end = opts.limit === undefined ? tagged.length : Math.min(tagged.length, offset + Math.max(1, opts.limit));
  nextOffset = end < tagged.length ? end : null;
  // Keep a complete fresh crawl for the next batches; the final batch clears it so the next pass crawls again.
  if (nextOffset === null) await saveLibrarySnapshot(opts.d1, null, now().toISOString());
  else if (library === 'crawled' && crawlComplete) {
    await saveLibrarySnapshot(opts.d1, { crawled_at: now().getTime(), fetched: run.fetched, items: tagged }, now().toISOString());
  }
  for (const item of tagged.slice(offset, end)) {
    try {
      const markdown = await client.getMarkdown(item.id);
      const contentHash = await sha256Hex(markdown);
      const existing = await getRead(opts.d1, item.id);
      let summary: string;
      if (existing && existing.content_hash === contentHash && existing.summary) {
        summary = existing.summary;
        run.unchanged++;
      } else {
        summary = await opts.summarizer.summarize({ title: item.title, url: item.url, language: item.language, markdown });
        run.summarized++;
      }
      await upsertRead(opts.d1, {
        id: item.id,
        url: item.url,
        title: item.title,
        author: item.author,
        description: item.description,
        domain: item.domain,
        site: item.site,
        image: item.image,
        source_kind: item.source_kind,
        language: item.language,
        published: item.published,
        tags: item.tags,
        word_count: item.word_count,
        content_hash: contentHash,
        summary,
        anymd_updated_at: item.updated_at,
        synced_at: now().toISOString(),
      });
    } catch (err) {
      // Keep any existing row untouched; the next run retries this item.
      errors.push(`item ${item.id}: ${describeError(err)}`);
    }
  }

  // 3. Hide untagged rows only when we saw the complete tagged set, once the final batch runs.
  if (crawlComplete && nextOffset === null) run.hidden = await hideReadsNotIn(opts.d1, new Set(tagged.map(i => i.id)));

  return finish(errors.length ? 'partial' : 'success');
}

/** Builds a sync from runtime bindings, failing honestly when configuration is missing. */
export async function syncReadsFromEnv(
  env: RuntimeEnv,
  summarizer?: Summarizer,
  batch: Pick<SyncReadsOptions, 'offset' | 'limit'> = {},
): Promise<ReadsSyncBatch> {
  const apiKey = env.ANYMD_API_KEY?.trim();
  if (!apiKey) throw new AppError(503, 'anymd_unconfigured', 'ANYMD_API_KEY is not configured; Zuey Reads cannot sync from AnyMD');
  const resolvedSummarizer = summarizer ?? createSummarizer(env.AI, env.READS_SUMMARY_MODEL);
  if (!env.DB) throw new AppError(503, 'db_unconfigured', 'D1 database binding (DB) is not configured; sync results cannot be stored');
  return syncReads({ d1: env.DB, apiKey, summarizer: resolvedSummarizer, ...batch });
}
