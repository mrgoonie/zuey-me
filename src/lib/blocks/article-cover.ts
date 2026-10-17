/**
 * Managed cover and social preview of an article. The cover is one media asset shared by every edition (no
 * body is rewritten); each edition keeps its own alt text. `social_preview.mode` decides what `og:image` and
 * Twitter cards show: the rendered share card, the cover, or a dedicated asset.
 */
import type { D1DatabaseLike, D1PreparedStatementLike } from '../../db/store';
import { AppError } from '../http';
import { LOCALES, isLocale } from '../i18n/locales';
import type { Locale } from '../i18n/locales';
import { cleanAlt, getMediaAsset } from '../media/media-asset-store';
import type { MediaAsset } from '../media/media-asset-store';
import type { Row } from '../members/runtime';
import { SOCIAL_PREVIEW_MODES, loadArticleRow, publicBodyImage } from './articles';
import type { SocialPreviewMode } from './articles';

export interface CoverSetInput {
  slug: string;
  expectedRevision: unknown;
  /** Media asset id for the cover, null to clear it, undefined to leave it. */
  assetId?: unknown;
  /** Alt text for every edition; `alts` overrides it per locale. */
  alt?: unknown;
  alts?: unknown;
  socialPreview?: unknown;
}

export interface CoverSetReceipt {
  operation_success: true;
  slug: string;
  revision: number;
  cover: { asset_id: string; url: string; width: number | null; height: number | null } | null;
  social_preview: { mode: SocialPreviewMode; asset_id: string | null; image_url: string | null };
  editions: Array<{ locale: Locale; published: boolean; cover_url: string | null; cover_alt: string }>;
  next_action: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function badField(field: string, message: string): AppError {
  return new AppError(400, 'invalid_field', message, { field });
}

async function requireAsset(db: D1DatabaseLike, id: unknown, field: string): Promise<MediaAsset> {
  if (typeof id !== 'string' || !id.trim()) throw badField(field, `${field} must be a media asset id (med_…)`);
  const asset = await getMediaAsset(db, id.trim());
  if (!asset) throw new AppError(404, 'media_not_found', 'No managed media asset has this id; upload it with media_upload_url / media_import or register it with media_reconcile', { field });
  return asset;
}

/** Per-locale alt text from `alt` (all editions) and `alts` (one locale each). */
function parseAlts(alt: unknown, alts: unknown): { all: string | undefined; byLocale: Map<Locale, string> } {
  if (alt !== undefined && typeof alt !== 'string') throw badField('alt', 'alt must be a string');
  const byLocale = new Map<Locale, string>();
  if (alts !== undefined) {
    if (!isRecord(alts)) throw badField('alts', 'alts must map locale codes to alt text');
    for (const [key, value] of Object.entries(alts)) {
      if (!isLocale(key)) throw badField(`alts.${key}`, `Unsupported locale; use one of ${LOCALES.join(', ')}`);
      if (typeof value !== 'string') throw badField(`alts.${key}`, 'Alt text must be a string');
      byLocale.set(key, cleanAlt(value));
    }
  }
  return { all: alt === undefined ? undefined : cleanAlt(alt), byLocale };
}

/** The image `og:image` should show, or null when the generated card is used (or the chosen asset is gone). */
export async function socialPreviewImage(
  db: D1DatabaseLike, preview: { mode: SocialPreviewMode; asset_id: string | null }, coverAssetId: string | null,
): Promise<MediaAsset | null> {
  if (preview.mode === 'custom_asset' && preview.asset_id) return getMediaAsset(db, preview.asset_id);
  if (preview.mode === 'cover' && coverAssetId) return getMediaAsset(db, coverAssetId);
  return null;
}

export async function setArticleCover(d1: D1DatabaseLike, input: CoverSetInput): Promise<CoverSetReceipt> {
  if (typeof input.expectedRevision !== 'number' || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw badField('expected_revision', 'expected_revision must be a positive integer');
  }
  const expected = input.expectedRevision;
  const touchesCover = input.assetId !== undefined;
  if (!touchesCover && input.socialPreview === undefined && input.alt === undefined && input.alts === undefined) {
    throw new AppError(400, 'invalid_field', 'Pass asset_id, alt/alts or social_preview', { field: 'asset_id' });
  }
  const art = await loadArticleRow(d1, input.slug);
  if (!art) throw new AppError(404, 'not_found', 'Article not found');

  const coverAsset = !touchesCover ? (art.coverAssetId ? await getMediaAsset(d1, art.coverAssetId) : null)
    : input.assetId === null ? null : await requireAsset(d1, input.assetId, 'asset_id');
  if (input.socialPreview !== undefined && !isRecord(input.socialPreview)) throw badField('social_preview', 'social_preview must be an object {mode, asset_id?}');
  const sp = isRecord(input.socialPreview) ? input.socialPreview : null;
  const mode = sp?.mode === undefined ? art.socialPreviewMode : SOCIAL_PREVIEW_MODES.find(m => m === sp.mode);
  if (!mode) throw badField('social_preview.mode', `mode must be one of ${SOCIAL_PREVIEW_MODES.join(', ')}`);
  let socialAsset: MediaAsset | null = null;
  if (mode === 'custom_asset') {
    socialAsset = await requireAsset(d1, sp?.asset_id ?? art.socialPreviewAssetId, 'social_preview.asset_id');
  } else if (sp?.asset_id !== undefined && sp.asset_id !== null) {
    throw badField('social_preview.asset_id', 'asset_id is only used with mode custom_asset');
  }
  if (mode === 'cover' && !coverAsset) {
    throw new AppError(400, 'cover_required', 'social_preview.mode "cover" needs a managed cover; set asset_id first', { field: 'social_preview.mode' });
  }

  const { all: allAlt, byLocale } = parseAlts(input.alt, input.alts);
  const { results } = await d1.prepare('SELECT * FROM article_editions WHERE article_id = ? AND deleted_at IS NULL').bind(art.id).all<Row>();
  const editions = (results ?? []).sort((x, y) => LOCALES.indexOf(String(x.locale) as Locale) - LOCALES.indexOf(String(y.locale) as Locale));
  for (const locale of byLocale.keys()) {
    if (!editions.some(e => e.locale === locale)) throw badField(`alts.${locale}`, `This article has no ${locale} edition`);
  }

  const coverChanged = touchesCover && (coverAsset?.id ?? null) !== art.coverAssetId;
  const now = new Date().toISOString();
  const revision = expected + 1;
  const statements: D1PreparedStatementLike[] = [
    d1.prepare(
      `UPDATE articles SET revision = ?, updated_at = ?, cover_asset_id = ?, social_preview_mode = ?, social_preview_asset_id = ?
       WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
    ).bind(revision, now, coverAsset?.id ?? null, mode, socialAsset?.id ?? null, art.id, expected),
  ];
  const next = editions.map(e => {
    const locale = String(e.locale) as Locale;
    const stored = typeof e.cover_alt === 'string' ? e.cover_alt : '';
    const alt = !coverAsset ? '' : byLocale.get(locale) ?? allAlt ?? (coverChanged ? '' : stored);
    const publishedJson = typeof e.published_json === 'string' ? e.published_json : null;
    let coverUrl: string | null = null;
    if (publishedJson) coverUrl = coverAsset?.url ?? publicBodyImage(publishedJson, art.access, art.slug);
    // Edition rows only change together with the article row: the guard fails when the revision check above did.
    statements.push(d1.prepare(
      `UPDATE article_editions SET cover_alt = ?, cover_url = CASE WHEN published_json IS NULL THEN cover_url ELSE ? END
       WHERE article_id = ? AND locale = ? AND EXISTS (SELECT 1 FROM articles WHERE id = ? AND revision = ? AND updated_at = ?)`,
    ).bind(alt, coverUrl, art.id, locale, art.id, revision, now));
    return { locale, published: publishedJson !== null, cover_url: coverUrl, cover_alt: alt };
  });
  const [cas] = await d1.batch(statements);
  if (!cas?.meta?.changes) {
    const current = await loadArticleRow(d1, input.slug);
    if (!current) throw new AppError(404, 'not_found', 'Article not found');
    throw new AppError(409, 'revision_conflict', 'Article was changed by someone else; reload and retry', { current_revision: current.revision });
  }

  const imageAsset = mode === 'cover' ? coverAsset : socialAsset;
  return {
    operation_success: true,
    slug: art.slug,
    revision,
    cover: coverAsset ? { asset_id: coverAsset.id, url: coverAsset.url, width: coverAsset.width, height: coverAsset.height } : null,
    social_preview: { mode, asset_id: socialAsset?.id ?? null, image_url: imageAsset?.url ?? null },
    editions: next,
    next_action: next.some(e => !e.published)
      ? 'Published editions use the cover now. Drafts pick it up when they are published.'
      : 'Every edition uses the cover now; no publish is needed.',
  };
}
