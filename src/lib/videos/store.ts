/** D1 persistence for Zueytube: videos, their language editions and the video_fts search rows. */
import type { D1DatabaseLike } from '../../db/store';
import { spaceCjk } from '../search/text';
import { transcriptPlainText } from './anymd-transcript-parser';
import type { TranscriptStatus, VideoEdition, VideoItem, VideoLocale } from './types';
import { isTranscriptStatus, isVideoLocale } from './types';
import { embedUrl, thumbnailUrl, watchUrl } from './youtube-url';

type Row = Record<string, unknown>;

const str = (row: Row, key: string): string => (typeof row[key] === 'string' ? String(row[key]) : '');
const optStr = (row: Row, key: string): string | null => (typeof row[key] === 'string' && row[key] !== '' ? String(row[key]) : null);
const optNum = (row: Row, key: string): number | null => {
  const v = row[key];
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const EDITION_COLUMNS = `youtube_id, video_id, locale, title, description, author, thumbnail_url, duration_seconds, published_at,
  transcript_status, transcript_error, transcript_fetched_at, word_count`;

function now(): string {
  return new Date().toISOString();
}

export function newVideoId(): string {
  return `vid_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function toEdition(row: Row, withTranscript: boolean): VideoEdition {
  const youtubeId = str(row, 'youtube_id');
  const locale = str(row, 'locale');
  const status = str(row, 'transcript_status');
  const edition: VideoEdition = {
    youtube_id: youtubeId,
    video_id: str(row, 'video_id'),
    locale: isVideoLocale(locale) ? locale : 'vi',
    title: str(row, 'title') || youtubeId,
    description: str(row, 'description'),
    author: str(row, 'author'),
    thumbnail_url: optStr(row, 'thumbnail_url') ?? thumbnailUrl(youtubeId),
    duration_seconds: optNum(row, 'duration_seconds'),
    published_at: optStr(row, 'published_at'),
    transcript_status: isTranscriptStatus(status) ? status : 'pending',
    transcript_error: optStr(row, 'transcript_error'),
    transcript_fetched_at: optStr(row, 'transcript_fetched_at'),
    word_count: optNum(row, 'word_count') ?? 0,
    watch_url: watchUrl(youtubeId),
    embed_url: embedUrl(youtubeId),
  };
  if (withTranscript) edition.transcript = optStr(row, 'transcript');
  return edition;
}

const LOCALE_ORDER: Record<VideoLocale, number> = { vi: 0, en: 1 };

function toItem(row: Row, editions: VideoEdition[]): VideoItem {
  return {
    id: str(row, 'id'),
    position: optNum(row, 'position') ?? 0,
    featured: Number(row.featured) === 1,
    created_at: str(row, 'created_at'),
    updated_at: str(row, 'updated_at'),
    editions: editions.sort((a, b) => LOCALE_ORDER[a.locale] - LOCALE_ORDER[b.locale]),
  };
}

async function editionsFor(db: D1DatabaseLike, videoIds: string[], withTranscript: boolean): Promise<Map<string, VideoEdition[]>> {
  const map = new Map<string, VideoEdition[]>();
  if (videoIds.length === 0) return map;
  const cols = withTranscript ? `${EDITION_COLUMNS}, transcript` : EDITION_COLUMNS;
  const { results } = await db.prepare(`SELECT ${cols} FROM video_editions WHERE video_id IN (${videoIds.map(() => '?').join(', ')})`)
    .bind(...videoIds).all<Row>();
  for (const row of results ?? []) {
    const e = toEdition(row, withTranscript);
    map.set(e.video_id, [...(map.get(e.video_id) ?? []), e]);
  }
  return map;
}

/** Curated order: featured first, then manual position, then newest added. */
export async function listVideos(db: D1DatabaseLike, opts: { limit?: number; offset?: number } = {}): Promise<{ items: VideoItem[]; total: number }> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 100), 1), 200);
  const offset = Math.max(Math.floor(opts.offset ?? 0), 0);
  const total = Number((await db.prepare('SELECT COUNT(*) AS n FROM videos').first<Row>())?.n ?? 0);
  const { results } = await db.prepare(
    `SELECT id, position, featured, created_at, updated_at FROM videos ORDER BY featured DESC, position ASC, created_at DESC LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all<Row>();
  const rows = results ?? [];
  const editions = await editionsFor(db, rows.map(r => str(r, 'id')), false);
  const items = rows.map(r => toItem(r, editions.get(str(r, 'id')) ?? [])).filter(v => v.editions.length > 0);
  return { items, total };
}

/** Looks a video up by its id or by any edition's YouTube id. */
export async function getVideo(db: D1DatabaseLike, idOrYoutubeId: string, opts: { transcript?: boolean } = {}): Promise<VideoItem | null> {
  const row = await db.prepare(
    `SELECT id, position, featured, created_at, updated_at FROM videos
     WHERE id = ? OR id = (SELECT video_id FROM video_editions WHERE youtube_id = ?)`,
  ).bind(idOrYoutubeId, idOrYoutubeId).first<Row>();
  if (!row) return null;
  const editions = await editionsFor(db, [str(row, 'id')], Boolean(opts.transcript));
  return toItem(row, editions.get(str(row, 'id')) ?? []);
}

export async function getEdition(db: D1DatabaseLike, youtubeId: string, opts: { transcript?: boolean } = {}): Promise<VideoEdition | null> {
  const cols = opts.transcript ? `${EDITION_COLUMNS}, transcript` : EDITION_COLUMNS;
  const row = await db.prepare(`SELECT ${cols} FROM video_editions WHERE youtube_id = ?`).bind(youtubeId).first<Row>();
  return row ? toEdition(row, Boolean(opts.transcript)) : null;
}

export async function createVideo(db: D1DatabaseLike, id: string): Promise<void> {
  const position = Number((await db.prepare('SELECT COALESCE(MIN(position), 0) - 1 AS p FROM videos').first<Row>())?.p ?? 0);
  const ts = now();
  await db.prepare('INSERT INTO videos (id, position, featured, created_at, updated_at) VALUES (?, ?, 0, ?, ?)').bind(id, position, ts, ts).run();
}

export interface EditionInsert {
  youtube_id: string;
  video_id: string;
  locale: VideoLocale;
  title: string;
  description?: string;
  author?: string;
  thumbnail_url?: string | null;
  duration_seconds?: number | null;
  published_at?: string | null;
}

export async function insertEdition(db: D1DatabaseLike, e: EditionInsert): Promise<void> {
  const ts = now();
  await db.prepare(
    `INSERT INTO video_editions (youtube_id, video_id, locale, title, description, author, thumbnail_url, duration_seconds, published_at,
       transcript_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).bind(e.youtube_id, e.video_id, e.locale, e.title, e.description ?? '', e.author ?? '', e.thumbnail_url ?? null,
    e.duration_seconds ?? null, e.published_at ?? null, ts, ts).run();
  await touchVideo(db, e.video_id);
}

export interface TranscriptUpdate {
  status: TranscriptStatus;
  transcript?: string | null;
  error?: string | null;
  word_count?: number;
  title?: string;
  description?: string;
  author?: string;
  thumbnail_url?: string | null;
  duration_seconds?: number | null;
  published_at?: string | null;
}

/** Stores a transcript fetch outcome; metadata fields only overwrite when a non-empty value is provided. */
export async function saveTranscriptResult(db: D1DatabaseLike, youtubeId: string, u: TranscriptUpdate): Promise<void> {
  const ts = now();
  const keepTranscript = u.status !== 'ready' && u.transcript === undefined;
  await db.prepare(
    `UPDATE video_editions SET
       transcript_status = ?, transcript_error = ?, transcript_fetched_at = ?,
       transcript = CASE WHEN ? THEN transcript ELSE ? END,
       word_count = CASE WHEN ? THEN word_count ELSE ? END,
       title = COALESCE(NULLIF(?, ''), title), description = COALESCE(NULLIF(?, ''), description),
       author = COALESCE(NULLIF(?, ''), author), thumbnail_url = COALESCE(?, thumbnail_url),
       duration_seconds = COALESCE(?, duration_seconds), published_at = COALESCE(?, published_at), updated_at = ?
     WHERE youtube_id = ?`,
  ).bind(u.status, u.error ?? null, ts,
    keepTranscript ? 1 : 0, u.transcript ?? null,
    keepTranscript ? 1 : 0, u.word_count ?? 0,
    u.title ?? '', u.description ?? '', u.author ?? '', u.thumbnail_url ?? null,
    u.duration_seconds ?? null, u.published_at ?? null, ts, youtubeId).run();
}

export interface EditionPatch { title?: string; description?: string; locale?: VideoLocale }

export async function updateEdition(db: D1DatabaseLike, youtubeId: string, patch: EditionPatch): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.title !== undefined) { sets.push('title = ?'); binds.push(patch.title); }
  if (patch.description !== undefined) { sets.push('description = ?'); binds.push(patch.description); }
  if (patch.locale !== undefined) { sets.push('locale = ?'); binds.push(patch.locale); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  binds.push(now(), youtubeId);
  await db.prepare(`UPDATE video_editions SET ${sets.join(', ')} WHERE youtube_id = ?`).bind(...binds).run();
}

export async function updateVideo(db: D1DatabaseLike, id: string, patch: { position?: number; featured?: boolean }): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.position !== undefined) { sets.push('position = ?'); binds.push(Math.floor(patch.position)); }
  if (patch.featured !== undefined) { sets.push('featured = ?'); binds.push(patch.featured ? 1 : 0); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  binds.push(now(), id);
  await db.prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
}

async function touchVideo(db: D1DatabaseLike, id: string): Promise<void> {
  await db.prepare('UPDATE videos SET updated_at = ? WHERE id = ?').bind(now(), id).run();
}

/** Removes one edition; the parent video is removed with its last edition. */
export async function deleteEdition(db: D1DatabaseLike, youtubeId: string): Promise<void> {
  const edition = await getEdition(db, youtubeId);
  if (!edition) return;
  await db.prepare('DELETE FROM video_fts WHERE youtube_id = ?').bind(youtubeId).run();
  await db.prepare('DELETE FROM video_editions WHERE youtube_id = ?').bind(youtubeId).run();
  const left = Number((await db.prepare('SELECT COUNT(*) AS n FROM video_editions WHERE video_id = ?').bind(edition.video_id).first<Row>())?.n ?? 0);
  if (left === 0) await db.prepare('DELETE FROM videos WHERE id = ?').bind(edition.video_id).run();
  else await touchVideo(db, edition.video_id);
}

export async function deleteVideo(db: D1DatabaseLike, id: string): Promise<void> {
  await db.prepare('DELETE FROM video_fts WHERE video_id = ?').bind(id).run();
  await db.prepare('DELETE FROM video_editions WHERE video_id = ?').bind(id).run();
  await db.prepare('DELETE FROM videos WHERE id = ?').bind(id).run();
}

/** Moves an edition under another video (re-pairing VI/EN uploads); empty source videos are removed. */
export async function moveEdition(db: D1DatabaseLike, youtubeId: string, targetVideoId: string): Promise<void> {
  const edition = await getEdition(db, youtubeId);
  if (!edition || edition.video_id === targetVideoId) return;
  await db.prepare('UPDATE video_editions SET video_id = ?, updated_at = ? WHERE youtube_id = ?').bind(targetVideoId, now(), youtubeId).run();
  const left = Number((await db.prepare('SELECT COUNT(*) AS n FROM video_editions WHERE video_id = ?').bind(edition.video_id).first<Row>())?.n ?? 0);
  if (left === 0) await db.prepare('DELETE FROM videos WHERE id = ?').bind(edition.video_id).run();
  await touchVideo(db, targetVideoId);
  await reindexEdition(db, youtubeId);
}

/** Rebuilds the search row of one edition (title, description, transcript text without timestamps). */
export async function reindexEdition(db: D1DatabaseLike, youtubeId: string): Promise<void> {
  await db.prepare('DELETE FROM video_fts WHERE youtube_id = ?').bind(youtubeId).run();
  const e = await getEdition(db, youtubeId, { transcript: true });
  if (!e) return;
  await db.prepare('INSERT INTO video_fts (youtube_id, video_id, locale, title, description, transcript) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(e.youtube_id, e.video_id, e.locale, spaceCjk(e.title), spaceCjk(e.description), spaceCjk(transcriptPlainText(e.transcript))).run();
}
