/**
 * Automatic Article ↔ Video links computed at read time from content: distinctive keywords of one
 * side are matched against the other side's FTS index. Only public text is used (free and preview
 * article rows), so paid full text never influences or leaks through related links.
 */
import type { D1DatabaseLike } from '../../db/store';
import { transcriptPlainText } from './anymd-transcript-parser';
import { keepStrong, relatedMatchQuery } from './related-keywords';
import type { RelatedArticle, VideoHit, VideoItem } from './types';
import { getVideo } from './store';
import { matchVideos } from './video-search';

type Row = Record<string, unknown>;
const s = (row: Row, key: string): string => (typeof row[key] === 'string' ? String(row[key]) : '');

/** Transcripts are long; the head carries most of the topic and keeps keyword extraction cheap. */
const TRANSCRIPT_CHARS = 12_000;
const BODY_CHARS = 12_000;

function parseTags(raw: string): string {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').join(' ') : '';
  } catch {
    return '';
  }
}

export async function relatedArticlesForVideo(
  db: D1DatabaseLike, video: VideoItem, opts: { origin: string; limit?: number; locale?: string | null },
): Promise<RelatedArticle[]> {
  const limit = opts.limit ?? 3;
  const withTranscript = video.editions.some(e => e.transcript !== undefined) ? video : await getVideo(db, video.id, { transcript: true });
  if (!withTranscript) return [];
  const match = relatedMatchQuery(withTranscript.editions.flatMap(e => [
    { text: e.title, weight: 3 },
    { text: e.description, weight: 1.5 },
    { text: transcriptPlainText(e.transcript).slice(0, TRANSCRIPT_CHARS), weight: 1 },
  ]));
  if (!match) return [];
  const { results } = await db.prepare(`
    SELECT article_id, locale, bm25(knowledge_fts, 0.0, 0.0, 0.0, 8.0, 4.0, 1.0) AS score
    FROM knowledge_fts WHERE knowledge_fts MATCH ? AND tier IN ('free', 'preview')
    ORDER BY score LIMIT 40
  `).bind(match).all<Row>();
  const preferred = opts.locale ?? withTranscript.editions[0]?.locale ?? 'vi';
  const best = new Map<string, { articleId: string; locale: string; score: number }>();
  for (const r of results ?? []) {
    const articleId = s(r, 'article_id');
    const locale = s(r, 'locale');
    const score = (-Number(r.score) || 0) * (locale === preferred ? 1.15 : 1);
    const cur = best.get(articleId);
    if (!cur || score > cur.score) best.set(articleId, { articleId, locale, score });
  }
  const ranked = keepStrong([...best.values()].sort((a, b) => b.score - a.score)).slice(0, limit);
  const origin = opts.origin.replace(/\/+$/, '');
  const out: RelatedArticle[] = [];
  for (const c of ranked) {
    const row = await db.prepare(`
      SELECT a.slug, a.access, e.title, e.excerpt FROM articles a JOIN article_editions e ON e.article_id = a.id
      WHERE a.id = ? AND e.locale = ? AND a.deleted_at IS NULL AND e.deleted_at IS NULL AND e.published_json IS NOT NULL
    `).bind(c.articleId, c.locale).first<Row>();
    if (!row) continue;
    const slug = s(row, 'slug');
    out.push({
      article_id: c.articleId, slug, locale: c.locale, title: s(row, 'title'), excerpt: s(row, 'excerpt'),
      access: row.access === 'knowledges' ? 'knowledges' : 'free',
      url: `${origin}/articles/${encodeURIComponent(slug)}?lang=${encodeURIComponent(c.locale)}`,
    });
  }
  return out;
}

export async function relatedVideosForArticle(
  db: D1DatabaseLike, articleId: string, locale: string, opts: { origin: string; limit?: number },
): Promise<VideoHit[]> {
  const article = await db.prepare('SELECT tags FROM articles WHERE id = ? AND deleted_at IS NULL').bind(articleId).first<Row>();
  if (!article) return [];
  const edition = await db.prepare(
    `SELECT title, excerpt FROM article_editions WHERE article_id = ? AND locale = ? AND deleted_at IS NULL AND published_json IS NOT NULL`,
  ).bind(articleId, locale).first<Row>();
  if (!edition) return [];
  // Public text only: the free row, or the preview row of a paid article.
  const body = await db.prepare(
    `SELECT tags, body FROM knowledge_fts WHERE article_id = ? AND locale = ? AND tier IN ('free', 'preview') LIMIT 1`,
  ).bind(articleId, locale).first<Row>();
  const match = relatedMatchQuery([
    { text: s(edition, 'title'), weight: 3 },
    { text: `${parseTags(s(article, 'tags'))} ${body ? s(body, 'tags') : ''}`, weight: 2 },
    { text: s(edition, 'excerpt'), weight: 1.5 },
    { text: body ? s(body, 'body').slice(0, BODY_CHARS) : '', weight: 1 },
  ]);
  if (!match) return [];
  const hits = await matchVideos(db, match, { limit: 10, origin: opts.origin, preferLocale: locale });
  return keepStrong(hits).slice(0, opts.limit ?? 3).map(h => ({ ...h, snippet: '' }));
}
