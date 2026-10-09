/** Shared Zueytube types: curated YouTube videos grouped by language edition (VI/EN). */

export const VIDEO_LOCALES = ['vi', 'en'] as const;
export type VideoLocale = (typeof VIDEO_LOCALES)[number];

export const TRANSCRIPT_STATUSES = ['pending', 'ready', 'unavailable', 'failed'] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

export const ZUEYTUBE_CHANNEL_URL = 'https://www.youtube.com/@imzuey';
export const ZUEYTUBE_SUBSCRIBE_URL = 'https://www.youtube.com/@imzuey?sub_confirmation=1';

/** Window event other surfaces (⌘K) dispatch to open a video in the Zueytube window; `detail` is a YouTube or video id. */
export const ZUEYTUBE_OPEN_EVENT = 'zueytube:open';

export function isVideoLocale(value: unknown): value is VideoLocale {
  return value === 'vi' || value === 'en';
}

export function isTranscriptStatus(value: unknown): value is TranscriptStatus {
  return typeof value === 'string' && (TRANSCRIPT_STATUSES as readonly string[]).includes(value);
}

/** One YouTube upload (one language) of a curated video. */
export interface VideoEdition {
  youtube_id: string;
  video_id: string;
  locale: VideoLocale;
  title: string;
  description: string;
  author: string;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  published_at: string | null;
  transcript_status: TranscriptStatus;
  transcript_error: string | null;
  transcript_fetched_at: string | null;
  word_count: number;
  watch_url: string;
  embed_url: string;
  /** Present only on detail reads (`getVideo(..., { transcript: true })`). */
  transcript?: string | null;
}

/** A curated video: one or more language editions of the same content. */
export interface VideoItem {
  id: string;
  position: number;
  featured: boolean;
  created_at: string;
  updated_at: string;
  /** Editions ordered VI first, then EN. */
  editions: VideoEdition[];
}

/** One timestamped transcript chunk. */
export interface TranscriptSegment {
  /** Offset in seconds from the start of the video. */
  start: number;
  /** Display label, e.g. "1:05" or "1:02:03". */
  label: string;
  text: string;
}

/** Public article summary used for Article ↔ Video links. */
export interface RelatedArticle {
  article_id: string;
  slug: string;
  locale: string;
  title: string;
  excerpt: string;
  access: 'free' | 'knowledges';
  url: string;
}

/** Video summary used for Article ↔ Video links and search hits. */
export interface VideoHit {
  video_id: string;
  youtube_id: string;
  locale: VideoLocale;
  title: string;
  /** Matched text; `**` marks matched terms (no HTML). Empty for related links. */
  snippet: string;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  published_at: string | null;
  /** zuey.me page that plays the video. */
  url: string;
  watch_url: string;
  score: number;
}
