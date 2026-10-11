import type { D1DatabaseLike, D1PreparedStatementLike } from '../../db/store';
import { AppError, jsonError } from '../http';
import { authenticateAdmin } from '../auth';
import type { ArticleAccess, ArticleDocument, ArticleStatus, Block } from './schema';
import { emptyDocument, walkBlocks } from './schema';
import { readStoredDocument, validateDocument } from './validate';
import { applyPaywall } from './paywall';
import type { LockedOutline, Viewer } from './paywall';
import type { RuntimeEnv } from '../../env';
import type { Principal } from '../members/policy';
import { resolvePrincipal, viewerFromPrincipal } from '../members/policy';
import { DEFAULT_LOCALE, LOCALES, isLocale } from '../i18n/locales';
import type { Locale } from '../i18n/locales';
import { reindexArticle } from '../search/indexer';
import { documentText, readingMinutes, wordCount } from '../search/text';
import { mirrorLegacyTags, resolveTagRefs, setArticleTags, tagsForArticles, toPublicTag } from '../taxonomy/tags';
import type { PublicTag } from '../taxonomy/tags';
import { listCategories, resolveCategoryRef, toPublicCategory } from '../taxonomy/categories';
import type { PublicCategory } from '../taxonomy/categories';
import { labelKey, listLabels, publicLabelsFor } from '../taxonomy/labels';
import type { PublicLabel } from '../taxonomy/labels';
import { applyPublishNotification, cancelArticleNotification, getArticleNotification, parseNotifyFlag } from '../notifications/article-notification-schedule';
import type { ArticleNotification } from '../notifications/article-notification-schedule';

export interface EditionSummary {
  locale: Locale;
  title: string;
  excerpt: string;
  status: ArticleStatus;
  /** Article revision at which this edition last changed. */
  revision: number;
  published_revision: number | null;
  published_at: string | null;
  updated_at: string;
  has_unpublished_changes: boolean;
  reading_minutes: number;
}

export interface ArticleSummary {
  id: string;
  slug: string;
  /** Locale of the edition shown in this response. */
  locale: Locale;
  primary_locale: Locale;
  title: string;
  excerpt: string;
  /** Display names of the public topic tags (kept for older clients). */
  tags: string[];
  topic_tags: PublicTag[];
  category: PublicCategory | null;
  /** Approved evidence/topic labels for this edition (names only; evidence is admin-only). */
  labels: PublicLabel[];
  access: ArticleAccess;
  status: ArticleStatus;
  /** Article-wide revision used for optimistic concurrency (expected_revision). */
  revision: number;
  label_revision: number;
  published_revision: number | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  has_unpublished_changes: boolean;
  /** Locales with a published edition (translations are never generated automatically). */
  available_locales: Locale[];
  reading_minutes: number;
  /** First image of the public part, if any (thumbnails and social cards). */
  cover_url: string | null;
  /** Admin listings only: every edition including drafts. */
  editions?: EditionSummary[];
  /** Admin draft views and publish responses only: the new-article email to members. */
  email_notification?: ArticleNotification | null;
}

export interface ArticleRecord extends ArticleSummary {
  category_id: string | null;
  tag_ids: string[];
  draft: ArticleDocument;
  /** How the stored draft was recovered to produce `draft`; null when it was read as stored. */
  draft_recovery: DocumentRecovery | null;
  published: ArticleDocument | null;
  editions: EditionSummary[];
}

/** What a reader (or admin preview) receives: one edition, already paywalled. */
export interface ArticleView extends ArticleSummary {
  document: ArticleDocument;
  truncated: boolean;
  /** Only when truncated: withheld top-level headings (text + level) and withheld size; no other paid text. */
  locked_outline?: LockedOutline;
  preview: boolean;
  /** True when the requested locale had no edition and another edition is shown instead. */
  locale_fallback: boolean;
  /**
   * Admin draft views only: how the stored draft had to be recovered to be shown, or null when it
   * passed today's validation. Saving the shown document over a recovered draft makes the loss permanent.
   */
  recovery?: DocumentRecovery | null;
}

/** Counts of a lenient stored-document read; `unreadable` means the document is shown as empty. */
export interface DocumentRecovery {
  /** Invalid blocks skipped on read. */
  dropped_blocks: number;
  /** Embeds whose stored provider no longer matched their URL and now show as plain links. */
  degraded_embeds: number;
  /** The stored JSON (or every one of its blocks) could not be read. */
  unreadable: boolean;
}

export interface ArticleInput {
  slug?: string;
  title?: string;
  excerpt?: string;
  /** Edition to create/update (defaults to the primary locale). */
  locale?: Locale;
  primary_locale?: Locale;
  access?: ArticleAccess;
  /** Topic tag references: ids, slugs, aliases or names (unknown names create tags). */
  tags?: string[];
  /** Category id or slug; null clears it. */
  category?: string | null;
  document?: ArticleDocument;
}

