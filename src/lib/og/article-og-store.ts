import type { D1DatabaseLike } from '../../db/store';
import type { Locale } from '../i18n/locales';

/** One edition's rendered share image (table `article_og_images`). */
export interface StoredOgImage {
  hash: string;
  png: Uint8Array;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function getStoredOgImage(db: D1DatabaseLike, articleId: string, locale: Locale): Promise<StoredOgImage | null> {
  const row = await db.prepare('SELECT hash, png_base64 FROM article_og_images WHERE article_id = ? AND locale = ?')
    .bind(articleId, locale).first<{ hash: string; png_base64: string }>();
  return row ? { hash: row.hash, png: fromBase64(row.png_base64) } : null;
}

/** Stored hash only (no image payload): enough to decide whether a re-render is needed. */
export async function getStoredOgHash(db: D1DatabaseLike, articleId: string, locale: Locale): Promise<string | null> {
  const row = await db.prepare('SELECT hash FROM article_og_images WHERE article_id = ? AND locale = ?')
    .bind(articleId, locale).first<{ hash: string }>();
  return row?.hash ?? null;
}

/** Replaces the edition's image; the previous hash's picture is gone afterwards. */
export async function putStoredOgImage(db: D1DatabaseLike, articleId: string, locale: Locale, hash: string, png: Uint8Array): Promise<void> {
  await db.prepare(`
    INSERT INTO article_og_images (article_id, locale, hash, png_base64, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (article_id, locale) DO UPDATE SET hash = excluded.hash, png_base64 = excluded.png_base64, created_at = excluded.created_at
  `).bind(articleId, locale, hash, toBase64(png), new Date().toISOString()).run();
}

/** Drops images of editions that are no longer published (or of a deleted article when `keep` is empty). */
export async function deleteOgImagesExcept(db: D1DatabaseLike, articleId: string, keep: Locale[]): Promise<void> {
  const placeholders = keep.map(() => '?').join(', ');
  const sql = keep.length
    ? `DELETE FROM article_og_images WHERE article_id = ? AND locale NOT IN (${placeholders})`
    : 'DELETE FROM article_og_images WHERE article_id = ?';
  await db.prepare(sql).bind(articleId, ...keep).run();
}
