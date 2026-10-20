/**
 * Responsive image URLs through Cloudflare Image Transformations (`/cdn-cgi/image/<options>/<source>`).
 *
 * The zuey.me zone has `image_resizing=on`, which resizes images from the same zone only: media.zuey.me
 * (public R2 bucket `zuey-media`), cdn.zuey.me (profile avatar) and zuey.me itself. Every other host is left untouched. Each distinct
 * source and option set counts as one unique transformation (free tier: 5,000 per month), so callers use
 * a small fixed set of widths.
 *
 * `/cdn-cgi/image` exists only on the production zone: `wrangler pages dev` and `*.pages.dev` previews
 * answer 404. Transformations are therefore off unless the request host is zuey.me or www.zuey.me, and the
 * `IMAGE_TRANSFORMS` variable can force them off ("off") or point them at a zone origin
 * ("https://zuey.me"), which lets a local build use the production transformer.
 */

/** Where transformed URLs are served from: '' for the current origin, or an absolute zone origin. */
export interface ImageTransforms { base: string }

export interface TransformOptions {
  width: number;
  /** With `fit: 'cover'`, crops to exactly width × height. */
  height?: number;
  fit?: 'cover' | 'scale-down';
  quality?: number;
}

export const DEFAULT_IMAGE_QUALITY = 80;
/** Candidate widths for article images (prose column up to ~780 CSS px at 1–2x). */
export const ARTICLE_IMAGE_WIDTHS = [480, 768, 1080, 1440] as const;

const PRODUCTION_HOSTS = new Set(['zuey.me', 'www.zuey.me']);
const ZONE_IMAGE_HOSTS = new Set(['zuey.me', 'www.zuey.me', 'media.zuey.me', 'cdn.zuey.me']);
const MAX_WIDTH = 2400;

/**
 * Transformation settings for a request host. `flag` is the `IMAGE_TRANSFORMS` variable:
 * "off" disables, an http(s) origin enables with absolute URLs, anything else defers to the host.
 */
export function imageTransformsFor(host: string, flag?: string): ImageTransforms | null {
  const value = (flag ?? '').trim();
  if (value === 'off') return null;
  if (/^https?:\/\/[^/]+$/i.test(value.replace(/\/$/, ''))) return { base: value.replace(/\/$/, '') };
  return PRODUCTION_HOSTS.has(host.toLowerCase()) ? { base: '' } : null;
}

/** True for images the zone may transform: media.zuey.me, cdn.zuey.me, zuey.me and site-relative paths (not SVG). */
export function isTransformableImage(url: string): boolean {
  const relative = url.startsWith('/') && !url.startsWith('//');
  let parsed: URL;
  try {
    parsed = relative ? new URL(url, 'https://zuey.me') : new URL(url);
  } catch {
    return false;
  }
  if (!relative && !(parsed.protocol === 'https:' && ZONE_IMAGE_HOSTS.has(parsed.hostname))) return false;
  if (parsed.pathname.startsWith('/cdn-cgi/')) return false;
  return !/\.svg$/i.test(parsed.pathname);
}

/** The transformed URL, or `url` unchanged when transformations are off or the image is not on the zone. */
export function transformImageUrl(url: string, opts: TransformOptions, transforms: ImageTransforms | null | undefined): string {
  if (!transforms || !isTransformableImage(url)) return url;
  const parts = [`width=${clampDimension(opts.width)}`];
  if (opts.height) parts.push(`height=${clampDimension(opts.height)}`);
  if (opts.fit) parts.push(`fit=${opts.fit}`);
  parts.push(`quality=${Math.round(Math.min(100, Math.max(1, opts.quality ?? DEFAULT_IMAGE_QUALITY)))}`, 'format=auto');
  const source = url.startsWith('/') ? url.slice(1) : url;
  return `${transforms.base}/cdn-cgi/image/${parts.join(',')}/${source}`;
}

function clampDimension(px: number): number {
  return Math.min(MAX_WIDTH, Math.max(1, Math.round(px)));
}

export interface ResponsiveImageAttrs {
  src: string;
  srcSet?: string;
  sizes?: string;
}

/**
 * `src`/`srcSet`/`sizes` for an image shown at a fluid width. Candidate widths above the image's own
 * width are dropped (no upscaling and no duplicate transformations); the intrinsic width is used instead.
 */
export function responsiveImage(
  url: string,
  intrinsicWidth: number | undefined,
  sizes: string,
  transforms: ImageTransforms | null | undefined,
  widths: readonly number[] = ARTICLE_IMAGE_WIDTHS,
): ResponsiveImageAttrs {
  if (!transforms || !isTransformableImage(url)) return { src: url };
  const candidates = intrinsicWidth && intrinsicWidth > 0
    ? [...new Set([...widths.filter(w => w < intrinsicWidth), Math.min(intrinsicWidth, widths[widths.length - 1])])]
    : [...widths];
  candidates.sort((a, b) => a - b);
  const srcSet = candidates.map(w => `${transformImageUrl(url, { width: w }, transforms)} ${w}w`).join(', ');
  // Fallback for browsers without srcset support: a middle size that suits the prose column.
  const fallback = candidates.filter(w => w <= 1080).pop() ?? candidates[0];
  return { src: transformImageUrl(url, { width: fallback }, transforms), srcSet, sizes };
}

/** `src`/`srcSet` for an image shown at a fixed CSS size (thumbnails), cropped to fill it at 1x and 2x. */
export function fixedSizeImage(url: string, width: number, height: number, transforms: ImageTransforms | null | undefined): ResponsiveImageAttrs {
  if (!transforms || !isTransformableImage(url)) return { src: url };
  const at = (scale: number) => transformImageUrl(url, { width: width * scale, height: height * scale, fit: 'cover' }, transforms);
  return { src: at(1), srcSet: `${at(1)} 1x, ${at(2)} 2x` };
}
