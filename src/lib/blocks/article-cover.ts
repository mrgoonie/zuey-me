/**
 * Cover and social preview of an article.
 *
 * Three images are kept apart: the first image inside the body (never configured), the cover (listings,
 * the hero above the body, email cards) and the social preview (`og:image`, Twitter card, JSON-LD). The
 * cover is a managed media asset shared by every locale; only its alt text is per locale. The social
 * preview is the generated card unless an admin picks the cover or another asset.
 */
import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import { LOCALES, isLocale } from '../i18n/locales';
import type { Locale } from '../i18n/locales';
import { cleanAlt, rowToAsset } from '../media/media-asset-store';
import type { MediaAsset } from '../media/media-asset-store';
import type { Row } from '../members/runtime';

export const SOCIAL_PREVIEW_MODES = ['generated_card', 'cover', 'custom_asset'] as const;
export type SocialPreviewMode = (typeof SOCIAL_PREVIEW_MODES)[number];

/** A managed image as article readers and agents see it. */
export interface CoverImage {
  asset_id: string;
  url: string;
  width: number | null;
  height: number | null;
  mime: string;
  alt: string;
}

export interface SocialPreview {
  /** Null while never configured: the generated card, and the first body image in JSON-LD (the legacy behaviour). */
  mode: SocialPreviewMode | null;
  asset_id: string | null;
  /** The image `og:image` uses for the `cover` and `custom_asset` modes; null for the generated card. */
  image: CoverImage | null;
}

/** Cover columns of an `articles` row. */
export interface CoverColumns {
  coverAssetId: string | null;
  socialMode: SocialPreviewMode | null;
  socialAssetId: string | null;
}

export function coverColumnsFromRow(r: Row): CoverColumns {
  const mode = SOCIAL_PREVIEW_MODES.find(m => m === r.social_preview_mode) ?? null;
  return {
    coverAssetId: typeof r.cover_asset_id === 'string' ? r.cover_asset_id : null,
    socialMode: mode,
    socialAssetId: typeof r.social_asset_id === 'string' ? r.social_asset_id : null,
  };
}

