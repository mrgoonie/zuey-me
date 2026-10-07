import type { D1DatabaseLike } from '../../db/store';
import type { ArticleSummary } from '../blocks/articles';
import { getArticleView } from '../blocks/articles';
import type { Viewer } from '../blocks/paywall';
import type { Locale } from '../i18n/locales';
import type { ArticleOgCard } from './article-og-card';
import { articleOgCard, articleOgHash, articleOgPath } from './article-og-card';
import { deleteOgImagesExcept, getStoredOgHash, getStoredOgImage, putStoredOgImage } from './article-og-store';

/** Draws a card to PNG bytes (the wasm renderer in production, a stub in tests). */
export type OgRender = (card: ArticleOgCard) => Promise<Uint8Array>;

/** Share images show only what anonymous readers see, so they are always rendered as one. */
const ANONYMOUS: Viewer = { isAdmin: false, entitlements: [] };

export interface ArticleOgImage {
  card: ArticleOgCard;
  hash: string;
  /** Versioned public path (`/articles/{slug}/og.png?lang=…&v=…`). */
  path: string;
}

/** Card, content hash and versioned URL path of one published edition's share image. */
export async function articleOgImage(article: ArticleSummary): Promise<ArticleOgImage> {
  const card = articleOgCard(article);
  const hash = await articleOgHash(card);
  return { card, hash, path: articleOgPath(article.slug, article.locale, hash) };
}

/** Returns the stored PNG for the current content, rendering and storing it first when stale or missing. */
export async function ensureArticleOgImage(
  db: D1DatabaseLike, article: ArticleSummary, render: OgRender,
): Promise<{ hash: string; png: Uint8Array }> {
  const { card, hash } = await articleOgImage(article);
  // Storage is an optimisation: when D1 is unavailable the image is still rendered and served.
  const stored = await getStoredOgImage(db, article.id, article.locale).catch(() => null);
  if (stored?.hash === hash) return stored;
  const png = await render(card);
  await putStoredOgImage(db, article.id, article.locale, hash, png)
    .catch(err => console.error('Share image store failed:', err instanceof Error ? err.message : 'unknown'));
  return { hash, png };
}

/**
 * Brings every published edition's image up to date after a write: renders editions whose content
 * changed and drops images of editions that are no longer published. Renders run one at a time to
 * keep background CPU bounded.
 */
export async function refreshArticleOgImages(db: D1DatabaseLike, articleId: string, slug: string, render: OgRender): Promise<void> {
  const primary = await getArticleView(db, slug, ANONYMOUS);
  if (!primary || primary.id !== articleId) {
    await deleteOgImagesExcept(db, articleId, []);
    return;
  }
  const published: Locale[] = [];
  for (const locale of primary.available_locales) {
    const view = locale === primary.locale ? primary : await getArticleView(db, slug, ANONYMOUS, { locale });
    if (!view || view.locale_fallback) continue;
    published.push(locale);
    const { card, hash } = await articleOgImage(view);
    if (await getStoredOgHash(db, articleId, locale) === hash) continue;
    await putStoredOgImage(db, articleId, locale, hash, await render(card));
  }
  await deleteOgImagesExcept(db, articleId, published);
}
