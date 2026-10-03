import { LOCALE_LABELS } from '../i18n/locales';
import type { Locale } from '../i18n/locales';
import type { ArticleSummary } from './articles';

/**
 * URL scheme for article editions (one scheme for HTML and Markdown):
 *   HTML      /articles/{slug}?lang={locale}
 *   Markdown  /articles/{slug}.md?lang={locale}
 * Without ?lang the reader's locale (cookie / Accept-Language) picks an edition, falling back to the
 * primary edition; that unparameterised URL is the x-default. Each edition's canonical carries ?lang.
 */
export function articlePath(slug: string, locale?: Locale, markdown = false): string {
  return `/articles/${slug}${markdown ? '.md' : ''}${locale ? `?lang=${locale}` : ''}`;
}

export function articleUrl(origin: string, slug: string, locale?: Locale, markdown = false): string {
  return `${origin.replace(/\/$/, '')}${articlePath(slug, locale, markdown)}`;
}

export interface Alternate { hreflang: string; href: string }

/** hreflang alternates for every PUBLISHED edition plus x-default (translations are never machine-made). */
export function articleAlternates(origin: string, slug: string, locales: Locale[]): Alternate[] {
  if (locales.length === 0) return [];
  return [
    ...locales.map(l => ({ hreflang: LOCALE_LABELS[l].htmlLang, href: articleUrl(origin, slug, l) })),
    { hreflang: 'x-default', href: articleUrl(origin, slug) },
  ];
}

/** RFC 8288 Link header value carrying canonical and hreflang alternates (crawlers honour it like <link> tags). */
export function linkHeader(canonical: string, alternates: Alternate[]): string {
  // Article slugs are ASCII kebab-case and locales are fixed codes, so URLs need no further escaping.
  const quote = (u: string) => `<${u}>`;
  return [`${quote(canonical)}; rel="canonical"`, ...alternates.map(a => `${quote(a.href)}; rel="alternate"; hreflang="${a.hreflang}"`)].join(', ');
}

/** CSS class wrapping the members-only notice; JSON-LD hasPart points at it so crawlers see the paywall honestly. */
export const PAYWALL_SELECTOR = '.zb-paywalled';

/**
 * Article JSON-LD. Paid editions declare isAccessibleForFree=false and a hasPart WebPageElement for the
 * paywalled section (Google's subscription/paywalled content markup), never the hidden text itself.
 */
export function articleJsonLd(
  view: Pick<ArticleSummary, 'title' | 'excerpt' | 'slug' | 'locale' | 'access' | 'published_at' | 'updated_at' | 'cover_url' | 'tags' | 'category'>,
  origin: string,
  imageFallback: string,
): Record<string, unknown> {
  const paid = view.access === 'knowledges';
  const url = articleUrl(origin, view.slug, view.locale);
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: view.title.slice(0, 110),
    description: view.excerpt || undefined,
    inLanguage: LOCALE_LABELS[view.locale].htmlLang,
    url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    datePublished: view.published_at ?? undefined,
    dateModified: view.updated_at,
    image: [view.cover_url ?? imageFallback],
    keywords: view.tags.length ? view.tags.join(', ') : undefined,
    articleSection: view.category?.name,
    author: { '@type': 'Person', name: 'Duy Nguyen', url: origin },
    publisher: { '@type': 'Organization', name: 'Zuey', url: origin },
    isAccessibleForFree: !paid,
    ...(paid ? { hasPart: { '@type': 'WebPageElement', isAccessibleForFree: false, cssSelector: PAYWALL_SELECTOR } } : {}),
  };
}

/** Serialises JSON-LD for an inline <script>, escaping `<` so content can never close the tag. */
export function jsonLdScript(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
