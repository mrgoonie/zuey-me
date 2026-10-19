/**
 * Article images in the public R2 bucket `zuey-media` (https://media.zuey.me). Objects are keyed by the
 * SHA-256 of their bytes, so re-uploading an image returns the stored asset instead of a copy, and the
 * CDN may cache every object forever.
 */
import type { D1DatabaseLike } from '../../db/store';
import type { R2BucketLike, RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { iso, membersRuntime, randomId } from '../members/runtime';
import type { SniffedImage } from './image-sniff';
import { sniffImage } from './image-sniff';

export const MEDIA_PUBLIC_ORIGIN = 'https://media.zuey.me';
/** Largest image accepted from any source. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ALT = 500;
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Image bytes backed by a plain ArrayBuffer (what Web Crypto and fetch bodies accept). */
export type ImageBytes = Uint8Array<ArrayBuffer>;

export interface MediaAsset {
  id: string;
  url: string;
  object_key: string;
  sha256: string;
  mime: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  alt: string;
  source_url: string | null;
  created_by: string;
  created_at: string;
}

/** Image block ready to drop into an article document (`width`/`height` only when known). */
export interface MediaImageBlock { type: 'image'; url: string; alt: string; width?: number; height?: number }

export interface StoredMedia {
  asset: MediaAsset;
  /** False when identical bytes were already stored (the existing asset is returned). */
  created: boolean;
  block: MediaImageBlock;
  markdown: string;
}

function rowToAsset(r: Row): MediaAsset {
  const int = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    id: String(r.id), url: String(r.url), object_key: String(r.object_key), sha256: String(r.sha256), mime: String(r.mime),
    size_bytes: Number(r.size_bytes), width: int(r.width), height: int(r.height), alt: String(r.alt ?? ''),
    source_url: typeof r.source_url === 'string' ? r.source_url : null, created_by: String(r.created_by), created_at: String(r.created_at),
  };
}

export function cleanAlt(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_ALT) : '';
}

export function imageBlock(asset: MediaAsset, alt = asset.alt): MediaImageBlock {
  const block: MediaImageBlock = { type: 'image', url: asset.url, alt };
  if (asset.width && asset.height) { block.width = asset.width; block.height = asset.height; }
  return block;
}

function stored(asset: MediaAsset, created: boolean, alt: string): StoredMedia {
  const shownAlt = alt || asset.alt;
  return { asset, created, block: imageBlock(asset, shownAlt), markdown: `![${shownAlt.replace(/[[\]]/g, '')}](${asset.url})` };
}

export function requireMediaBucket(env: RuntimeEnv): R2BucketLike {
  if (!env.MEDIA) throw new AppError(503, 'media_unconfigured', 'Media storage is not configured: missing MEDIA (R2 binding)', { missing: ['MEDIA'] });
  return env.MEDIA;
}

export async function getMediaAsset(d1: D1DatabaseLike, id: string): Promise<MediaAsset | null> {
  const row = await d1.prepare('SELECT * FROM media_assets WHERE id = ?').bind(id).first<Row>();
  return row ? rowToAsset(row) : null;
}

async function sha256Hex(bytes: ImageBytes): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