/** Media assets by id, for the covers and social images of the given articles. */
export async function loadCoverAssets(db: D1DatabaseLike, columns: CoverColumns[]): Promise<Map<string, MediaAsset>> {
  const ids = [...new Set(columns.flatMap(c => [c.coverAssetId, c.socialAssetId]).filter((id): id is string => id !== null))];
  const assets = new Map<string, MediaAsset>();
  // Ids come from our own rows; chunking keeps every query under D1's bound-parameter limit.
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { results } = await db.prepare(`SELECT * FROM media_assets WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<Row>();
    for (const r of results ?? []) assets.set(String(r.id), rowToAsset(r));
  }
  return assets;
}

function image(asset: MediaAsset, alt: string): CoverImage {
  return { asset_id: asset.id, url: asset.url, width: asset.width, height: asset.height, mime: asset.mime, alt };
}

/** Cover and social preview of one edition; an asset that no longer exists reads as not set. */
export function resolveCover(
  columns: CoverColumns, assets: Map<string, MediaAsset>, coverAlt: string,
): { cover: CoverImage | null; social_preview: SocialPreview } {
  const coverAsset = columns.coverAssetId ? assets.get(columns.coverAssetId) : undefined;
  const cover = coverAsset ? image(coverAsset, coverAlt || coverAsset.alt) : null;
  const customAsset = columns.socialAssetId ? assets.get(columns.socialAssetId) : undefined;
  const socialImage = columns.socialMode === 'cover' ? cover : columns.socialMode === 'custom_asset' && customAsset ? image(customAsset, customAsset.alt) : null;
  return { cover, social_preview: { mode: columns.socialMode, asset_id: columns.socialAssetId, image: socialImage } };
}

/** What a request to change the cover asks for, already checked for shape (not yet against the database). */
export interface CoverChange {
  /** Undefined keeps the cover; null removes it. */
  coverAssetId?: string | null;
  /** Alt text per locale; only locales with an edition. */
  alts: Array<[Locale, string]>;
  /** Undefined keeps the setting; null returns to the unconfigured behaviour. */
  social?: { mode: SocialPreviewMode; assetId: string | null } | null;
}

function field(name: string, message: string): never {
  throw new AppError(400, 'invalid_field', message, { field: name });
}

/**
 * Reads the body of a cover change. `alt` is one string for every edition or an object keyed by locale;
 * `social_preview` is `{ mode, asset_id? }` or null to return to the default.
 */
export function parseCoverChange(body: Record<string, unknown>, editionLocales: Locale[]): CoverChange {
  const change: CoverChange = { alts: [] };
  if (body.cover_asset_id !== undefined) {
    if (body.cover_asset_id !== null && (typeof body.cover_asset_id !== 'string' || !body.cover_asset_id.trim())) {
      field('cover_asset_id', 'cover_asset_id must be a managed media asset id (med_…) or null');
    }
    change.coverAssetId = body.cover_asset_id === null ? null : String(body.cover_asset_id).trim();
  }
  if (body.alt !== undefined) {
    if (typeof body.alt === 'string') {
      change.alts = editionLocales.map(l => [l, cleanAlt(body.alt)]);
    } else if (typeof body.alt === 'object' && body.alt !== null && !Array.isArray(body.alt)) {
      for (const [key, value] of Object.entries(body.alt)) {
        if (!isLocale(key)) field('alt', `alt has unknown locale "${key}"; use ${LOCALES.join(', ')}`);
        if (!editionLocales.includes(key)) field('alt', `The article has no ${key} edition`);
        if (typeof value !== 'string') field('alt', `alt.${key} must be a string`);
        change.alts.push([key, cleanAlt(value)]);
      }
    } else {
      field('alt', 'alt must be a string (all editions) or an object keyed by locale');
    }
  }
  if (body.social_preview !== undefined) {
    const sp = body.social_preview;
    if (sp === null) {
      change.social = null;
    } else if (typeof sp === 'object' && !Array.isArray(sp)) {
      const mode = SOCIAL_PREVIEW_MODES.find(m => m === (sp as Record<string, unknown>).mode);
      if (!mode) field('social_preview.mode', `social_preview.mode must be one of ${SOCIAL_PREVIEW_MODES.join(', ')}`);
      const assetId = (sp as Record<string, unknown>).asset_id;
      if (mode === 'custom_asset') {
        if (typeof assetId !== 'string' || !assetId.trim()) field('social_preview.asset_id', 'social_preview.asset_id is required for the custom_asset mode');
        change.social = { mode, assetId: String(assetId).trim() };
      } else {
        if (assetId !== undefined && assetId !== null) field('social_preview.asset_id', 'social_preview.asset_id is only used by the custom_asset mode');
        change.social = { mode: mode as SocialPreviewMode, assetId: null };
      }
    } else {
      field('social_preview', 'social_preview must be {mode, asset_id?} or null');
    }
  }
  if (change.coverAssetId === undefined && change.social === undefined && change.alts.length === 0) {
    field('cover_asset_id', 'Send at least one of cover_asset_id, alt or social_preview');
  }
  return change;
}

/** Throws unless every asset the change names is a stored image. */
export async function requireAssets(db: D1DatabaseLike, ids: Array<string | null | undefined>): Promise<void> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
  const found = await loadCoverAssets(db, wanted.map(id => ({ coverAssetId: id, socialMode: null, socialAssetId: null })));
  const missing = wanted.filter(id => !found.has(id));
  if (missing.length) throw new AppError(404, 'media_not_found', 'Media asset not found; upload or reconcile the image first and pass its id (med_…)', { asset_ids: missing });
}

/** Image tags of a page head: what `og:image`, Twitter and JSON-LD announce for one edition. */
export interface ShareImage { url: string; type: string; width: number | null; height: number | null; alt: string }

/** The generated 1200×630 PNG card, or the cover or custom asset the editor chose. */
export function articleShareImage(
  view: { title: string; social_preview: SocialPreview }, generatedUrl: string,
): ShareImage {
  const chosen = view.social_preview.image;
  if (chosen) return { url: chosen.url, type: chosen.mime, width: chosen.width, height: chosen.height, alt: chosen.alt || view.title };
  return { url: generatedUrl, type: 'image/png', width: 1200, height: 630, alt: view.title };
}
