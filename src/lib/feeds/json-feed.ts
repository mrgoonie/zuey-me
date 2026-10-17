import type { D1DatabaseLike } from '../../db/store';
import { AppError } from '../http';
import { DEFAULT_LOCALE, LOCALES, LOCALE_LABELS, isLocale } from '../i18n/locales';
import type { Locale } from '../i18n/locales';
import { localeParam } from '../blocks/params';
import { articleUrl } from '../blocks/seo';
import type { ArticleAccess } from '../blocks/schema';
import { readingMinutes } from '../search/text';
import { listCategories, toPublicCategory } from '../taxonomy/categories';
import { toPublicTag, tagsForArticles } from '../taxonomy/tags';

/**
 * Public JSON Feed 1.1 (https://www.jsonfeed.org/version/1.1/) of published article editions.
 * Summary feed only: it never carries the article body, and every field is read from the last published
 * snapshot (never from draft-mutable edition columns), so it is identical for every anonymous reader.
 */
export const JSON_FEED_VERSION = 'https://jsonfeed.org/version/1.1';
export const FEED_DEFAULT_LIMIT = 20;
export const FEED_MAX_LIMIT = 100;
export const FEED_CONTENT_TYPE = 'application/feed+json; charset=utf-8';

type Row = Record<string, unknown>;

export interface FeedCursor { publishedAt: string; articleId: string }

export interface FeedQuery {
  locale: Locale;
  category?: string;
  tag?: string;
  access?: ArticleAccess;
  limit: number;
  cursor?: FeedCursor;
}

export interface FeedItem {
  id: string;
  url: string;
  title: string;
  summary: string;
  content_text: string;
  image: string;
  date_published: string;
  date_modified: string;
  language: string;
  tags?: string[];
  _zuey: {
    access: ArticleAccess;
    category: { slug: string; name: string } | null;
    reading_minutes: number;
    available_locales: Locale[];
    content_mode: 'summary';
    markdown_url: string;
  };
}

export interface JsonFeed {
  version: typeof JSON_FEED_VERSION;
  title: string;
  home_page_url: string;
  feed_url: string;
  description: string;
  language: string;
  authors: Array<{ name: string; url: string }>;
  next_url?: string;
  items: FeedItem[];
}

const bad = (field: string, message: string) => new AppError(400, 'invalid_field', message, { field });

function filterParam(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name)?.trim();
  if (!raw) return undefined;
  if (raw.length > 80) throw bad(name, `${name} is too long`);
  return raw;
}

/** `{publishedAt, articleId}` keyset position, carried as an opaque base64url `cursor`. */
export function encodeCursor(c: FeedCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify([c.publishedAt, c.articleId]));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(raw: string): FeedCursor {
  const invalid = () => new AppError(400, 'invalid_cursor', 'cursor is not a value returned by this feed', { field: 'cursor' });
  try {
    const bin = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0))));
    if (!Array.isArray(parsed) || parsed.length !== 2) throw invalid();
    const [publishedAt, articleId] = parsed;
    if (typeof publishedAt !== 'string' || typeof articleId !== 'string') throw invalid();
    if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(publishedAt) || !/^[A-Za-z0-9_-]{1,64}$/.test(articleId)) throw invalid();
    return { publishedAt, articleId };
  } catch (err) {
    throw err instanceof AppError ? err : invalid();
  }
}

/** Strict parsing: unknown locale, access, limit or cursor is a 400, never a silent fallback. */
export function parseFeedQuery(url: URL): FeedQuery {
  const accessRaw = url.searchParams.get('access');
  if (accessRaw && accessRaw !== 'free' && accessRaw !== 'knowledges') throw bad('access', "access must be 'free' or 'knowledges'");
  const limitRaw = url.searchParams.get('limit');
  let limit = FEED_DEFAULT_LIMIT;
  if (limitRaw) {
    const v = Number(limitRaw);
    if (!/^\d+$/.test(limitRaw) || v < 1 || v > FEED_MAX_LIMIT) throw bad('limit', `limit must be an integer 1–${FEED_MAX_LIMIT}`);
    limit = v;
  }
  const cursorRaw = url.searchParams.get('cursor');
  return {
    locale: localeParam(url) ?? DEFAULT_LOCALE,
    category: filterParam(url, 'category'),
    tag: filterParam(url, 'tag'),
    access: accessRaw === 'free' || accessRaw === 'knowledges' ? accessRaw : undefined,
    limit,
    cursor: cursorRaw ? decodeCursor(cursorRaw) : undefined,
  };
}

