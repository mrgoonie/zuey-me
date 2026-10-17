import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import { LOCALE_LABELS } from '../i18n/locales';
import type { Locale } from '../i18n/locales';
import { getArticleNotification } from '../notifications/article-notification-schedule';
import type { ArticleNotification } from '../notifications/article-notification-schedule';
import { getArticle, getPublishedDocuments } from './articles';
import { documentHash } from './read-modes';
import { articleAlternates, articleUrl } from './seo';

/** Hosts whose images the check may request besides the site itself (first-party media bucket only). */
export const VERIFY_IMAGE_HOSTS = ['media.zuey.me'] as const;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 2_000_000;

export interface ImageCheck { url: string; role: string; ok: boolean; status: number | null; content_type: string | null; skipped?: string }

export interface LocaleVerification {
  ok: boolean;
  url: string;
  http_status: number | null;
  access: string;
  title: { expected: string; actual: string | null };
  html_lang: { expected: string; actual: string | null };
  canonical: { expected: string; actual: string | null };
  hreflang: { expected: string[]; actual: string[] };
  cover_url: string | null;
  og_image: string | null;
  twitter_image: string | null;
  json_ld_image: string | null;
  images: ImageCheck[];
  /** Hash of the published document the public page was built from. */
  content_hash: string;
  /** Per-locale translation provenance is not recorded yet, so the check reports none instead of guessing. */
  translation_provenance: null;
  problems: string[];
}

export interface PublicVerification {
  slug: string;
  origin: string;
  checked_at: string;
  /** True when every checked locale passed every check. */
  ok: boolean;
  primary_locale: Locale;
  locales: Partial<Record<Locale, LocaleVerification>>;
  /** Editions that exist only as drafts; they are never fetched. */
  unpublished_locales: Locale[];
  pending_side_effects: { email_notification: ArticleNotification | null };
}

type Attrs = Record<string, string>;

function attributes(tag: string): Attrs {
  const attrs: Attrs = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? '');
  return attrs;
}

function decodeEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_m, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[name] ?? _m);
}

interface ParsedHead {
  title: string | null;
  htmlLang: string | null;
  canonical: string | null;
  hreflang: string[];
  ogImage: string | null;
  twitterImage: string | null;
  jsonLdImage: string | null;
}

/** Reads the SEO-relevant head of an article page; tolerant of attribute order, never executes anything. */
export function parseArticleHead(html: string): ParsedHead {
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map(m => attributes(m[0]));
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map(m => attributes(m[0]));
  const meta = (key: 'property' | 'name', value: string) => metas.find(a => a[key] === value)?.content ?? null;
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  let jsonLdImage: string | null = null;
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data: unknown = JSON.parse(m[1]);
      if (data && typeof data === 'object' && 'image' in data) {
        const image = data.image;
        const first = Array.isArray(image) ? image[0] : image;
        if (typeof first === 'string') { jsonLdImage = first; break; }
      }
    } catch { /* a malformed block is reported by the missing image */ }
  }
  return {
    title: title === undefined ? null : decodeEntities(title.trim()),
    htmlLang: attributes(/<html\b[^>]*>/i.exec(html)?.[0] ?? '').lang ?? null,
    canonical: links.find(a => a.rel === 'canonical')?.href ?? null,
    hreflang: links.filter(a => a.rel === 'alternate' && a.hreflang).map(a => `${a.hreflang}=${a.href}`).sort(),
    ogImage: meta('property', 'og:image'),
    twitterImage: meta('name', 'twitter:image'),
    jsonLdImage,
  };
}

async function readHtml(res: Response): Promise<string> {
  const text = await res.text();
  return text.length > MAX_HTML_BYTES ? text.slice(0, MAX_HTML_BYTES) : text;
}