/** Throws the 400/413/415 a caller should see unless the bytes are a supported image within the size cap. */
export function validateImageBytes(bytes: ImageBytes): SniffedImage {
  if (bytes.length === 0) throw new AppError(400, 'empty_file', 'The image is empty');
  if (bytes.length > MAX_IMAGE_BYTES) throw new AppError(413, 'file_too_large', `Images must be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  const image = sniffImage(bytes);
  if (!image) throw new AppError(415, 'unsupported_media_type', 'Only PNG, JPEG, GIF, WebP and AVIF images are accepted (SVG is not)');
  return image;
}

/** Validates the bytes as an image and stores them once; identical bytes return the existing asset. */
export async function storeImage(
  d1: D1DatabaseLike, env: RuntimeEnv, bytes: ImageBytes,
  input: { alt?: unknown; actor: string; sourceUrl?: string | null },
): Promise<StoredMedia> {
  const bucket = requireMediaBucket(env);
  const image = validateImageBytes(bytes);
  const alt = cleanAlt(input.alt);
  const sha256 = await sha256Hex(bytes);

  const existing = await d1.prepare('SELECT * FROM media_assets WHERE sha256 = ?').bind(sha256).first<Row>();
  if (existing) {
    const asset = rowToAsset(existing);
    if (alt && !asset.alt) {
      await d1.prepare('UPDATE media_assets SET alt = ? WHERE id = ?').bind(alt, asset.id).run();
      asset.alt = alt;
    }
    return stored(asset, false, alt);
  }

  const now = membersRuntime.now();
  const month = iso(now).slice(0, 7).replace('-', '/');
  const objectKey = `articles/${month}/${sha256.slice(0, 16)}.${image.ext}`;
  await bucket.put(objectKey, bytes, { httpMetadata: { contentType: image.mime, cacheControl: IMMUTABLE } });
  const id = randomId('med');
  // A concurrent upload of the same bytes (a retry, a double submit) may have inserted first; that row wins.
  const inserted = await d1.prepare(
    `INSERT INTO media_assets (id, object_key, url, sha256, mime, size_bytes, width, height, alt, source_url, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  ).bind(id, objectKey, `${MEDIA_PUBLIC_ORIGIN}/${objectKey}`, sha256, image.mime, bytes.length, image.width, image.height,
    alt, input.sourceUrl ?? null, input.actor, iso(now)).run();
  if ((inserted.meta?.changes ?? 0) === 0) {
    const winner = await d1.prepare('SELECT * FROM media_assets WHERE sha256 = ?').bind(sha256).first<Row>();
    if (!winner) throw new AppError(500, 'internal_error', 'Media asset was not persisted');
    const asset = rowToAsset(winner);
    // The winner stored under another month's key: drop the copy written above.
    if (asset.object_key !== objectKey) await bucket.delete(objectKey);
    return stored(asset, false, alt);
  }
  const asset = await getMediaAsset(d1, id);
  if (!asset) throw new AppError(500, 'internal_error', 'Media asset was not persisted');
  return stored(asset, true, alt);
}

export async function listMediaAssets(
  d1: D1DatabaseLike, opts: { limit?: number; page?: number; q?: string } = {},
): Promise<{ items: MediaAsset[]; total: number; page: number; limit: number }> {
  const limit = Math.min(100, Math.max(1, Math.trunc(opts.limit ?? 30)));
  const page = Math.max(1, Math.trunc(opts.page ?? 1));
  const q = (opts.q ?? '').trim();
  const where = q ? 'WHERE instr(lower(alt), lower(?)) > 0 OR instr(object_key, ?) > 0' : '';
  const params = q ? [q, q] : [];
  const total = await d1.prepare(`SELECT COUNT(*) AS n FROM media_assets ${where}`).bind(...params).first<{ n: number }>();
  const { results } = await d1.prepare(`SELECT * FROM media_assets ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(...params, limit, (page - 1) * limit).all<Row>();
  return { items: (results ?? []).map(rowToAsset), total: Number(total?.n ?? 0), page, limit };
}

/** Articles and course lessons whose current draft or published document uses the URL, and courses using it as cover. */
export async function mediaReferences(d1: D1DatabaseLike, url: string): Promise<{ articles: string[]; lessons: string[]; courses: string[] }> {
  const articles = await d1.prepare(
    `SELECT DISTINCT a.slug FROM article_editions e JOIN articles a ON a.id = e.article_id
     WHERE e.deleted_at IS NULL AND (instr(e.draft_json, ?) > 0 OR instr(COALESCE(e.published_json, ''), ?) > 0 OR e.cover_url = ?)`,
  ).bind(url, url, url).all<{ slug: string }>();
  const lessons = await d1.prepare(
    `SELECT DISTINCT slug FROM course_lessons WHERE instr(draft_json, ?) > 0 OR instr(COALESCE(published_json, ''), ?) > 0`,
  ).bind(url, url).all<{ slug: string }>();
  const courses = await d1.prepare('SELECT slug FROM courses WHERE cover_url = ?').bind(url).all<{ slug: string }>();
  return {
    articles: (articles.results ?? []).map(r => r.slug), lessons: (lessons.results ?? []).map(r => r.slug),
    courses: (courses.results ?? []).map(r => r.slug),
  };
}

/**
 * Deletes the object and its record, refusing while a current article or lesson document or a course cover
 * uses it. Objects are cached as immutable, so CDN and browser caches may keep serving a deleted image.
 */
export async function deleteMediaAsset(d1: D1DatabaseLike, env: RuntimeEnv, id: string): Promise<{ deleted: true; id: string; url: string }> {
  const bucket = requireMediaBucket(env);
  const asset = await getMediaAsset(d1, id);
  if (!asset) throw new AppError(404, 'media_not_found', 'Media asset not found');
  const refs = await mediaReferences(d1, asset.url);
  if (refs.articles.length || refs.lessons.length || refs.courses.length) {
    throw new AppError(409, 'media_in_use', 'Remove the image from these documents before deleting it', refs);
  }
  // Row first: if the object delete then fails, a re-upload stores the object again instead of matching a dead URL.
  await d1.prepare('DELETE FROM media_assets WHERE id = ?').bind(id).run();
  await bucket.delete(asset.object_key);
  return { deleted: true, id, url: asset.url };
}
