/**
 * Registers an image that already sits in the media bucket (put there outside `storeImage`) so it becomes
 * a managed asset. Nothing is fetched from the network and no key is guessed: the caller names one object
 * under `articles/`, proves its SHA-256, and the bytes are read back from R2 and re-validated before any row
 * is written.
 */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { Row } from '../members/runtime';
import { iso, membersRuntime, randomId } from '../members/runtime';
import type { ImageBytes, MediaAsset } from './media-asset-store';
import {
  MAX_IMAGE_BYTES, MEDIA_PUBLIC_ORIGIN, cleanAlt, getMediaAsset, requireMediaBucket, rowToAsset, sha256Hex, validateImageBytes,
} from './media-asset-store';
import { readBounded } from './media-upload-sources';

const KEY_PATTERN = /^articles\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/){0,3}[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.(?:png|jpg|jpeg|gif|webp|avif)$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;

export interface ReconcileResult {
  asset: MediaAsset;
  /** False when the bytes or the key were already registered (the existing asset is returned). */
  created: boolean;
  /** Set when identical bytes were registered under another key: that registered object is used and this key stays unreferenced. */
  duplicate_of?: string;
}

function positiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new AppError(400, 'invalid_field', `${field} must be a positive integer`, { field });
  return value;
}

export function parseReconcileInput(args: Record<string, unknown>): { objectKey: string; sha256: string; width?: number; height?: number; alt: string } {
  const objectKey = typeof args.object_key === 'string' ? args.object_key.trim() : '';
  if (!objectKey || objectKey.includes('..') || !KEY_PATTERN.test(objectKey)) {
    throw new AppError(400, 'invalid_field', 'object_key must be a path under articles/ ending in .png, .jpg, .gif, .webp or .avif', { field: 'object_key' });
  }
  const sha256 = typeof args.sha256 === 'string' ? args.sha256.trim().toLowerCase() : '';
  if (!SHA_PATTERN.test(sha256)) throw new AppError(400, 'invalid_field', 'sha256 must be 64 hex characters', { field: 'sha256' });
  return { objectKey, sha256, width: positiveInt(args.width, 'width'), height: positiveInt(args.height, 'height'), alt: cleanAlt(args.alt) };
}

export async function reconcileMediaObject(
  d1: D1DatabaseLike, env: RuntimeEnv, args: Record<string, unknown>, actor: string,
): Promise<ReconcileResult> {
  const bucket = requireMediaBucket(env);
  const input = parseReconcileInput(args);

  const byKey = await d1.prepare('SELECT * FROM media_assets WHERE object_key = ?').bind(input.objectKey).first<Row>();
  if (byKey) {
    const asset = rowToAsset(byKey);
    if (asset.sha256 !== input.sha256) throw new AppError(409, 'object_key_conflict', 'This key is registered with different bytes', { asset_id: asset.id });
    return { asset, created: false };
  }
  const bySha = await d1.prepare('SELECT * FROM media_assets WHERE sha256 = ?').bind(input.sha256).first<Row>();
  if (bySha) {
    const asset = rowToAsset(bySha);
    return { asset, created: false, duplicate_of: asset.id };
  }

  const object = await bucket.get(input.objectKey);
  if (!object) throw new AppError(404, 'object_not_found', 'No object exists under this key in the media bucket', { object_key: input.objectKey });
  if (object.size > MAX_IMAGE_BYTES) throw new AppError(413, 'file_too_large', `Images must be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  const bytes: ImageBytes = await readBounded(object.body);
  const image = validateImageBytes(bytes);
  const actual = await sha256Hex(bytes);
  if (actual !== input.sha256) throw new AppError(422, 'sha256_mismatch', 'The stored object does not match the given sha256', { expected: input.sha256, actual });
  const keyExt = input.objectKey.slice(input.objectKey.lastIndexOf('.') + 1).replace('jpeg', 'jpg');
  if (keyExt !== image.ext) throw new AppError(422, 'extension_mismatch', `The bytes are ${image.mime} but the key ends in .${keyExt}`, { detected: image.ext });
  for (const [field, expected, found] of [['width', input.width, image.width], ['height', input.height, image.height]] as const) {
    if (expected !== undefined && expected !== found) throw new AppError(422, 'dimensions_mismatch', `${field} is ${found ?? 'unreadable'}, not ${expected}`, { field, expected, actual: found });
  }
  // Objects written by hand often lack the right headers; rewrite identical bytes with the detected type.
  if (object.httpMetadata?.contentType !== image.mime) {
    await bucket.put(input.objectKey, bytes, { httpMetadata: { contentType: image.mime, cacheControl: 'public, max-age=31536000, immutable' } });
  }

  const id = randomId('med');
  const inserted = await d1.prepare(
    `INSERT INTO media_assets (id, object_key, url, sha256, mime, size_bytes, width, height, alt, source_url, origin, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'reconcile', ?, ?) ON CONFLICT DO NOTHING`,
  ).bind(id, input.objectKey, `${MEDIA_PUBLIC_ORIGIN}/${input.objectKey}`, actual, image.mime, bytes.length, image.width, image.height,
    input.alt, actor, iso(membersRuntime.now())).run();
  if ((inserted.meta?.changes ?? 0) === 0) {
    const winner = await d1.prepare('SELECT * FROM media_assets WHERE sha256 = ? OR object_key = ?').bind(actual, input.objectKey).first<Row>();
    if (!winner) throw new AppError(500, 'internal_error', 'Media asset was not persisted');
    return { asset: rowToAsset(winner), created: false };
  }
  const asset = await getMediaAsset(d1, id);
  if (!asset) throw new AppError(500, 'internal_error', 'Media asset was not persisted');
  return { asset, created: true };
}
