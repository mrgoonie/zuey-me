/** Full-text search over video titles, descriptions and transcripts (video_fts, BM25). */
import type { D1DatabaseLike } from '../../db/store';
import { buildMatchQuery, unspaceCjk } from '../search/text';
import type { VideoHit } from './types';
import { isVideoLocale } from './types';
import { thumbnailUrl, videoPageUrl, watchUrl } from './youtube-url';

type Row = Record<string, unknown>;
const s = (row: Row, key: string): string => (typeof row[key] === 'string' ? String(row[key]) : '');
const optNum = (row: Row, key: string): number | null => (row[key] === null || row[key] === undefined ? null : Number(row[key]));

/**
 * Runs a raw FTS5 MATCH expression and returns one hit per video (its best-ranked edition).
 * `match` must already be safe (built by buildMatchQuery or the related-keyword builder).
 */
export async function matchVideos(
  db: D1DatabaseLike, match: string, opts: { limit: number; origin: string; preferLocale?: string | null; excludeVideoId?: string },
): Promise<VideoHit[]> {
  const { results } = await db.prepare(`
    SELECT f.youtube_id, f.video_id, f.locale, snippet(video_fts, -1, '**', '**', '…', 18) AS snip,
      bm25(video_fts, 0.0, 0.0, 0.0, 8.0, 3.0, 1.0) AS score,
      e.title, e.thumbnail_url, e.duration_seconds, e.published_at
    FROM video_fts f JOIN video_editions e ON e.youtube_id = f.youtube_id
    WHERE video_fts MATCH ? ORDER BY score LIMIT ${Math.max(opts.limit * 3, 10)}
  `).bind(match).all<Row>();
  const best = new Map<string, VideoHit>();
  for (const r of results ?? []) {
    const videoId = s(r, 'video_id');
    if (videoId === opts.excludeVideoId) continue;
    const locale = s(r, 'locale');
    const youtubeId = s(r, 'youtube_id');
    // bm25() is negative (lower = better); expose a positive score.
    let score = -Number(r.score) || 0;
    if (opts.preferLocale && locale === opts.preferLocale) score *= 1.15;
    const hit: VideoHit = {
      video_id: videoId, youtube_id: youtubeId, locale: isVideoLocale(locale) ? locale : 'vi',
      title: s(r, 'title') || youtubeId, snippet: unspaceCjk(s(r, 'snip')),
      thumbnail_url: s(r, 'thumbnail_url') || thumbnailUrl(youtubeId),
      duration_seconds: optNum(r, 'duration_seconds'), published_at: s(r, 'published_at') || null,
      url: videoPageUrl(opts.origin, youtubeId), watch_url: watchUrl(youtubeId), score: Number(score.toFixed(6)),
    };
    const current = best.get(videoId);
    if (!current || hit.score > current.score) best.set(videoId, hit);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, opts.limit);
}

/** User-facing search (REST ?q=, ⌘K, knowledge_search). Returns [] when the query has no searchable terms. */
export async function searchVideos(
  db: D1DatabaseLike, query: string, opts: { limit?: number; origin: string; locale?: string | null },
): Promise<VideoHit[]> {
  const match = buildMatchQuery(query.trim().slice(0, 200));
  if (!match) return [];
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 5), 1), 50);
  return matchVideos(db, match, { limit, origin: opts.origin, preferLocale: opts.locale ?? null });
}
