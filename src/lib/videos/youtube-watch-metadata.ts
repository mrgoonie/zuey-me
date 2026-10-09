/**
 * Best-effort metadata from the public YouTube watch page (duration, publish date, description).
 * Used only at add/refetch time by admins; any failure returns empty metadata and never blocks the add.
 */
import type { FetchLike } from '../reads/anymd-client';
import { watchUrl } from './youtube-url';

export interface WatchMetadata {
  duration_seconds: number | null;
  published_at: string | null;
  description: string | null;
}

const EMPTY: WatchMetadata = { duration_seconds: null, published_at: null, description: null };
const TIMEOUT_MS = 6_000;

function jsonString(raw: string): string | null {
  try {
    const v: unknown = JSON.parse(`"${raw}"`);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** Extracts fields from watch-page HTML (pure; exported for tests). */
export function parseWatchHtml(html: string): WatchMetadata {
  const length = html.match(/"lengthSeconds":"(\d+)"/);
  const date = html.match(/"publishDate":"([^"]+)"/) ?? html.match(/itemprop="datePublished" content="([^"]+)"/);
  const desc = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
  let published: string | null = null;
  if (date) {
    const d = new Date(date[1]);
    published = Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const seconds = length ? Number(length[1]) : NaN;
  return {
    duration_seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    published_at: published,
    description: desc ? jsonString(desc[1])?.trim() || null : null,
  };
}

export async function fetchWatchMetadata(youtubeId: string, fetchImpl: FetchLike = fetch): Promise<WatchMetadata> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(watchUrl(youtubeId), {
      headers: { 'Accept-Language': 'en-US,en;q=0.8', 'User-Agent': 'Mozilla/5.0 (compatible; zuey.me Zueytube)' },
      signal: controller.signal,
    });
    if (!res.ok) return EMPTY;
    return parseWatchHtml(await res.text());
  } catch {
    return EMPTY;
  } finally {
    clearTimeout(timer);
  }
}
