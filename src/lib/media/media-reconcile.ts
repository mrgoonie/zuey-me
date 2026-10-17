/**
 * Registers an image that already sits in the media bucket (put there by a script or another service, so it
 * has no `media_assets` row) as a managed asset. The caller names one object and the SHA-256 it expects; the
 * server reads that object from its own bucket binding, never from a URL it was handed, and registers it only
 * when the bytes are a supported image with exactly that hash (and size, when given).
 */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { iso, membersRuntime, randomId } from '../members/runtime';
import type { Row } from '../members/runtime';
import type { ImageBytes, StoredMedia } from './media-asset-store';
import { MAX_IMAGE_BYTES, MEDIA_PUBLIC_ORIGIN, cleanAlt, requireMediaBucket, rowToAsset, sha256Hex, storedMedia, validateImageBytes } from './media-asset-store';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const MAX_KEY = 200;
/** Letters, digits, `.`, `_` and `-` in slash-separated segments that start with a letter or digit (no `.`, `..`, empty or encoded segments). */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export interface ReconcileResult extends StoredMedia {
  /** True when this call created the registry record. */
  reconciled: boolean;
  /** Set when other bytes' record already covered this image: the existing asset is returned and the named object is left alone. */
  duplicate_of_existing: boolean;
  /** Fields of the stored object that were rewritten (same bytes, same key). */
  repaired: string[];
}

/** The bucket key named by `object_key`, or by a `https://media.zuey.me/<key>` URL; anything else is refused. */
export function parseReconcileKey(input: { object_key?: unknown; url?: unknown }): string {
  const hasKey = input.object_key !== undefined && input.object_key !== null && input.object_key !== '';
  const hasUrl = input.url !== undefined && input.url !== null && input.url !== '';
  if (hasKey === hasUrl) throw new AppError(400, 'invalid_field', 'Send exactly one of object_key or url', { field: 'object_key' });
  let key: string;
  if (hasUrl) {
    let parsed: URL;
    try { parsed = new URL(String(input.url)); } catch { throw new AppError(400, 'invalid_field', 'url must be a valid URL', { field: 'url' }); }
    if (parsed.origin !== MEDIA_PUBLIC_ORIGIN || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new AppError(400, 'invalid_field', `url must be a plain ${MEDIA_PUBLIC_ORIGIN}/<key> URL`, { field: 'url' });
    }
    key = parsed.pathname.slice(1);
  } else {
    if (typeof input.object_key !== 'string') throw new AppError(400, 'invalid_field', 'object_key must be a string', { field: 'object_key' });
    key = input.object_key;
  }
  if (key.length > MAX_KEY || !KEY_RE.test(key)) {
    throw new AppError(400, 'invalid_field', 'The object key must be letters, digits, . _ - in slash-separated segments (no encoding, dot segments or empty segments)', { field: hasUrl ? 'url' : 'object_key' });
  }
  return key;
}

function expectedHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new AppError(400, 'invalid_field', 'sha256 must be the 64-character hex SHA-256 of the image bytes', { field: 'sha256' });
  }
  return value.toLowerCase();
}

function expectedSize(input: Record<string, unknown>, key: 'width' | 'height'): number | null {
  const v = input[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new AppError(400, 'invalid_field', `${key} must be a positive integer`, { field: key });
  return v;
}

export async function reconcileMediaObject(
  d1: D1DatabaseLike, env: RuntimeEnv, input: Record<string, unknown>, actor: string,
): Promise<ReconcileResult> {
  const bucket = requireMediaBucket(env);
  const key = parseReconcileKey(input);
  const sha256 = expectedHash(input.sha256);
  const width = expectedSize(input, 'width');
  const height = expectedSize(input, 'height');
  const alt = cleanAlt(input.alt);

  const byKey = await d1.prepare('SELECT * FROM media_assets WHERE object_key = ?').bind(key).first<Row>();
  if (byKey) {
    const asset = rowToAsset(byKey);
    if (asset.sha256 !== sha256) throw new AppError(409, 'media_key_conflict', 'This object key is registered with different bytes', { asset_id: asset.id });
    return { ...storedMedia(asset, false, alt), reconciled: false, duplicate_of_existing: false, repaired: [] };
  }

  const object = await bucket.get(key);
  if (!object) throw new AppError(404, 'object_not_found', 'No object with this key in the media bucket', { object_key: key });
  if (object.size > MAX_IMAGE_BYTES) throw new AppError(413, 'file_too_large', `Images must be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  const bytes: ImageBytes = new Uint8Array(await object.arrayBuffer());
  const image = validateImageBytes(bytes);
  const actual = await sha256Hex(bytes);
  if (actual !== sha256) throw new AppError(422, 'sha256_mismatch', 'The stored object does not have the expected SHA-256', { expected: sha256, actual });
  if ((width !== null && width !== image.width) || (height !== null && height !== image.height)) {
    throw new AppError(422, 'dimension_mismatch', 'The stored image does not have the expected size', {
      expected: { width, height }, actual: { width: image.width, height: image.height },
    });
  }

  const byHash = await d1.prepare('SELECT * FROM media_assets WHERE sha256 = ?').bind(actual).first<Row>();
  if (byHash) {
    // The same bytes are already managed under another key; point callers there instead of a second record.
    return { ...storedMedia(rowToAsset(byHash), false, alt), reconciled: false, duplicate_of_existing: true, repaired: [] };
  }

  // Same bytes, same key: only the metadata browsers and share crawlers read is corrected.
  const repaired: string[] = [];
  if (object.httpMetadata?.contentType !== image.mime) {
    await bucket.put(key, bytes, { httpMetadata: { contentType: image.mime, cacheControl: IMMUTABLE } });
    repaired.push('content_type');
  }

  const now = membersRuntime.now();
  const inserted = await d1.prepare(
    `INSERT INTO media_assets (id, object_key, url, sha256, mime, size_bytes, width, height, alt, source_url, origin, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'reconcile', ?, ?) ON CONFLICT DO NOTHING`,
  ).bind(randomId('med'), key, `${MEDIA_PUBLIC_ORIGIN}/${key}`, actual, image.mime, bytes.length, image.width, image.height, alt, actor, iso(now)).run();
  const row = await d1.prepare('SELECT * FROM media_assets WHERE object_key = ? OR sha256 = ?').bind(key, actual).first<Row>();
  if (!row) throw new AppError(500, 'internal_error', 'Media asset was not persisted');
  // A concurrent reconcile of the same object may have inserted first; that record wins.
  const created = (inserted.meta?.changes ?? 0) > 0;
  return { ...storedMedia(rowToAsset(row), created, alt), reconciled: created, duplicate_of_existing: false, repaired: created ? repaired : [] };
}