/** Canonical query string of a feed URL: only non-default values, in a fixed order. */
export function feedQueryString(q: FeedQuery, cursor?: FeedCursor): string {
  const p = new URLSearchParams();
  if (q.locale !== DEFAULT_LOCALE) p.set('lang', q.locale);
  if (q.category) p.set('category', q.category);
  if (q.tag) p.set('tag', q.tag);
  if (q.access) p.set('access', q.access);
  if (q.limit !== FEED_DEFAULT_LIMIT) p.set('limit', String(q.limit));
  if (cursor) p.set('cursor', encodeCursor(cursor));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Image of the public part of an edition: absolute https URL (or a path on this site), else the site OG card. */
export function feedImage(cover: unknown, origin: string): string {
  if (typeof cover === 'string' && cover) {
    try {
      const u = new URL(cover, origin);
      if (u.protocol === 'https:' && !u.username && !u.password) return u.href;
    } catch { /* falls through to the site card */ }
  }
  return `${origin}/og.png`;
}

const str = (r: Row, k: string): string => (typeof r[k] === 'string' ? r[k] : '');

/** One page of published editions, newest first, by keyset (publish time, article id). */
export async function loadFeedPage(
  d1: D1DatabaseLike | undefined, q: FeedQuery, origin: string, nowIso = new Date().toISOString(),
): Promise<{ items: FeedItem[]; next: FeedCursor | null }> {
  if (!d1) throw new AppError(503, 'db_unavailable', 'Database binding is not configured');
  const where = [
    'e.deleted_at IS NULL', 'e.published_json IS NOT NULL', 'a.deleted_at IS NULL', 'e.locale = ?',
    'e.published_at IS NOT NULL', 'e.published_at <= ?',
  ];
  const args: unknown[] = [q.locale, nowIso];
  if (q.access) { where.push('a.access = ?'); args.push(q.access); }
  if (q.category) {
    where.push('a.category_id IN (SELECT id FROM knowledge_categories WHERE deleted_at IS NULL AND (id = ? OR slug = ?))');
    args.push(q.category, q.category);
  }
  if (q.tag) {
    where.push(`EXISTS (SELECT 1 FROM article_tags at JOIN topic_tags t ON t.id = at.tag_id
      WHERE at.article_id = a.id AND t.deleted_at IS NULL AND (t.id = ? OR t.slug = ?))`);
    args.push(q.tag, q.tag);
  }
  if (q.cursor) {
    where.push('(e.published_at < ? OR (e.published_at = ? AND e.article_id < ?))');
    args.push(q.cursor.publishedAt, q.cursor.publishedAt, q.cursor.articleId);
  }
  const { results } = await d1.prepare(`
    SELECT e.article_id, e.locale, e.title, e.excerpt, e.published_title, e.published_excerpt, e.published_at,
      e.published_modified_at, e.published_words, e.cover_url, a.slug, a.access, a.category_id
    FROM article_editions e JOIN articles a ON a.id = e.article_id
    WHERE ${where.join(' AND ')}
    ORDER BY e.published_at DESC, e.article_id DESC LIMIT ?
  `).bind(...args, q.limit + 1).all<Row>();
  const rows = results ?? [];
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  const next = rows.length > q.limit && last ? { publishedAt: str(last, 'published_at'), articleId: str(last, 'article_id') } : null;
  if (page.length === 0) return { items: [], next: null };

  const ids = page.map(r => str(r, 'article_id'));
  const marks = ids.map(() => '?').join(', ');
  const [tags, categories, locales] = await Promise.all([
    tagsForArticles(d1, ids),
    listCategories(d1),
    d1.prepare(`SELECT article_id, locale FROM article_editions WHERE deleted_at IS NULL AND published_json IS NOT NULL AND article_id IN (${marks})`)
      .bind(...ids).all<Row>(),
  ]);
  const categoryById = new Map(categories.map(c => [c.id, c]));
  const localesBy = new Map<string, Locale[]>();
  for (const r of locales.results ?? []) {
    if (!isLocale(r.locale)) continue;
    const list = localesBy.get(str(r, 'article_id')) ?? [];
    list.push(r.locale);
    localesBy.set(str(r, 'article_id'), list);
  }

  const items = page.map((r): FeedItem => {
    const articleId = str(r, 'article_id');
    const slug = str(r, 'slug');
    // Published snapshot only: the draft-mutable `title` / `excerpt` columns are a fallback for rows
    // that predate the snapshot columns and were never republished.
    const title = str(r, 'published_title') || str(r, 'title');
    const excerpt = (str(r, 'published_excerpt') || str(r, 'excerpt')).trim();
    const published = str(r, 'published_at');
    const modified = str(r, 'published_modified_at');
    const cat = categoryById.get(str(r, 'category_id'));
    const publicCat = cat ? toPublicCategory(cat, q.locale) : null;
    const tagNames = (tags.get(articleId) ?? []).map(t => toPublicTag(t, q.locale).name);
    const available = [...new Set(localesBy.get(articleId) ?? [q.locale])].sort((a, b) => LOCALES.indexOf(a) - LOCALES.indexOf(b));
    const summary = excerpt || title;
    return {
      id: `urn:zuey:article:${articleId}:${q.locale}`,
      url: articleUrl(origin, slug, q.locale),
      title,
      summary,
      content_text: summary,
      image: feedImage(r.cover_url, origin),
      date_published: published,
      date_modified: modified && modified > published ? modified : published,
      language: LOCALE_LABELS[q.locale].htmlLang,
      ...(tagNames.length ? { tags: tagNames } : {}),
      _zuey: {
        access: r.access === 'knowledges' ? 'knowledges' : 'free',
        category: publicCat ? { slug: publicCat.slug, name: publicCat.name } : null,
        reading_minutes: readingMinutes(typeof r.published_words === 'number' ? r.published_words : 0),
        available_locales: available,
        content_mode: 'summary',
        markdown_url: articleUrl(origin, slug, q.locale, true),
      },
    };
  });
  return { items, next };
}

export function buildJsonFeed(q: FeedQuery, origin: string, items: FeedItem[], next: FeedCursor | null): JsonFeed {
  const feedUrl = (cursor?: FeedCursor) => `${origin}/feed.json${feedQueryString(q, cursor)}`;
  return {
    version: JSON_FEED_VERSION,
    title: 'Zuey — Duy Nguyen',
    home_page_url: `${origin}/`,
    feed_url: feedUrl(q.cursor),
    description: 'Latest articles by Duy Nguyen. Summaries link to the full article on zuey.me; paid content is never included.',
    language: LOCALE_LABELS[q.locale].htmlLang,
    authors: [{ name: 'Duy Nguyen', url: `${origin}/` }],
    ...(next ? { next_url: feedUrl(next) } : {}),
    items,
  };
}
