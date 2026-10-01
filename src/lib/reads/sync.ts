import { AppError } from '../http';
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AnyMdClient, hasTag, READS_TAG } from './anymd-client';
import type { AnyMdDocumentSummary, AnyMdLibraryPage, FetchLike } from './anymd-client';
import { createSummarizer } from './summarizer';
import type { Summarizer } from './summarizer';
import { finishSyncRun, getRead, hideReadsNotIn, insertSyncRun, upsertRead } from './store';
import type { ReadsSyncRun } from './store';

/** Safety cap on library pagination (100 items per page). */
export const MAX_LIBRARY_PAGES = 50;
const MAX_ERROR_LENGTH = 2000;

export interface SyncReadsOptions {
  d1: D1DatabaseLike;
  apiKey: string;
  summarizer: Summarizer;
  fetchImpl?: FetchLike;
  now?: () => Date;
  baseUrl?: string;
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
export async function syncReads(opts: SyncReadsOptions): Promise<ReadsSyncRun> {
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

  const finish = async (status: ReadsSyncRun['status']): Promise<ReadsSyncRun> => {
    run.status = status;
    run.finished_at = now().toISOString();
    run.error = errors.length ? errors.join('\n').slice(0, MAX_ERROR_LENGTH) : null;
    await finishSyncRun(opts.d1, run);
    return run;
  };

  // 1. Crawl every library page; AnyMD has no tag filter so we filter client-side.
  const tagged: AnyMdDocumentSummary[] = [];
  let crawlComplete = false;
  let cursor: number | null = null;
  for (let page = 0; page < MAX_LIBRARY_PAGES; page++) {
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
  for (const item of tagged) {
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

  // 3. Hide untagged rows only when we saw the complete tagged set.
  if (crawlComplete) run.hidden = await hideReadsNotIn(opts.d1, new Set(tagged.map(i => i.id)));

  return finish(errors.length ? 'partial' : 'success');
}

/** Builds a sync from runtime bindings, failing honestly when configuration is missing. */
export async function syncReadsFromEnv(env: RuntimeEnv, summarizer?: Summarizer): Promise<ReadsSyncRun> {
  const apiKey = env.ANYMD_API_KEY?.trim();
  if (!apiKey) throw new AppError(503, 'anymd_unconfigured', 'ANYMD_API_KEY is not configured; Zuey Reads cannot sync from AnyMD');
  const resolvedSummarizer = summarizer ?? createSummarizer(env.AI, env.READS_SUMMARY_MODEL);
  if (!env.DB) throw new AppError(503, 'db_unconfigured', 'D1 database binding (DB) is not configured; sync results cannot be stored');
  return syncReads({ d1: env.DB, apiKey, summarizer: resolvedSummarizer });
}