export interface WriteContext {
  actor?: string;
  env?: RuntimeEnv;
  /**
   * Runtime hook that keeps background work alive after the response (Cloudflare `ctx.waitUntil`).
   * When present, writes re-render the article's social share images; without it (tests, scripts)
   * images are rendered lazily on their first request instead.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** `waitUntil` of the current Cloudflare request, if any (absent in `astro dev` and tests). */
export function runtimeWaitUntil(runtime?: { ctx?: { waitUntil(promise: Promise<unknown>): void } }): WriteContext['waitUntil'] {
  const ctx = runtime?.ctx;
  return ctx ? promise => ctx.waitUntil(promise) : undefined;
}

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type Row = Record<string, unknown>;

function s(row: Row, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v : '';
}

function n(row: Row, key: string, fallback = 0): number {
  const v = row[key];
  if (typeof v === 'number') return v;
  const parsed = Number(v);
  return Number.isFinite(parsed) && v !== null && v !== undefined ? parsed : fallback;
}

function nullableNum(row: Row, key: string): number | null {
  return row[key] === null || row[key] === undefined ? null : n(row, key);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Reads a stored edition/revision document block by block. Returns null when the stored JSON is
 * unreadable or every one of its blocks had to be dropped: callers that write must not persist that.
 * Warnings carry counts only, never document content.
 */
function readStoredDocWithRecovery(text: string, slug: string): { doc: ArticleDocument | null; recovery: DocumentRecovery | null } {
  const res = readStoredDocument(parseJson(text));
  if (!res) {
    console.warn(`Stored document for article "${slug}" is unreadable`);
    return { doc: null, recovery: { dropped_blocks: 0, degraded_embeds: 0, unreadable: true } };
  }
  if (!res.dropped && !res.degraded) return { doc: res.doc, recovery: null };
  console.warn(`Stored document for article "${slug}" recovered: ${res.dropped} invalid block(s) dropped, ${res.degraded} embed(s) shown as links`);
  const unreadable = res.dropped > 0 && res.doc.blocks.length === 0;
  return { doc: unreadable ? null : res.doc, recovery: { dropped_blocks: res.dropped, degraded_embeds: res.degraded, unreadable } };
}

function readStoredDoc(text: string, slug: string): ArticleDocument | null {
  return readStoredDocWithRecovery(text, slug).doc;
}

/** Display read: an unreadable stored document shows as empty (never written back; see `requireStoredDraft`). */
function parseStoredDoc(text: string, slug: string): ArticleDocument {
  return readStoredDoc(text, slug) ?? emptyDocument();
}

/** Write paths: refuse to carry on from a draft that could not be read instead of saving it as empty. */
function requireStoredDraft(text: string, slug: string, locale: Locale): ArticleDocument {
  const doc = readStoredDoc(text, slug);
  if (doc) return doc;
  throw new AppError(409, 'stored_document_unreadable',
    `The stored ${locale} draft could not be read; send a complete document to replace it`, { locale });
}

function asLocale(v: unknown): Locale {
  return isLocale(v) ? v : DEFAULT_LOCALE;
}

function requireDb(d1: D1DatabaseLike | undefined): D1DatabaseLike {
  if (!d1) throw new AppError(503, 'db_unavailable', 'Database binding is not configured');
  return d1;
}

const nowIso = () => new Date().toISOString();
const newId = (prefix: string) => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 16);

// ---------- Loading ----------

interface EditionRow {
  articleId: string;
  locale: Locale;
  title: string;
  excerpt: string;
  draftJson: string;
  publishedJson: string | null;
  revision: number;
  publishedRevision: number | null;
  status: ArticleStatus;
  publishedWords: number;
  coverUrl: string | null;
  publishedAt: string | null;
  updatedAt: string;
}

function toEditionRow(r: Row): EditionRow {
  return {
    articleId: s(r, 'article_id'),
    locale: asLocale(r.locale),
    title: s(r, 'title'),
    excerpt: s(r, 'excerpt'),
    draftJson: s(r, 'draft_json'),
    publishedJson: typeof r.published_json === 'string' ? r.published_json : null,
    revision: n(r, 'revision', 1),
    publishedRevision: nullableNum(r, 'published_revision'),
    status: r.published_json ? 'published' : 'draft',
    publishedWords: n(r, 'published_words'),
    coverUrl: typeof r.cover_url === 'string' ? r.cover_url : null,
    publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
    updatedAt: s(r, 'updated_at'),
  };
}

function editionSummary(e: EditionRow): EditionSummary {
  return {
    locale: e.locale, title: e.title, excerpt: e.excerpt, status: e.status, revision: e.revision,
    published_revision: e.publishedRevision, published_at: e.publishedAt, updated_at: e.updatedAt,
    has_unpublished_changes: e.publishedJson !== e.draftJson, reading_minutes: readingMinutes(e.publishedWords),
  };
}

const localeOrder = (a: EditionRow, b: EditionRow) => LOCALES.indexOf(a.locale) - LOCALES.indexOf(b.locale);

/** Requested locale when available, else the primary edition, else the first edition in locale order. */
function pickEdition(editions: EditionRow[], requested: Locale | undefined, primary: Locale): { edition: EditionRow; fallback: boolean } | null {
  if (editions.length === 0) return null;
  const exact = requested ? editions.find(e => e.locale === requested) : undefined;
  if (exact) return { edition: exact, fallback: false };
  const chosen = editions.find(e => e.locale === primary) ?? [...editions].sort(localeOrder)[0];
  return { edition: chosen, fallback: requested !== undefined };
}

async function loadEditions(db: D1DatabaseLike, articleIds: string[] | null): Promise<Map<string, EditionRow[]>> {
  const { results } = articleIds && articleIds.length === 1
    ? await db.prepare('SELECT * FROM article_editions WHERE article_id = ? AND deleted_at IS NULL').bind(articleIds[0]).all<Row>()
    : await db.prepare('SELECT * FROM article_editions WHERE deleted_at IS NULL').all<Row>();
  const wanted = articleIds ? new Set(articleIds) : null;
  const out = new Map<string, EditionRow[]>();
  for (const r of results ?? []) {
    const e = toEditionRow(r);
    if (wanted && !wanted.has(e.articleId)) continue;
    const list = out.get(e.articleId) ?? [];
    list.push(e);
    out.set(e.articleId, list);
  }
  return out;
}

interface ArticleRowData {
  id: string;
  slug: string;
  primary: Locale;
  access: ArticleAccess;
  categoryId: string | null;
  revision: number;
  labelRevision: number;
  createdAt: string;
  updatedAt: string;
}

function toArticleRow(r: Row): ArticleRowData {
  return {
    id: s(r, 'id'), slug: s(r, 'slug'), primary: asLocale(r.locale), access: r.access === 'knowledges' ? 'knowledges' : 'free',
    categoryId: typeof r.category_id === 'string' ? r.category_id : null, revision: n(r, 'revision', 1),
    labelRevision: n(r, 'label_revision'), createdAt: s(r, 'created_at'), updatedAt: s(r, 'updated_at'),
  };
}

interface Decorations {
  tags: Map<string, Array<{ id: string; slug: string; names: Partial<Record<Locale, string>> }>>;
  categories: Map<string, { id: string; slug: string; names: Partial<Record<Locale, string>> }>;
  labels: Map<string, Map<string, PublicLabel[]>>;
}

async function loadDecorations(db: D1DatabaseLike, picks: Array<{ articleId: string; locale: Locale }>): Promise<Decorations> {
  const ids = picks.map(p => p.articleId);
  const tags = await tagsForArticles(db, ids);
  const categories = new Map((await listCategories(db)).map(c => [c.id, c]));
  const labels = new Map<string, Map<string, PublicLabel[]>>();
  for (const locale of LOCALES) {
    const forLocale = picks.filter(p => p.locale === locale).map(p => p.articleId);
    if (forLocale.length) labels.set(locale, await publicLabelsFor(db, forLocale, locale));
  }
  return { tags, categories, labels };
}

function buildSummary(
  art: ArticleRowData, edition: EditionRow, editions: EditionRow[], deco: Decorations, opts: { includeEditions?: boolean },
): ArticleSummary {
  const tagList = deco.tags.get(art.id) ?? [];
  const cat = art.categoryId ? deco.categories.get(art.categoryId) : undefined;
  const topicTags = tagList.map(t => toPublicTag(t, edition.locale));
  const published = editions.filter(e => e.publishedJson !== null).sort(localeOrder);
  return {
    id: art.id,
    slug: art.slug,
    locale: edition.locale,
    primary_locale: art.primary,
    title: edition.title,
    excerpt: edition.excerpt,
    tags: topicTags.map(t => t.name),
    topic_tags: topicTags,
    category: cat ? toPublicCategory(cat, edition.locale) : null,
    labels: deco.labels.get(edition.locale)?.get(art.id) ?? [],
    access: art.access,
    status: edition.status,
    revision: art.revision,
    label_revision: art.labelRevision,
    published_revision: edition.publishedRevision,
    created_at: art.createdAt,
    updated_at: art.updatedAt,
    published_at: edition.publishedAt,
    has_unpublished_changes: edition.publishedJson !== edition.draftJson,
    available_locales: published.map(e => e.locale),
    reading_minutes: readingMinutes(edition.publishedWords),
    cover_url: edition.coverUrl,
    ...(opts.includeEditions ? { editions: [...editions].sort(localeOrder).map(editionSummary) } : {}),
  };
}

export function toSummary(rec: ArticleRecord): ArticleSummary {
  const { draft: _draft, draft_recovery: _r, published: _published, category_id: _c, tag_ids: _t, ...summary } = rec;
  return summary;
}

export const SORTS = ['new', 'old', 'title', 'relevance'] as const;
export type ArticleSort = (typeof SORTS)[number];

export interface ListOptions {
  includeDrafts?: boolean;
  /** Preferred edition locale; articles without it show their primary edition. */
  locale?: Locale;
  /** Category slug or id. */
  category?: string;
  /** Topic tag slug or id. */
  tag?: string;
  /** Label key `<kind>:<slug>` or label id. */
  label?: string;
  access?: ArticleAccess;
  sort?: ArticleSort;
  /** Restrict to these article ids (e.g. search hits); `relevance` sort keeps this order. */
  ids?: string[];
  limit?: number;
}

export async function listArticles(d1: D1DatabaseLike | undefined, opts: ListOptions = {}): Promise<ArticleSummary[]> {
  if (!d1) return [];
  const { results } = await d1.prepare('SELECT * FROM articles WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 500').all<Row>();
  const articles = (results ?? []).map(toArticleRow);
  const editionsBy = await loadEditions(d1, null);
  const idFilter = opts.ids ? new Set(opts.ids) : null;

  const picked: Array<{ art: ArticleRowData; edition: EditionRow; editions: EditionRow[] }> = [];
  for (const art of articles) {
    if (idFilter && !idFilter.has(art.id)) continue;
    if (opts.access && art.access !== opts.access) continue;
    const all = editionsBy.get(art.id) ?? [];
    const visible = opts.includeDrafts ? all : all.filter(e => e.publishedJson !== null);
    const pick = pickEdition(visible, opts.locale, art.primary);
    if (pick) picked.push({ art, edition: pick.edition, editions: all });
  }
  const deco = await loadDecorations(d1, picked.map(p => ({ articleId: p.art.id, locale: p.edition.locale })));

  let filtered = picked;
  if (opts.category) {
    const cat = [...deco.categories.values()].find(c => c.slug === opts.category || c.id === opts.category);
    filtered = cat ? filtered.filter(p => p.art.categoryId === cat.id) : [];
  }
  if (opts.tag) {
    filtered = filtered.filter(p => (deco.tags.get(p.art.id) ?? []).some(t => t.slug === opts.tag || t.id === opts.tag));
  }
  if (opts.label) {
    const labels = await listLabels(d1);
    const label = labels.find(l => l.id === opts.label || labelKey(l) === opts.label);
    filtered = label ? filtered.filter(p => (deco.labels.get(p.edition.locale)?.get(p.art.id) ?? []).some(l => l.id === label.id)) : [];
  }

  const summaries = filtered.map(p => buildSummary(p.art, p.edition, p.editions, deco, { includeEditions: opts.includeDrafts }));
  const date = (a: ArticleSummary) => a.published_at ?? a.updated_at;
  const sort = opts.sort ?? (opts.ids ? 'relevance' : 'new');
  if (sort === 'relevance' && opts.ids) {
    const order = new Map(opts.ids.map((id, i) => [id, i]));
    summaries.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  } else if (sort === 'old') summaries.sort((a, b) => date(a).localeCompare(date(b)));
  else if (sort === 'title') summaries.sort((a, b) => a.title.localeCompare(b.title, a.locale));
  else summaries.sort((a, b) => date(b).localeCompare(date(a)));
  return opts.limit ? summaries.slice(0, opts.limit) : summaries;
}

async function loadArticleRow(db: D1DatabaseLike, slug: string): Promise<ArticleRowData | null> {
  const row = await db.prepare('SELECT * FROM articles WHERE slug = ? AND deleted_at IS NULL').bind(slug).first<Row>();
  return row ? toArticleRow(row) : null;
}

/** Article id for a live slug; 404 AppError otherwise. */
export async function requireArticleId(d1: D1DatabaseLike | undefined, slug: string): Promise<string> {
  const art = await loadArticleRow(requireDb(d1), slug);
  if (!art) throw new AppError(404, 'not_found', 'Article not found');
  return art.id;
}

/** Full record of one article: the requested (or primary) edition plus all edition summaries. */
export async function getArticle(
  d1: D1DatabaseLike | undefined, slug: string, opts: { locale?: Locale; publishedOnly?: boolean } = {},
): Promise<(ArticleRecord & { locale_fallback: boolean }) | null> {
  if (!d1) return null;
  const art = await loadArticleRow(d1, slug);
  if (!art) return null;
  const editions = (await loadEditions(d1, [art.id])).get(art.id) ?? [];
  const candidates = opts.publishedOnly ? editions.filter(e => e.publishedJson !== null) : editions;
  const pick = pickEdition(candidates, opts.locale, art.primary);
  if (!pick) return null;
  const deco = await loadDecorations(d1, [{ articleId: art.id, locale: pick.edition.locale }]);
  const summary = buildSummary(art, pick.edition, editions, deco, { includeEditions: true });
  const draft = readStoredDocWithRecovery(pick.edition.draftJson, slug);
  return {
    ...summary,
    editions: summary.editions ?? [],
    category_id: art.categoryId,
    tag_ids: (deco.tags.get(art.id) ?? []).map(t => t.id),
    draft: draft.doc ?? emptyDocument(),
    draft_recovery: draft.recovery,
    published: pick.edition.publishedJson ? parseStoredDoc(pick.edition.publishedJson, slug) : null,
    locale_fallback: pick.fallback,
  };
}

/** Every published edition document of an article (surveys may live in any edition). */
export async function getPublishedDocuments(d1: D1DatabaseLike | undefined, slug: string): Promise<{ article: ArticleRowData; docs: Array<{ locale: Locale; doc: ArticleDocument; draft: ArticleDocument }> } | null> {
  if (!d1) return null;
  const art = await loadArticleRow(d1, slug);
  if (!art) return null;
  const editions = (await loadEditions(d1, [art.id])).get(art.id) ?? [];
  return {
    article: art,
    docs: editions.sort(localeOrder).map(e => ({
      locale: e.locale,
      doc: e.publishedJson ? parseStoredDoc(e.publishedJson, slug) : emptyDocument(),
      draft: parseStoredDoc(e.draftJson, slug),
    })),
  };
}

// ---------- Input validation & auth ----------

/** Validates create/update payloads shared by REST and MCP. Throws AppError 400/422. */
export function parseArticleInput(body: Record<string, unknown>, mode: 'create' | 'update'): ArticleInput {
  const out: ArticleInput = {};
  const bad = (field: string, msg: string): never => { throw new AppError(400, 'invalid_field', `${field} ${msg}`, { field }); };
  const optStr = (key: string, max: number): string | undefined => {
    const v = body[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length > max) bad(key, `must be a string of at most ${max} characters`);
    return typeof v === 'string' ? v.trim() : undefined;
  };
  out.slug = optStr('slug', 120);
  if (out.slug !== undefined && !SLUG_RE.test(out.slug)) bad('slug', 'must be lowercase kebab-case (a-z, 0-9, -)');
  out.title = optStr('title', 200);
  if (out.title !== undefined && !out.title) bad('title', 'must not be empty');
  out.excerpt = optStr('excerpt', 500);
  for (const key of ['locale', 'primary_locale'] as const) {
    const v = body[key];
    if (v === undefined) continue;
    if (!isLocale(v)) bad(key, `must be one of ${LOCALES.join(', ')}`);
    else out[key] = v;
  }
  if (body.access !== undefined) {
    if (body.access !== 'free' && body.access !== 'knowledges') bad('access', "must be 'free' or 'knowledges'");
    out.access = body.access === 'knowledges' ? 'knowledges' : 'free';
  }
  if (body.tags !== undefined) {
    const tags = body.tags;
    if (!Array.isArray(tags) || tags.length > 20 || !tags.every(t => typeof t === 'string' && t.trim().length > 0 && t.length <= 40)) {
      bad('tags', 'must be an array of at most 20 non-empty strings (≤ 40 chars)');
    }
    out.tags = Array.isArray(tags) ? Array.from(new Set(tags.map(t => String(t).trim()))) : [];
  }
  if (body.category !== undefined) {
    if (body.category !== null && (typeof body.category !== 'string' || body.category.length > 80)) bad('category', 'must be a category id, slug or null');
    out.category = typeof body.category === 'string' ? body.category : null;
  }
  if (body.document !== undefined) {
    const res = validateDocument(body.document);
    if (!res.ok) throw new AppError(422, 'invalid_document', 'Document failed schema validation', { errors: res.errors });
    out.document = res.doc;
  }
  if (mode === 'create') {
    if (!out.slug) bad('slug', 'is required');
    if (!out.title) bad('title', 'is required');
  }
  return out;
}

/** Returns an error Response when the caller is not an admin, otherwise null. */
export async function adminGuard(request: Request, d1?: D1DatabaseLike, env?: RuntimeEnv): Promise<Response | null> {
  const auth = await authenticateAdmin(request, d1, env);
  if (auth.authenticated) return null;
  return auth.role
    ? jsonError(403, 'forbidden', auth.error ?? 'Admin role required')
    : jsonError(401, 'unauthorized', auth.error ?? 'Unauthorized');
}

/**
 * Resolves who is reading. Every article surface (HTML page, .md, REST, MCP, search) goes through
 * the central membership policy so full text is granted by exactly the same rule.
 */
export async function resolveReader(request: Request, d1?: D1DatabaseLike, env: RuntimeEnv = {}): Promise<{ viewer: Viewer; principal: Principal }> {
  const principal = await resolvePrincipal(request, { ...env, DB: d1 ?? env.DB });
  return { viewer: viewerFromPrincipal(principal), principal };
}

export async function resolveViewer(request: Request, d1?: D1DatabaseLike, env: RuntimeEnv = {}): Promise<Viewer> {
  return (await resolveReader(request, d1, env)).viewer;
}

/**
 * The single authorization point for reading an article: published + paywalled for readers,
 * draft only for admins who asked for it. Returns null when the viewer may not see it.
 */
export async function getArticleView(
  d1: D1DatabaseLike | undefined,
  slug: string,
  viewer: Viewer,
  opts: { draft?: boolean; locale?: Locale } = {},
): Promise<ArticleView | null> {
  const draft = opts.draft === true && viewer.isAdmin;
  const rec = await getArticle(d1, slug, { locale: opts.locale, publishedOnly: !draft });
  if (!rec) return null;
  const { locale_fallback, ...withFallback } = rec;
  const summary = toSummary(withFallback);
  const publicSummary: ArticleSummary = viewer.isAdmin ? summary : { ...summary, editions: undefined };
  if (draft) {
    const emailNotification = d1 ? await getArticleNotification(d1, rec.id) : null;
    return {
      ...publicSummary, email_notification: emailNotification, document: rec.draft, recovery: rec.draft_recovery,
      truncated: false, preview: true, locale_fallback,
    };
  }
  if (!rec.published) return null;
  const { doc, truncated, outline } = applyPaywall(rec.published, rec.access, viewer);
  return { ...publicSummary, document: doc, truncated, ...(outline ? { locked_outline: outline } : {}), preview: false, locale_fallback };
}

// ---------- Writes ----------

/** Re-renders share images (og:image) of every published edition in the background after a write. */
function scheduleOgRefresh(db: D1DatabaseLike, articleId: string, slug: string, ctx: WriteContext): void {
  if (!ctx.waitUntil) return;
  // Loaded lazily: the renderer pulls in wasm engines that only the Workers runtime can instantiate.
  ctx.waitUntil((async () => {
    const [{ refreshArticleOgImages }, { renderArticleOgPng }] = await Promise.all([
      import('../og/article-og-service'),
      import('../og/og-renderer'),
    ]);
    await refreshArticleOgImages(db, articleId, slug, card => renderArticleOgPng(card));
  })().catch(err => console.error('Share image refresh failed:', err instanceof Error ? err.message : 'unknown')));
}

function firstImage(blocks: Block[]): string | null {
  let url: string | null = null;
  walkBlocks(blocks, b => {
    if (url) return;
    if (b.type === 'image') url = b.url;
    else if (b.type === 'gallery' && b.images[0]) url = b.images[0].url;
  });
  return url;
}

async function recordRevision(
  db: D1DatabaseLike, articleId: string, locale: Locale, revision: number,
  action: 'create' | 'save' | 'publish' | 'delete_edition', title: string, excerpt: string, docJson: string, actor: string,
): Promise<void> {
  // The snapshot is the stored JSON itself, so a read-side recovery is never baked into history.
  await db.prepare(`
    INSERT INTO article_revisions (id, article_id, locale, revision, action, title, excerpt, document_json, actor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(newId('rev_'), articleId, locale, revision, action, title, excerpt, docJson, actor, nowIso()).run();
}

/**
 * Condition appended to every write of a revisioned save (bind: article id, expected revision), so inside
 * the save's batch nothing applies unless the revision bump at the end applies too.
 */
const AT_EXPECTED = 'EXISTS (SELECT 1 FROM articles WHERE id = ? AND revision = ? AND deleted_at IS NULL)';

/** A history row written only while the article is still at `expected`. */
function guardedRevisionStatement(
  db: D1DatabaseLike, articleId: string, expected: number, locale: Locale,
  action: 'create' | 'save' | 'publish' | 'delete_edition', title: string, excerpt: string, docJson: string, actor: string, now: string,
): D1PreparedStatementLike {
  // The snapshot is the stored JSON itself, so a read-side recovery is never baked into history.
  return db.prepare(`
    INSERT INTO article_revisions (id, article_id, locale, revision, action, title, excerpt, document_json, actor, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${AT_EXPECTED}
  `).bind(newId('rev_'), articleId, locale, expected + 1, action, title, excerpt, docJson, actor, now, articleId, expected);
}

/** Replaces the article's tag rows (same order and semantics as `setArticleTags`) while it is still at `expected`. */
function guardedTagStatements(db: D1DatabaseLike, articleId: string, expected: number, tagIds: string[], now: string): D1PreparedStatementLike[] {
  return [
    db.prepare(`DELETE FROM article_tags WHERE article_id = ? AND ${AT_EXPECTED}`).bind(articleId, articleId, expected),
    ...tagIds.map((tagId, i) => db.prepare(`
      INSERT OR IGNORE INTO article_tags (article_id, tag_id, position, created_at) SELECT ?, ?, ?, ? WHERE ${AT_EXPECTED}
    `).bind(articleId, tagId, i, now, articleId, expected)),
  ];
}

/** The compare-and-set that moves the article from `expected` to `expected + 1`. */
function bumpRevisionStatement(db: D1DatabaseLike, articleId: string, expected: number, now: string): D1PreparedStatementLike {
  return db.prepare('UPDATE articles SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL')
    .bind(now, articleId, expected);
}

/**
 * Runs a save's guarded writes, then its revision bump, then derived rebuilds, in one D1 batch (one
 * transaction): the save applies fully at expected + 1 or not at all. A lost bump is a revision conflict.
 */
async function commitAtRevision(
  db: D1DatabaseLike, slug: string, writes: D1PreparedStatementLike[], bump: D1PreparedStatementLike, derived: D1PreparedStatementLike[] = [],
): Promise<void> {
  const results = await db.batch([...writes, bump, ...derived]);
  if (!results[writes.length]?.meta?.changes) return conflict(db, slug);
}

/** Keeps the legacy single-locale columns of `articles` equal to the primary edition (older builds read them). */
function mirrorPrimaryStatement(db: D1DatabaseLike, articleId: string): D1PreparedStatementLike {
  return db.prepare(`
    UPDATE articles SET
      title = COALESCE((SELECT e.title FROM article_editions e WHERE e.article_id = articles.id AND e.locale = articles.locale AND e.deleted_at IS NULL), title),
      excerpt = COALESCE((SELECT e.excerpt FROM article_editions e WHERE e.article_id = articles.id AND e.locale = articles.locale AND e.deleted_at IS NULL), excerpt),
      draft_json = COALESCE((SELECT e.draft_json FROM article_editions e WHERE e.article_id = articles.id AND e.locale = articles.locale AND e.deleted_at IS NULL), draft_json),
      published_json = (SELECT e.published_json FROM article_editions e WHERE e.article_id = articles.id AND e.locale = articles.locale AND e.deleted_at IS NULL),
      published_at = (SELECT e.published_at FROM article_editions e WHERE e.article_id = articles.id AND e.locale = articles.locale AND e.deleted_at IS NULL),
      status = CASE WHEN EXISTS (SELECT 1 FROM article_editions e WHERE e.article_id = articles.id AND e.locale = articles.locale AND e.deleted_at IS NULL AND e.published_json IS NOT NULL) THEN 'published' ELSE 'draft' END
    WHERE id = ?
  `).bind(articleId);
}

async function conflict(db: D1DatabaseLike, slug: string): Promise<never> {
  const current = await loadArticleRow(db, slug);
  if (!current) throw new AppError(404, 'not_found', 'Article not found');
  throw new AppError(409, 'revision_conflict', 'Article was changed by someone else; reload and retry', { current_revision: current.revision });
}

function requireRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new AppError(400, 'invalid_field', 'expected_revision must be a positive integer', { field: 'expected_revision' });
  }
  return value;
}

export async function createArticle(d1: D1DatabaseLike | undefined, input: ArticleInput, ctx: WriteContext = {}): Promise<ArticleRecord> {
  const db = requireDb(d1);
  if (!input.slug || !input.title) throw new AppError(400, 'invalid_field', 'slug and title are required');
  const existing = await db.prepare('SELECT id FROM articles WHERE slug = ?').bind(input.slug).first<Row>();
  if (existing) throw new AppError(409, 'slug_taken', `Slug "${input.slug}" is already used`);
  const actor = ctx.actor ?? 'admin';
  const locale = input.locale ?? input.primary_locale ?? DEFAULT_LOCALE;
  const categoryId = input.category !== undefined ? await resolveCategoryRef(db, input.category) : null;
  const tagIds = input.tags ? await resolveTagRefs(db, input.tags, { createMissing: true, locale, actor }) : [];
  const now = nowIso();
  const id = newId('art_');
  const doc = input.document ?? emptyDocument();
  const docJson = JSON.stringify(doc);
  await db.prepare(`
    INSERT INTO articles (id, slug, locale, title, excerpt, tags, access, status, draft_json, revision, category_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '[]', ?, 'draft', ?, 1, ?, ?, ?)
  `).bind(id, input.slug, locale, input.title, input.excerpt ?? '', input.access ?? 'free', docJson, categoryId, now, now).run();
  await db.prepare(`
    INSERT INTO article_editions (id, article_id, locale, title, excerpt, draft_json, revision, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'draft', ?, ?)
  `).bind(newId('ed_'), id, locale, input.title, input.excerpt ?? '', docJson, now, now).run();
  await recordRevision(db, id, locale, 1, 'create', input.title, input.excerpt ?? '', docJson, actor);
  await setArticleTags(db, id, tagIds);
  const rec = await getArticle(db, input.slug, { locale });
  if (!rec) throw new AppError(500, 'internal_error', 'Article was not persisted');
  return rec;
}

/**
 * Updates one edition's draft (input.locale, default primary; created when missing) and article-wide
 * metadata when expected_revision matches; bumps the article revision.
 */
export async function updateArticle(
  d1: D1DatabaseLike | undefined, slug: string, input: ArticleInput, expectedRevision: unknown, ctx: WriteContext = {},
): Promise<ArticleRecord> {
  const db = requireDb(d1);
  const expected = requireRevision(expectedRevision);
  const art = await loadArticleRow(db, slug);
  if (!art) throw new AppError(404, 'not_found', 'Article not found');
  const actor = ctx.actor ?? 'admin';
  const locale = input.locale ?? art.primary;
  const editionRow = await db.prepare('SELECT * FROM article_editions WHERE article_id = ? AND locale = ?').bind(art.id, locale).first<Row>();
  const edition = editionRow && !editionRow.deleted_at ? toEditionRow(editionRow) : null;
  if (!edition && !input.title) throw new AppError(400, 'invalid_field', `title is required to create the ${locale} edition`, { field: 'title' });

  const nextSlug = input.slug ?? art.slug;
  if (nextSlug !== art.slug) {
    const taken = await db.prepare('SELECT id FROM articles WHERE slug = ?').bind(nextSlug).first<Row>();
    if (taken) throw new AppError(409, 'slug_taken', `Slug "${nextSlug}" is already used`);
  }
  const primary = input.primary_locale ?? art.primary;
  if (primary !== art.primary && primary !== locale) {
    const target = await db.prepare('SELECT id FROM article_editions WHERE article_id = ? AND locale = ? AND deleted_at IS NULL').bind(art.id, primary).first<Row>();
    if (!target) throw new AppError(400, 'invalid_field', `primary_locale ${primary} has no edition`, { field: 'primary_locale' });
  }
  // Without a new document the stored draft is kept byte for byte; it is only checked so an
  // unreadable draft is never re-saved (or snapshotted into a revision) as an empty one.
  if (!input.document && edition) requireStoredDraft(edition.draftJson, slug, locale);
  const docJson = input.document ? JSON.stringify(input.document) : edition ? edition.draftJson : JSON.stringify(emptyDocument());
  const categoryId = input.category !== undefined ? await resolveCategoryRef(db, input.category) : art.categoryId;
  const tagIds = input.tags ? await resolveTagRefs(db, input.tags, { createMissing: true, locale, actor }) : null;

  const now = nowIso();
  const revision = expected + 1;
  const title = input.title ?? edition?.title ?? '';
  const excerpt = input.excerpt ?? edition?.excerpt ?? '';
  const writes: D1PreparedStatementLike[] = [];
  if (edition) {
    writes.push(db.prepare(`UPDATE article_editions SET title = ?, excerpt = ?, draft_json = ?, revision = ?, updated_at = ? WHERE article_id = ? AND locale = ? AND ${AT_EXPECTED}`)
      .bind(title, excerpt, docJson, revision, now, art.id, locale, art.id, expected));
  } else if (editionRow) {
    // Re-creating a deleted edition reuses its row (article_id + locale is unique) and starts as a draft.
    writes.push(db.prepare(`
      UPDATE article_editions SET title = ?, excerpt = ?, draft_json = ?, published_json = NULL, published_revision = NULL,
        status = 'draft', published_words = 0, cover_url = NULL, published_at = NULL, revision = ?, updated_at = ?, deleted_at = NULL
      WHERE article_id = ? AND locale = ? AND ${AT_EXPECTED}
    `).bind(title, excerpt, docJson, revision, now, art.id, locale, art.id, expected));
  } else {
    writes.push(db.prepare(`
      INSERT INTO article_editions (id, article_id, locale, title, excerpt, draft_json, revision, status, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ? WHERE ${AT_EXPECTED}
    `).bind(newId('ed_'), art.id, locale, title, excerpt, docJson, revision, now, now, art.id, expected));
  }
  writes.push(guardedRevisionStatement(db, art.id, expected, locale, edition ? 'save' : 'create', title, excerpt, docJson, actor, now));
  if (tagIds) writes.push(...guardedTagStatements(db, art.id, expected, tagIds, now));
  const bump = db.prepare(`
    UPDATE articles SET slug = ?, locale = ?, access = ?, category_id = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ? AND deleted_at IS NULL
  `).bind(nextSlug, primary, input.access ?? art.access, categoryId, now, art.id, expected);
  // The primary mirror is derived from the editions, so it is correct to run whether or not this save won.
  await commitAtRevision(db, slug, writes, bump, [mirrorPrimaryStatement(db, art.id)]);

  // Derived caches rebuilt from the committed rows: the legacy tag names column and the search index
  // (which also calls Workers AI / Vectorize, so it cannot join a D1 batch). Both are idempotent.
  if (tagIds) await mirrorLegacyTags(db, art.id);
  // Access, tags and category affect what each search tier may contain: always rebuild.
  await reindexArticle(db, art.id, ctx.env);
  scheduleOgRefresh(db, art.id, nextSlug, ctx);
  const updated = await getArticle(db, nextSlug, { locale });
  if (!updated) throw new AppError(500, 'internal_error', 'Article disappeared after update');
  return updated;
}

/**
 * Optional backdated publish time for imported archives: an ISO date/datetime that is not in the
 * future. Returns null when absent so the first-publish time is kept.
 */
export function parsePublishedAt(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const ms = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ms)) throw new AppError(400, 'invalid_field', 'published_at must be an ISO date', { field: 'published_at' });
  if (ms > Date.now() + 60_000) throw new AppError(400, 'invalid_field', 'published_at cannot be in the future', { field: 'published_at' });
  return new Date(ms).toISOString();
}

/** A publish time more than this far in the past is an archive import: no member email unless asked for. */
const BACKDATE_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Publishes one edition's current draft (locale defaults to primary). Requires confirm === true.
 * The first publish of an article schedules its member email 30 minutes later; `notify: false` (or a backdated
 * `published_at`) skips it, and `notify: true` schedules an article that was skipped before.
 */
export async function publishArticle(
  d1: D1DatabaseLike | undefined, slug: string, expectedRevision: unknown, confirm: unknown,
  ctx: WriteContext & { locale?: Locale; publishedAt?: unknown; notify?: unknown } = {},
): Promise<ArticleRecord> {
  const db = requireDb(d1);
  if (confirm !== true) throw new AppError(400, 'confirmation_required', 'Publishing requires confirm: true');
  const expected = requireRevision(expectedRevision);
  const publishedAt = parsePublishedAt(ctx.publishedAt);
  const notify = parseNotifyFlag(ctx.notify);
  const art = await loadArticleRow(db, slug);
  if (!art) throw new AppError(404, 'not_found', 'Article not found');
  const locale = ctx.locale ?? art.primary;
  const row = await db.prepare('SELECT * FROM article_editions WHERE article_id = ? AND locale = ? AND deleted_at IS NULL').bind(art.id, locale).first<Row>();
  if (!row) throw new AppError(404, 'not_found', `No ${locale} edition to publish`);
  const edition = toEditionRow(row);
  // Publishing copies draft_json as stored; an unreadable draft would publish an empty article.
  const doc = requireStoredDraft(edition.draftJson, slug, locale);
  const now = nowIso();
  // Durable "was this article ever published" signal, independent of article_notifications rows.
  const previouslyPublished = Boolean(await db.prepare(`
    SELECT 1 FROM article_revisions WHERE article_id = ? AND action = 'publish'
    UNION ALL SELECT 1 FROM article_editions WHERE article_id = ? AND published_json IS NOT NULL LIMIT 1
  `).bind(art.id, art.id).first());
  const revision = expected + 1;
  const publicPart = applyPaywall(doc, art.access, { isAdmin: false, entitlements: [] }).doc;
  // Guarded by the revision, so the draft copied here is the one read above: a save landing in between
  // bumps the revision and turns this publish into a conflict instead of publishing an unseen draft.
  await commitAtRevision(db, slug, [
    db.prepare(`
      UPDATE article_editions SET published_json = draft_json, status = 'published', published_revision = ?, revision = ?,
        published_at = COALESCE(?, published_at, ?), published_words = ?, cover_url = ?, updated_at = ?
      WHERE article_id = ? AND locale = ? AND ${AT_EXPECTED}
    `).bind(revision, revision, publishedAt, now, wordCount(documentText(doc)), firstImage(publicPart.blocks), now, art.id, locale, art.id, expected),
    guardedRevisionStatement(db, art.id, expected, locale, 'publish', edition.title, edition.excerpt, edition.draftJson, ctx.actor ?? 'admin', now),
  ], bumpRevisionStatement(db, art.id, expected, now), [mirrorPrimaryStatement(db, art.id)]);
  await reindexArticle(db, art.id, ctx.env);
  scheduleOgRefresh(db, art.id, slug, ctx);
  const nowMs = Date.now();
  const backdated = publishedAt !== null && Date.parse(publishedAt) < nowMs - BACKDATE_THRESHOLD_MS;
  const emailNotification = await applyPublishNotification(db, art.id, { notify, backdated, previouslyPublished, actor: ctx.actor ?? 'admin', nowMs });
  const rec = await getArticle(db, slug, { locale });
  if (!rec) throw new AppError(500, 'internal_error', 'Article disappeared after publish');
  return { ...rec, email_notification: emailNotification };
}

/** Soft-deletes one non-primary edition. */
export async function deleteEdition(
  d1: D1DatabaseLike | undefined, slug: string, locale: Locale, expectedRevision: unknown, ctx: WriteContext = {},
): Promise<ArticleRecord> {
  const db = requireDb(d1);
  const expected = requireRevision(expectedRevision);
  const art = await loadArticleRow(db, slug);
  if (!art) throw new AppError(404, 'not_found', 'Article not found');
  if (locale === art.primary) throw new AppError(409, 'primary_edition', 'Change primary_locale before deleting the primary edition');
  const row = await db.prepare('SELECT * FROM article_editions WHERE article_id = ? AND locale = ? AND deleted_at IS NULL').bind(art.id, locale).first<Row>();
  if (!row) throw new AppError(404, 'not_found', `No ${locale} edition`);
  const now = nowIso();
  const edition = toEditionRow(row);
  await commitAtRevision(db, slug, [
    db.prepare(`UPDATE article_editions SET deleted_at = ?, updated_at = ?, revision = ? WHERE article_id = ? AND locale = ? AND ${AT_EXPECTED}`)
      .bind(now, now, expected + 1, art.id, locale, art.id, expected),
    guardedRevisionStatement(db, art.id, expected, locale, 'delete_edition', edition.title, edition.excerpt, edition.draftJson, ctx.actor ?? 'admin', now),
  ], bumpRevisionStatement(db, art.id, expected, now));
  await reindexArticle(db, art.id, ctx.env);
  scheduleOgRefresh(db, art.id, slug, ctx);
  const rec = await getArticle(db, slug);
  if (!rec) throw new AppError(500, 'internal_error', 'Article disappeared after edition delete');
  return rec;
}

/** Soft delete; the slug stays reserved. Search rows are removed immediately. */
export async function deleteArticle(d1: D1DatabaseLike | undefined, slug: string, ctx: WriteContext = {}): Promise<void> {
  const db = requireDb(d1);
  const now = nowIso();
  const art = await loadArticleRow(db, slug);
  if (!art) throw new AppError(404, 'not_found', 'Article not found');
  const res = await db.prepare('UPDATE articles SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .bind(now, now, art.id).run();
  if (!res.meta?.changes) throw new AppError(404, 'not_found', 'Article not found');
  await cancelArticleNotification(db, art.id, 'article_deleted');
  await reindexArticle(db, art.id, ctx.env);
  scheduleOgRefresh(db, art.id, slug, ctx);
}

/** Replaces the article's public topic tags (admin; expected_revision; audit via revision bump). */
export async function setTagsForArticle(
  d1: D1DatabaseLike | undefined, slug: string, refs: unknown, expectedRevision: unknown, ctx: WriteContext = {},
): Promise<ArticleRecord> {
  const db = requireDb(d1);
  const expected = requireRevision(expectedRevision);
  const art = await loadArticleRow(db, slug);
  if (!art) throw new AppError(404, 'not_found', 'Article not found');
  const tagIds = await resolveTagRefs(db, refs, { createMissing: false, locale: art.primary, actor: ctx.actor ?? 'admin' });
  const now = nowIso();
  await commitAtRevision(db, slug, guardedTagStatements(db, art.id, expected, tagIds, now), bumpRevisionStatement(db, art.id, expected, now));
  // Derived cache rebuilt from the committed rows (legacy tag names column); idempotent.
  await mirrorLegacyTags(db, art.id);
  await reindexArticle(db, art.id, ctx.env);
  scheduleOgRefresh(db, art.id, slug, ctx);
  const rec = await getArticle(db, slug);
  if (!rec) throw new AppError(500, 'internal_error', 'Article disappeared after tag update');
  return rec;
}

export interface RevisionEntry {
  revision: number;
  locale: Locale;
  action: string;
  title: string;
  actor: string;
  created_at: string;
}

export async function listRevisions(d1: D1DatabaseLike | undefined, slug: string, locale?: Locale): Promise<RevisionEntry[]> {
  const db = requireDb(d1);
  const art = await loadArticleRow(db, slug);
  if (!art) throw new AppError(404, 'not_found', 'Article not found');
  const { results } = locale
    ? await db.prepare('SELECT revision, locale, action, title, actor, created_at FROM article_revisions WHERE article_id = ? AND locale = ? ORDER BY revision DESC, created_at DESC LIMIT 200').bind(art.id, locale).all<Row>()
    : await db.prepare('SELECT revision, locale, action, title, actor, created_at FROM article_revisions WHERE article_id = ? ORDER BY revision DESC, created_at DESC LIMIT 200').bind(art.id).all<Row>();
  return (results ?? []).map(r => ({
    revision: n(r, 'revision'), locale: asLocale(r.locale), action: s(r, 'action'), title: s(r, 'title'), actor: s(r, 'actor'), created_at: s(r, 'created_at'),
  }));
}

/**
 * Admin: a stored revision's document (to inspect or restore by saving it as a new draft). `recovery`
 * is null when the snapshot was read as stored; otherwise restoring and saving it makes the loss permanent.
 */
export async function getRevisionDocument(
  d1: D1DatabaseLike | undefined, slug: string, locale: Locale, revision: number,
): Promise<{ revision: number; locale: Locale; title: string; excerpt: string; document: ArticleDocument; recovery: DocumentRecovery | null } | null> {
  const db = requireDb(d1);
  const art = await loadArticleRow(db, slug);
  if (!art) return null;
  const row = await db.prepare('SELECT * FROM article_revisions WHERE article_id = ? AND locale = ? AND revision = ? ORDER BY created_at DESC LIMIT 1')
    .bind(art.id, locale, revision).first<Row>();
  if (!row) return null;
  const read = readStoredDocWithRecovery(s(row, 'document_json'), slug);
  return { revision, locale, title: s(row, 'title'), excerpt: s(row, 'excerpt'), document: read.doc ?? emptyDocument(), recovery: read.recovery };
}
