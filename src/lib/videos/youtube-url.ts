/** YouTube URL helpers shared by ingest, the store and the UI (no network access). */

const ID_RE = /^[\w-]{11}$/;

/**
 * Extracts the 11-character video id from any common YouTube link form
 * (watch, youtu.be, shorts, live, embed, nocookie) or a bare id. Returns null otherwise.
 */
export function parseYoutubeId(input: string): string | null {
  const raw = input.trim();
  if (ID_RE.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1] ?? null;
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/);
      id = m ? m[1] : null;
    }
  }
  return id && ID_RE.test(id) ? id : null;
}

export function watchUrl(youtubeId: string): string {
  return `https://www.youtube.com/watch?v=${youtubeId}`;
}

/** Privacy-enhanced embed (same host the article embed block uses). */
export function embedUrl(youtubeId: string, startSeconds?: number): string {
  const start = startSeconds && startSeconds > 0 ? `&start=${Math.floor(startSeconds)}` : '';
  return `https://www.youtube-nocookie.com/embed/${youtubeId}?rel=0&modestbranding=1${start}`;
}

export function thumbnailUrl(youtubeId: string): string {
  return `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
}

/** zuey.me page that opens the video in the Zueytube player. */
export function videoPageUrl(origin: string, youtubeId: string): string {
  return `${origin.replace(/\/+$/, '')}/videos?v=${youtubeId}`;
}

/** "m:ss" / "h:mm:ss" for a duration or offset in seconds. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
