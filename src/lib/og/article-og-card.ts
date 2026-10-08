import type { ArticleSummary } from '../blocks/articles';
import type { Locale } from '../i18n/locales';
import { knowledgeStrings } from '../../components/knowledge/strings';

/**
 * Bump when the image design changes: every card hash changes with it, so social networks see a new
 * og:image URL and re-fetch instead of keeping the old picture.
 */
export const OG_TEMPLATE_VERSION = 3;

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** Everything drawn on an article's share image, already localised. Nothing else influences the pixels. */
export interface ArticleOgCard {
  locale: Locale;
  title: string;
  excerpt: string;
  /** "Knowledges" badge for paid articles; null for free ones. */
  membersBadge: string | null;
  category: string | null;
  /** Up to three topic tag names. */
  tags: string[];
  /** Localised reading time ("9 phút"), or null when unknown. */
  readingTime: string | null;
  sectionTitle: string;
}

const MAX_TAGS = 3;

/** Derives the card from the reader-facing summary of one published edition. */
export function articleOgCard(article: ArticleSummary): ArticleOgCard {
  const t = knowledgeStrings(article.locale);
  return {
    locale: article.locale,
    title: article.title.trim(),
    excerpt: article.excerpt.trim(),
    membersBadge: article.access === 'knowledges' ? t.membersBadge : null,
    category: article.category?.name ?? null,
    tags: article.topic_tags.slice(0, MAX_TAGS).map(tag => tag.name),
    readingTime: article.reading_minutes > 0 ? t.minutes(article.reading_minutes) : null,
    sectionTitle: t.sectionTitle,
  };
}

/** Short content hash of the card and template version: the cache key and the og:image version. */
export async function articleOgHash(card: ArticleOgCard): Promise<string> {
  const payload = JSON.stringify({ v: OG_TEMPLATE_VERSION, card });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest).slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
}

/** Public path of an edition's share image; `v` changes whenever the drawn content changes. */
export function articleOgPath(slug: string, locale: Locale, hash: string): string {
  return `/articles/${slug}/og.png?lang=${locale}&v=${hash}`;
}
