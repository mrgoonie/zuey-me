/** Client-side validation of /api/v1/videos responses (untrusted JSON → typed values). */
import { isRecord } from '../home/storage';
import type { RelatedArticle, VideoEdition, VideoHit, VideoItem } from '../../lib/videos/types';
import { isTranscriptStatus, isVideoLocale } from '../../lib/videos/types';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const httpsUrl = (v: unknown): string | null => {
  const s = str(v);
  return s && /^https:\/\//.test(s) ? s : null;
};
const sameOrHttps = (v: unknown): string | null => {
  const s = str(v);
  return s && (/^https:\/\//.test(s) || s.startsWith('/')) ? s : null;
};

export function parseEdition(v: unknown): VideoEdition | null {
  if (!isRecord(v)) return null;
  const youtubeId = str(v.youtube_id);
  const videoId = str(v.video_id);
  const watch = httpsUrl(v.watch_url);
  const embed = httpsUrl(v.embed_url);
  if (!youtubeId || !/^[\w-]{11}$/.test(youtubeId) || !videoId || !watch || !embed || !isVideoLocale(v.locale)) return null;
  const edition: VideoEdition = {
    youtube_id: youtubeId,
    video_id: videoId,
    locale: v.locale,
    title: str(v.title) ?? youtubeId,
    description: str(v.description) ?? '',
    author: str(v.author) ?? '',
    thumbnail_url: httpsUrl(v.thumbnail_url),
    duration_seconds: num(v.duration_seconds),
    published_at: str(v.published_at),
    transcript_status: isTranscriptStatus(v.transcript_status) ? v.transcript_status : 'pending',
    transcript_error: str(v.transcript_error),
    transcript_fetched_at: str(v.transcript_fetched_at),
    word_count: num(v.word_count) ?? 0,
    watch_url: watch,
    embed_url: embed,
  };
  if ('transcript' in v) edition.transcript = str(v.transcript);
  return edition;
}

export function parseVideo(v: unknown): VideoItem | null {
  if (!isRecord(v) || !Array.isArray(v.editions)) return null;
  const id = str(v.id);
  if (!id) return null;
  const editions = v.editions.map(parseEdition).filter((e): e is VideoEdition => e !== null);
  if (editions.length === 0) return null;
  return {
    id,
    position: num(v.position) ?? 0,
    featured: v.featured === true,
    created_at: str(v.created_at) ?? '',
    updated_at: str(v.updated_at) ?? '',
    editions,
  };
}

export function parseVideoList(v: unknown): { items: VideoItem[]; total: number } | null {
  if (!isRecord(v) || !Array.isArray(v.items)) return null;
  const items = v.items.map(parseVideo).filter((x): x is VideoItem => x !== null);
  return { items, total: num(v.total) ?? items.length };
}

function parseRelatedArticle(v: unknown): RelatedArticle | null {
  if (!isRecord(v)) return null;
  const id = str(v.article_id);
  const slug = str(v.slug);
  const url = sameOrHttps(v.url);
  if (!id || !slug || !url) return null;
  return {
    article_id: id, slug, url, locale: str(v.locale) ?? 'vi', title: str(v.title) ?? slug, excerpt: str(v.excerpt) ?? '',
    access: v.access === 'knowledges' ? 'knowledges' : 'free',
  };
}

export interface VideoDetailView { video: VideoItem; related_articles: RelatedArticle[] }

export function parseVideoDetail(v: unknown): VideoDetailView | null {
  if (!isRecord(v)) return null;
  const video = parseVideo(v.video);
  if (!video) return null;
  const related = Array.isArray(v.related_articles)
    ? v.related_articles.map(parseRelatedArticle).filter((x): x is RelatedArticle => x !== null)
    : [];
  return { video, related_articles: related };
}

export function parseVideoHit(v: unknown): VideoHit | null {
  if (!isRecord(v)) return null;
  const videoId = str(v.video_id);
  const youtubeId = str(v.youtube_id);
  const url = sameOrHttps(v.url);
  const watch = httpsUrl(v.watch_url);
  if (!videoId || !youtubeId || !/^[\w-]{11}$/.test(youtubeId) || !url || !watch || !isVideoLocale(v.locale)) return null;
  return {
    video_id: videoId, youtube_id: youtubeId, locale: v.locale, title: str(v.title) ?? youtubeId, snippet: str(v.snippet) ?? '',
    thumbnail_url: httpsUrl(v.thumbnail_url), duration_seconds: num(v.duration_seconds), published_at: str(v.published_at),
    url, watch_url: watch, score: num(v.score) ?? 0,
  };
}

export function parseVideoHits(v: unknown): VideoHit[] | null {
  if (!isRecord(v) || !Array.isArray(v.results)) return null;
  return v.results.map(parseVideoHit).filter((x): x is VideoHit => x !== null);
}
