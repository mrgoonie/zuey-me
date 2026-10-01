import type { D1DatabaseLike } from '../../db/store';

export interface ReadItem {
  id: string;
  url: string;
  title: string;
  author: string | null;
  description: string | null;
  domain: string | null;
  site: string | null;
  image: string | null;
  source_kind: string | null;
  language: string | null;
  published: string | null;
  tags: string;
  word_count: number | null;
  content_hash: string | null;
  summary: string | null;
  visible: boolean;
  anymd_updated_at: number | null;
  synced_at: string | null;
  created_at: string;
}

export interface ReadsSyncRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'success' | 'partial' | 'failed';
  fetched: number;
  tagged: number;
  summarized: number;
  unchanged: number;
  hidden: number;
  error: string | null;
}

export interface ReadsListQuery {
  q?: string;
  source?: string;
  limit?: number;
  offset?: number;
  includeHidden?: boolean;
}

export interface ReadsSourceFacet {
  source_kind: string;
  count: number;
}

export const MAX_READS_LIMIT = 500;

type Row = Record<string, unknown>;

function str(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' ? v : null;
}

function num(row: Row, key: string): number | null {
  const v = row[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  return null;
}

function rowToRead(row: Row): ReadItem {
  return {
    id: str(row, 'id') ?? '',
    url: str(row, 'url') ?? '',
    title: str(row, 'title') ?? '',
    author: str(row, 'author'),
    description: str(row, 'description'),
    domain: str(row, 'domain'),
    site: str(row, 'site'),
    image: str(row, 'image'),
    source_kind: str(row, 'source_kind'),
    language: str(row, 'language'),
    published: str(row, 'published'),
    tags: str(row, 'tags') ?? '',
    word_count: num(row, 'word_count'),
    content_hash: str(row, 'content_hash'),
    summary: str(row, 'summary'),
    visible: num(row, 'visible') === 1,
    anymd_updated_at: num(row, 'anymd_updated_at'),
    synced_at: str(row, 'synced_at'),
    created_at: str(row, 'created_at') ?? '',
  };
}

const RUN_STATUSES: ReadonlyArray<ReadsSyncRun['status']> = ['running', 'success', 'partial', 'failed'];

function rowToRun(row: Row): ReadsSyncRun {
  const status = RUN_STATUSES.find(s => s === row.status) ?? 'failed';
  return {
    id: str(row, 'id') ?? '',
    started_at: str(row, 'started_at') ?? '',
    finished_at: str(row, 'finished_at'),
    status,
    fetched: num(row, 'fetched') ?? 0,
    tagged: num(row, 'tagged') ?? 0,
    summarized: num(row, 'summarized') ?? 0,
    unchanged: num(row, 'unchanged') ?? 0,
    hidden: num(row, 'hidden') ?? 0,
    error: str(row, 'error'),
  };
}

function clampInt(v: number | undefined, min: number, max: number, fallback: number): number {
  if (v === undefined || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, ch => `\\${ch}`);
}

function buildWhere(query: ReadsListQuery): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!query.includeHidden) clauses.push('visible = 1');
  const source = query.source?.trim();
  if (source) {
    clauses.push('source_kind = ?');
    params.push(source);
  }
  const q = query.q?.trim().toLowerCase();
  if (q) {
    const like = `%${escapeLike(q)}%`;
    clauses.push(
      "(lower(title) LIKE ? ESCAPE '\\' OR lower(coalesce(summary, '')) LIKE ? ESCAPE '\\' OR lower(coalesce(site, '')) LIKE ? ESCAPE '\\' OR lower(coalesce(domain, '')) LIKE ? ESCAPE '\\')",
    );
    params.push(like, like, like, like);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** Lists reads newest first. Without a database there is nothing synced yet, so the list is empty. */
export async function listReads(d1: D1DatabaseLike | undefined, query: ReadsListQuery = {}): Promise<{ items: ReadItem[]; total: number }> {
  if (!d1) return { items: [], total: 0 };
  const limit = clampInt(query.limit, 1, MAX_READS_LIMIT, 50);
  const offset = clampInt(query.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const where = buildWhere(query);
  const { results } = await d1
    .prepare(`SELECT * FROM reads ${where.sql} ORDER BY coalesce(anymd_updated_at, 0) DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(...where.params, limit, offset)
    .all<Row>();
  const countRow = await d1.prepare(`SELECT count(*) AS n FROM reads ${where.sql}`).bind(...where.params).first<Row>();
  return { items: (results ?? []).map(rowToRead), total: countRow ? num(countRow, 'n') ?? 0 : 0 };
}

export async function listReadSources(d1: D1DatabaseLike | undefined): Promise<ReadsSourceFacet[]> {
  if (!d1) return [];
  const { results } = await d1
    .prepare("SELECT source_kind, count(*) AS n FROM reads WHERE visible = 1 AND source_kind IS NOT NULL AND source_kind != '' GROUP BY source_kind ORDER BY n DESC, source_kind ASC")
    .all<Row>();
  return (results ?? []).map(r => ({ source_kind: str(r, 'source_kind') ?? '', count: num(r, 'n') ?? 0 }));
}

export async function getRead(d1: D1DatabaseLike, id: string): Promise<ReadItem | null> {
  const row = await d1.prepare('SELECT * FROM reads WHERE id = ?').bind(id).first<Row>();
  return row ? rowToRead(row) : null;
}

export type ReadUpsert = Omit<ReadItem, 'visible' | 'created_at'>;

export async function upsertRead(d1: D1DatabaseLike, read: ReadUpsert): Promise<void> {
  await d1
    .prepare(
      `INSERT INTO reads (id, url, title, author, description, domain, site, image, source_kind, language, published, tags, word_count, content_hash, summary, visible, anymd_updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET url = excluded.url, title = excluded.title, author = excluded.author,
         description = excluded.description, domain = excluded.domain, site = excluded.site, image = excluded.image,
         source_kind = excluded.source_kind, language = excluded.language, published = excluded.published,
         tags = excluded.tags, word_count = excluded.word_count, content_hash = excluded.content_hash,
         summary = excluded.summary, visible = 1, anymd_updated_at = excluded.anymd_updated_at, synced_at = excluded.synced_at`,
    )
    .bind(
      read.id, read.url, read.title, read.author, read.description, read.domain, read.site, read.image,
      read.source_kind, read.language, read.published, read.tags, read.word_count, read.content_hash,
      read.summary, read.anymd_updated_at, read.synced_at,
    )
    .run();
}

/** Hides every visible read whose id is not in keepIds; returns the number hidden. */
export async function hideReadsNotIn(d1: D1DatabaseLike, keepIds: ReadonlySet<string>): Promise<number> {
  const { results } = await d1.prepare('SELECT id FROM reads WHERE visible = 1').all<Row>();
  let hidden = 0;
  for (const row of results ?? []) {
    const id = str(row, 'id');
    if (id && !keepIds.has(id)) {
      await d1.prepare('UPDATE reads SET visible = 0 WHERE id = ?').bind(id).run();
      hidden++;
    }
  }
  return hidden;
}

export async function insertSyncRun(d1: D1DatabaseLike, run: ReadsSyncRun): Promise<void> {
  await d1
    .prepare('INSERT INTO reads_sync_runs (id, started_at, finished_at, status, fetched, tagged, summarized, unchanged, hidden, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(run.id, run.started_at, run.finished_at, run.status, run.fetched, run.tagged, run.summarized, run.unchanged, run.hidden, run.error)
    .run();
}

export async function finishSyncRun(d1: D1DatabaseLike, run: ReadsSyncRun): Promise<void> {
  await d1
    .prepare('UPDATE reads_sync_runs SET finished_at = ?, status = ?, fetched = ?, tagged = ?, summarized = ?, unchanged = ?, hidden = ?, error = ? WHERE id = ?')
    .bind(run.finished_at, run.status, run.fetched, run.tagged, run.summarized, run.unchanged, run.hidden, run.error, run.id)
    .run();
}

export async function getLastSyncRun(d1: D1DatabaseLike | undefined): Promise<ReadsSyncRun | null> {
  if (!d1) return null;
  const row = await d1.prepare('SELECT * FROM reads_sync_runs ORDER BY started_at DESC LIMIT 1').first<Row>();
  return row ? rowToRun(row) : null;
}

/** Timestamp of the latest run that finished with usable data (success or partial). */
export async function getLastSyncedAt(d1: D1DatabaseLike | undefined): Promise<string | null> {
  if (!d1) return null;
  const row = await d1
    .prepare("SELECT finished_at FROM reads_sync_runs WHERE status IN ('success', 'partial') AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1")
    .first<Row>();
  return row ? str(row, 'finished_at') : null;
}