async function checkImage(url: string, role: string, origin: string, fetcher: typeof fetch): Promise<ImageCheck> {
  let target: URL;
  try { target = new URL(url, origin); } catch { return { url, role, ok: false, status: null, content_type: null, skipped: 'invalid_url' }; }
  const allowed = target.origin === new URL(origin).origin || (target.protocol === 'https:' && (VERIFY_IMAGE_HOSTS as readonly string[]).includes(target.hostname));
  if (!allowed) return { url, role, ok: false, status: null, content_type: null, skipped: 'host_not_allowed' };
  try {
    // Redirects stay unfollowed so a response can never steer the check to a host off the allowlist.
    let res = await fetcher(target.toString(), { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 405 || res.status === 501) {
      res = await fetcher(target.toString(), { method: 'GET', headers: { range: 'bytes=0-0' }, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    }
    const type = res.headers.get('content-type');
    return { url, role, ok: res.status >= 200 && res.status < 300 && (type ?? '').toLowerCase().startsWith('image/'), status: res.status, content_type: type };
  } catch {
    return { url, role, ok: false, status: null, content_type: null, skipped: 'unreachable' };
  }
}

export interface VerifyOptions {
  origin: string;
  /** Locales to check (default: every published edition). */
  locales?: Locale[];
  fetcher?: typeof fetch;
  checkImages?: boolean;
}

/**
 * Reads the live public pages of an article the way an anonymous visitor does (no cookies, no
 * credentials) and compares them with what the stored editions say they should be. It proves the page
 * answers with the right language, canonical, hreflang set and images; widget rendering still needs a
 * browser check (scripts/article-widget-smoke.mjs).
 */
export async function verifyPublicArticle(d1: D1DatabaseLike | undefined, slug: string, opts: VerifyOptions): Promise<PublicVerification> {
  const fetcher = opts.fetcher ?? fetch;
  const origin = opts.origin.replace(/\/$/, '');
  const base = await getArticle(d1, slug);
  const docs = await getPublishedDocuments(d1, slug);
  if (!d1 || !base || !docs) throw new AppError(404, 'not_found', 'Article not found');

  const published = base.editions.filter(e => e.status === 'published' || e.published_revision !== null).map(e => e.locale);
  const unpublished = base.editions.map(e => e.locale).filter(l => !published.includes(l));
  const wanted = opts.locales ?? published;
  const notPublished = wanted.filter(l => !published.includes(l));
  if (notPublished.length) throw new AppError(400, 'invalid_field', `No published edition for: ${notPublished.join(', ')}`, { field: 'locales' });

  const expectedAlternates = articleAlternates(origin, slug, published).map(a => `${a.hreflang}=${a.href}`).sort();
  const locales: Partial<Record<Locale, LocaleVerification>> = {};
  for (const locale of wanted) {
    const rec = await getArticle(d1, slug, { locale, publishedOnly: true });
    const edition = base.editions.find(e => e.locale === locale);
    const doc = docs.docs.find(d => d.locale === locale)?.doc;
    if (!rec || !edition || !doc) continue;
    const url = articleUrl(origin, slug, locale);
    const problems: string[] = [];
    const out: LocaleVerification = {
      ok: false, url, http_status: null, access: rec.access,
      title: { expected: edition.title, actual: null },
      html_lang: { expected: LOCALE_LABELS[locale].htmlLang, actual: null },
      canonical: { expected: url, actual: null },
      hreflang: { expected: expectedAlternates, actual: [] },
      cover_url: rec.cover_url, og_image: null, twitter_image: null, json_ld_image: null,
      images: [], content_hash: await documentHash(doc), translation_provenance: null, problems,
    };
    try {
      const res = await fetcher(url, { headers: { accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      out.http_status = res.status;
      if (res.status !== 200) {
        problems.push(`page answered HTTP ${res.status}`);
      } else {
        const head = parseArticleHead(await readHtml(res));
        out.title.actual = head.title;
        out.html_lang.actual = head.htmlLang;
        out.canonical.actual = head.canonical;
        out.hreflang.actual = head.hreflang;
        out.og_image = head.ogImage;
        out.twitter_image = head.twitterImage;
        out.json_ld_image = head.jsonLdImage;
        if (!head.title?.includes(edition.title)) problems.push('page title does not contain the published title');
        if (head.htmlLang !== out.html_lang.expected) problems.push(`html lang is ${head.htmlLang ?? 'missing'}, expected ${out.html_lang.expected}`);
        if (head.canonical !== url) problems.push(`canonical is ${head.canonical ?? 'missing'}, expected ${url}`);
        if (head.hreflang.join('|') !== expectedAlternates.join('|')) problems.push('hreflang alternates differ from the published editions');
        if (!head.ogImage) problems.push('og:image is missing');
        if (!head.twitterImage) problems.push('twitter:image is missing');
        if (rec.cover_url && head.jsonLdImage !== rec.cover_url) problems.push('JSON-LD image is not the edition cover');
        if (opts.checkImages !== false) {
          const candidates: Array<[string, string | null]> = [['cover', rec.cover_url], ['og:image', head.ogImage], ['twitter:image', head.twitterImage]];
          const seen = new Set<string>();
          for (const [role, imageUrl] of candidates) {
            if (!imageUrl || seen.has(imageUrl)) continue;
            seen.add(imageUrl);
            const check = await checkImage(imageUrl, role, origin, fetcher);
            out.images.push(check);
            if (!check.ok) problems.push(`${role} image is not reachable (${check.skipped ?? `HTTP ${check.status}`})`);
          }
        }
      }
    } catch {
      problems.push('page could not be fetched');
    }
    out.ok = problems.length === 0;
    locales[locale] = out;
  }

  return {
    slug, origin, checked_at: new Date().toISOString(),
    ok: Object.values(locales).every(l => l?.ok === true) && Object.keys(locales).length === wanted.length,
    primary_locale: base.primary_locale, locales, unpublished_locales: unpublished,
    pending_side_effects: { email_notification: await getArticleNotification(d1, base.id) },
  };
}
