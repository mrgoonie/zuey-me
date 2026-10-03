import type { EmbedProvider } from './schema';

const HOST_PROVIDERS: Array<[RegExp, EmbedProvider]> = [
  [/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/, 'youtube'],
  [/(^|\.)vimeo\.com$/, 'vimeo'],
  [/(^|\.)soundcloud\.com$/, 'soundcloud'],
  [/(^|\.)spotify\.com$/, 'spotify'],
  [/(^|\.)(x\.com|twitter\.com)$/, 'x'],
  [/(^|\.)(facebook\.com|fb\.watch)$/, 'facebook'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)linkedin\.com$/, 'linkedin'],
];

export const PROVIDER_LABELS: Record<EmbedProvider, string> = {
  youtube: 'YouTube', vimeo: 'Vimeo', soundcloud: 'SoundCloud', spotify: 'Spotify', x: 'X',
  facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', linkedin: 'LinkedIn', generic: 'Link',
};

function parseUrl(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

export function detectProvider(url: string): EmbedProvider {
  const u = parseUrl(url);
  if (!u) return 'generic';
  const host = u.hostname.toLowerCase();
  for (const [re, provider] of HOST_PROVIDERS) if (re.test(host)) return provider;
  return 'generic';
}

/**
 * Iframe URL for a provider, or null when the content cannot be embedded safely
 * (generic links and unrecognised URLs fall back to a plain link).
 */
export function embedSrc(url: string, provider: EmbedProvider): string | null {
  const u = parseUrl(url);
  if (!u) return null;
  const path = u.pathname;
  switch (provider) {
    case 'youtube': {
      const id = u.hostname.endsWith('youtu.be')
        ? path.slice(1)
        : u.searchParams.get('v') ?? path.match(/\/(?:embed|shorts|live)\/([\w-]+)/)?.[1] ?? '';
      return /^[\w-]{6,20}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
    }
    case 'vimeo': {
      const id = path.match(/(\d{5,})/)?.[1];
      return id ? `https://player.vimeo.com/video/${id}` : null;
    }
    case 'soundcloud':
      return `https://w.soundcloud.com/player/?url=${encodeURIComponent(u.toString())}`;
    case 'spotify': {
      const m = path.match(/\/(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/);
      return m ? `https://open.spotify.com/embed/${m[1]}/${m[2]}` : null;
    }
    case 'x': {
      const id = path.match(/\/status\/(\d+)/)?.[1];
      return id ? `https://platform.twitter.com/embed/Tweet.html?id=${id}&dnt=true` : null;
    }
    case 'facebook': {
      const isVideo = u.hostname.endsWith('fb.watch') || /\/(videos|watch|reel)\b/.test(path);
      return `https://www.facebook.com/plugins/${isVideo ? 'video' : 'post'}.php?href=${encodeURIComponent(u.toString())}`;
    }
    case 'instagram': {
      const m = path.match(/\/(p|reel|tv)\/([\w-]+)/);
      return m ? `https://www.instagram.com/${m[1]}/${m[2]}/embed` : null;
    }
    case 'tiktok': {
      const id = path.match(/\/video\/(\d+)/)?.[1];
      return id ? `https://www.tiktok.com/embed/v2/${id}` : null;
    }
    case 'linkedin': {
      if (path.startsWith('/embed/')) return u.toString();
      const urn = path.match(/(urn:li:(?:share|ugcPost|activity):\d+)/)?.[1];
      return urn ? `https://www.linkedin.com/embed/feed/update/${urn}` : null;
    }
    default:
      return null;
  }
}

/** Frame shape used by the renderer so players reserve space before loading (no layout shift). */
export function embedFrame(provider: EmbedProvider, url: string): 'video' | 'audio' | 'vertical' | 'post' {
  if (provider === 'youtube') return /\/shorts\//.test(url) ? 'vertical' : 'video';
  if (provider === 'vimeo') return 'video';
  if (provider === 'soundcloud' || provider === 'spotify') return 'audio';
  if (provider === 'tiktok' || provider === 'instagram') return 'vertical';
  return 'post';
}

export interface EmbedRecognition {
  provider: EmbedProvider;
  label: string;
  /** Player URL; null when the URL is not embeddable and must be shown as a link. */
  src: string | null;
}

/** URL recognition shared by the editor (live preview) and the renderer. */
export function recognizeEmbed(url: string): EmbedRecognition {
  const provider = detectProvider(url);
  return { provider, label: PROVIDER_LABELS[provider], src: embedSrc(url, provider) };
}
