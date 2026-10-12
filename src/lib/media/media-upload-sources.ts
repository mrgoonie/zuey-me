/**
 * The three ways an admin hands image bytes to the media store:
 * - a one-time upload URL (`PUT` the file with curl; bytes never pass through an MCP model),
 * - a public https URL the server fetches,
 * - inline base64 for small images (MCP clients without a shell).
 */
import type { D1DatabaseLike } from '../../db/store';
import { hashString } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { iso, membersRuntime, randomSecret } from '../members/runtime';
import type { ImageBytes, StoredMedia } from './media-asset-store';
import { MAX_IMAGE_BYTES, cleanAlt, requireMediaBucket, storeImage, validateImageBytes } from './media-asset-store';

/** Inline base64 is meant for small images; larger files use the upload URL. */
export const MAX_INLINE_BYTES = 2 * 1024 * 1024;
const TICKET_TTL_MS = 15 * 60 * 1000;
const IMPORT_TIMEOUT_MS = 20_000;
export const UPLOAD_PATH = '/api/v1/media/uploads/';

/** Reads a body stream, failing as soon as it grows past `max` bytes. */
export async function readBounded(body: ReadableStream<Uint8Array> | null, max = MAX_IMAGE_BYTES): Promise<ImageBytes> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new AppError(413, 'file_too_large', `Images must be at most ${Math.floor(max / 1024 / 1024)} MB`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

/** Accepts raw base64 or a `data:image/...;base64,` URL. */
export function decodeBase64Image(value: unknown): ImageBytes {
  if (typeof value !== 'string' || !value.trim()) throw new AppError(400, 'invalid_field', 'data_base64 is required', { field: 'data_base64' });
  const raw = value.trim().replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (raw.length > Math.ceil(MAX_INLINE_BYTES / 3) * 4 + 4) {
    throw new AppError(413, 'file_too_large', `Inline images must be at most ${MAX_INLINE_BYTES / 1024 / 1024} MB; use media_upload_url for larger files`);
  }
  let bin: string;
  try { bin = atob(raw); } catch { throw new AppError(400, 'invalid_field', 'data_base64 is not valid base64', { field: 'data_base64' }); }
  return Uint8Array.from(bin, ch => ch.charCodeAt(0));
}

/** Fetches a public https image and stores it. Redirects are not followed, so the URL must be final. */
export async function importImageFromUrl(
  d1: D1DatabaseLike, env: RuntimeEnv, rawUrl: unknown, input: { alt?: unknown; actor: string },
): Promise<StoredMedia> {
  requireMediaBucket(env);
  let url: URL;
  try { url = new URL(typeof rawUrl === 'string' ? rawUrl.trim() : ''); } catch { throw new AppError(400, 'invalid_field', 'url must be an absolute https URL', { field: 'url' }); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new AppError(400, 'invalid_field', 'url must be an https URL without credentials', { field: 'url' });
  let res: Response;
  try {
    res = await membersRuntime.fetch(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS), headers: { Accept: 'image/*' } });
  } catch {
    throw new AppError(502, 'media_fetch_failed', 'Could not download the image');
  }
  if (!res.ok) throw new AppError(502, 'media_fetch_failed', `The image URL answered HTTP ${res.status}${res.status >= 300 && res.status < 400 ? ' (redirect: pass the final URL)' : ''}`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) throw new AppError(413, 'file_too_large', `Images must be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  const bytes = await readBounded(res.body);
  return storeImage(d1, env, bytes, { alt: input.alt, actor: input.actor, sourceUrl: url.toString() });
}

/** Issues a one-time `PUT` URL valid for 15 minutes; only the token hash is stored. */
export async function createUploadTicket(
  d1: D1DatabaseLike, env: RuntimeEnv, siteOrigin: string, input: { alt?: unknown; actor: string },
) {
  requireMediaBucket(env);
  const now = membersRuntime.now();
  // Expired tickets have no further use; prune them while issuing a new one.
  await d1.prepare('DELETE FROM media_upload_tickets WHERE expires_at < ?').bind(iso(now - TICKET_TTL_MS)).run();
  const token = randomSecret(32);
  const expiresAt = iso(now + TICKET_TTL_MS);
  await d1.prepare('INSERT INTO media_upload_tickets (token_hash, alt, created_by, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await hashString(token), cleanAlt(input.alt), input.actor, expiresAt).run();
  const uploadUrl = `${siteOrigin.replace(/\/$/, '')}${UPLOAD_PATH}${token}`;
  return {
    upload_url: uploadUrl,
    method: 'PUT',
    expires_at: expiresAt,
    max_bytes: MAX_IMAGE_BYTES,
    accepted_types: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'],
    curl: `curl -sS --fail-with-body --upload-file ./image.png '${uploadUrl}'`,
    note: 'Single use. The response holds the stored asset and a ready image block.',
  };
}

/** Stores the body of a `PUT` to an upload URL, then burns the ticket. */
export async function consumeUploadTicket(
  d1: D1DatabaseLike, env: RuntimeEnv, token: string, body: ReadableStream<Uint8Array> | null,
): Promise<StoredMedia> {
  requireMediaBucket(env);
  const tokenHash = await hashString(token);
  const nowIso = iso(membersRuntime.now());
  const ticket = await d1.prepare('SELECT alt, created_by FROM media_upload_tickets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
    .bind(tokenHash, nowIso).first<{ alt: string; created_by: string }>();
  if (!ticket) throw new AppError(404, 'upload_url_invalid', 'This upload URL is unknown, expired or already used');
  const bytes = await readBounded(body);
  // Validate before burning the ticket so a wrong file can be retried with the same URL.
  validateImageBytes(bytes);
  const claimed = await d1.prepare('UPDATE media_upload_tickets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
    .bind(nowIso, tokenHash, nowIso).run();
  if ((claimed.meta?.changes ?? 0) !== 1) throw new AppError(404, 'upload_url_invalid', 'This upload URL is unknown, expired or already used');
  const result = await storeImage(d1, env, bytes, { alt: ticket.alt, actor: ticket.created_by });
  await d1.prepare('UPDATE media_upload_tickets SET asset_id = ? WHERE token_hash = ?').bind(result.asset.id, tokenHash).run();
  return result;
}
