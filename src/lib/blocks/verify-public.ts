import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import { LOCALES, LOCALE_LABELS } from '../i18n/locales';
import type { Locale } from '../i18n/locales';
import { getArticleNotification } from '../notifications/article-notification-schedule';
import type { ArticleNotification } from '../notifications/article-notification-schedule';
import { getArticle } from './articles';
import { articleUrl } from './seo';
import { contentHash } from './stable-json';

/** Image hosts verify may probe: the site itself and the first-party media bucket, never arbitrary URLs. */
const MEDIA_HOST = 'media.zuey.me';
const PAGE_TIMEOUT_MS = 10_000;

export interface ImageProbe {
  url: string;
  /** False when the URL was not requested (host outside the allowlist) or the request failed. */
  checked: boolean;
  reachable: boolean;
  status: number | null;
  content_type: string | null;
  reason?: string;
}

export interface LocaleVerification {
  locale: Locale;
  url: string;
  ok: boolean;
  /** Names of the checks that did not pass; empty when ok. */
  failed_checks: string[];
  http_status: number | null;
  title: string | null;
  html_lang: string | null;
  canonical: string | null;
  hreflang: string[];
  access: 'free' | 'knowledges';
  /** True when the anonymous page carries the members-only notice (expected for paid articles). */
  paywall_marker: boolean;
  cover_url: string | null;
  og_image: ImageProbe | null;
  twitter_image: string | null;
  json_ld_image: string | null;
  cover_image: ImageProbe | null;
  published_revision: number | null;
  /** Hash of the stored published document of this edition (the content the page was rendered from). */
  document_hash: string | null;
  html_bytes: number;
}

export interface VerifyPublicResult {
  slug: string;
  origin: string;
  ok: boolean;
  checked_at: string;
  locales: LocaleVerification[];
  /** Email scheduled for the article's first publish; null when none was ever scheduled. */
  email_notification: ArticleNotification | null;
  /** What this check cannot tell yet, so an absent field is never read as "fine". */
  not_tracked: string[];
}

interface Tag { name: string; attrs: Record<string, string> }

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'" };
const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, m => ENTITIES[m] ?? m);

/** `<meta>` and `<link>` tags of an HTML document with decoded attribute values. */
function headTags(html: string): Tag[] {
  const tags: Tag[] = [];
  for (const m of html.matchAll(/<(meta|link)\b([^>]*)>/gi)) {
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? '');
    tags.push({ name: m[1].toLowerCase(), attrs });
  }
  return tags;
}

function jsonLdImage(html: string): string | null {
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data: unknown = JSON.parse(m[1]);
      if (data && typeof data === 'object' && 'image' in data) {
        const image = (data as { image: unknown }).image;
        const first = Array.isArray(image) ? image[0] : image;
        if (typeof first === 'string') return first;
      }
    } catch { /* malformed JSON-LD is reported as a missing image */ }
  }
  return null;
}

async function probeImage(url: string, origin: string, fetcher: typeof fetch): Promise<ImageProbe> {
  let parsed: URL;
  try { parsed = new URL(url, origin); } catch { return { url, checked: false, reachable: false, status: null, content_type: null, reason: 'invalid_url' }; }
  if (parsed.origin !== new URL(origin).origin && parsed.hostname !== MEDIA_HOST) {
    return { url, checked: false, reachable: false, status: null, content_type: null, reason: 'host_not_allowed' };
  }
  const target = parsed.toString();
  try {
    let res = await fetcher(target, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    if (res.status === 405 || res.status === 501) res = await fetcher(target, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    const content_type = res.headers.get('content-type');
    await res.body?.cancel();
    return { url: target, checked: true, reachable: res.status === 200 && (content_type ?? '').startsWith('image/'), status: res.status, content_type };
  } catch {
    return { url: target, checked: false, reachable: false, status: null, content_type: null, reason: 'request_failed' };
  }
}

async function verifyLocale(
  d1: D1DatabaseLike, slug: string, locale: Locale, origin: string, publishedHreflangs: string[], fetcher: typeof fetch,
): Promise<LocaleVerification> {
  const url = articleUrl(origin, slug, locale);
  const rec = await getArticle(d1, slug, { locale, publishedOnly: true });
  const edition = rec && !rec.locale_fallback ? rec : null;
  const base = {
    locale, url, http_status: null, title: null, html_lang: null, canonical: null, hreflang: [], paywall_marker: false,
    cover_url: edition?.cover_url ?? null, og_image: null, twitter_image: null, json_ld_image: null, cover_image: null,
    published_revision: edition?.published_revision ?? null, document_hash: edition?.published ? await contentHash(edition.published) : null,
    html_bytes: 0, access: edition?.access ?? 'free',
  } satisfies Omit<LocaleVerification, 'ok' | 'failed_checks'>;
  if (!edition) return { ...base, ok: false, failed_checks: ['edition_not_published'] };

  let status: number;
  let html: string;
  try {
    const res = await fetcher(url, { redirect: 'manual', headers: { accept: 'text/html' }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    status = res.status;
    html = await res.text();
  } catch {
    return { ...base, ok: false, failed_checks: ['page_unreachable'] };
  }
  const tags = headTags(html);
  const meta = (key: string, attr: 'property' | 'name' = 'property') => tags.find(t => t.name === 'meta' && t.attrs[attr] === key)?.attrs.content ?? null;
  const canonical = tags.find(t => t.name === 'link' && t.attrs.rel === 'canonical')?.attrs.href ?? null;
  const hreflang = tags.filter(t => t.name === 'link' && t.attrs.rel === 'alternate' && t.attrs.hreflang).map(t => t.attrs.hreflang).sort();
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const ogImage = meta('og:image');
  const [og_image, cover_image] = await Promise.all([
    ogImage ? probeImage(ogImage, origin, fetcher) : null,
    edition.cover_url ? probeImage(edition.cover_url, origin, fetcher) : null,
  ]);
  const result: Omit<LocaleVerification, 'ok' | 'failed_checks'> = {
    ...base, http_status: status, title: title ? decode(title.trim()) : null, html_lang: /<html\b[^>]*\blang=["']([^"']+)["']/i.exec(html)?.[1] ?? null,
    canonical, hreflang, paywall_marker: html.includes('zb-paywalled'), og_image, cover_image,
    twitter_image: meta('twitter:image', 'name'), json_ld_image: jsonLdImage(html), html_bytes: html.length,
  };
  const expectedHreflang = [...publishedHreflangs, 'x-default'].sort();
  const checks: Record<string, boolean> = {
    http_200: status === 200,
    title_matches: result.title !== null && result.title.includes(edition.title),
    html_lang_matches: result.html_lang === LOCALE_LABELS[locale].htmlLang,
    canonical_matches: canonical === url,
    hreflang_complete: JSON.stringify(hreflang) === JSON.stringify(expectedHreflang),
    og_image_present: ogImage !== null,
    og_image_reachable: og_image?.reachable === true,
    cover_reachable: cover_image === null || cover_image.reachable,
  };
  const failed_checks = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  return { ...result, ok: failed_checks.length === 0, failed_checks };
}

/**
 * Reads the article's public pages as an anonymous visitor and reports, per locale, what a reader and a crawler
 * get: status, title, canonical, hreflang, share image and cover reachability, and a hash of the stored published
 * document. Requests go only to the site's own origin (page, share image) and the first-party media host.
 */
export async function verifyPublic(
  d1: D1DatabaseLike | undefined, slug: string, opts: { origin: string; locales?: Locale[]; fetcher?: typeof fetch },
): Promise<VerifyPublicResult> {
  const rec = await getArticle(d1, slug);
  if (!d1 || !rec) throw new AppError(404, 'not_found', 'Article not found');
  const fetcher = opts.fetcher ?? fetch;
  const published = rec.editions.filter(e => e.published_revision !== null).map(e => e.locale);
  const targets = opts.locales ?? LOCALES.filter(l => published.includes(l));
  const hreflangs = published.map(l => LOCALE_LABELS[l].htmlLang);
  const locales = await Promise.all(targets.map(l => verifyLocale(d1, slug, l, opts.origin, hreflangs, fetcher)));
  return {
    slug, origin: opts.origin, ok: locales.length > 0 && locales.every(l => l.ok), checked_at: new Date().toISOString(), locales,
    email_notification: await getArticleNotification(d1, rec.id),
    not_tracked: ['translation_provenance', 'og_render_and_index_side_effects'],
  };
}
