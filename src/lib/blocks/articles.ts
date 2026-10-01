import type { D1DatabaseLike } from '../../db/store';
import { AppError, jsonError } from '../http';
import { authenticateAdmin } from '../auth';
import type { ArticleAccess, ArticleDocument, ArticleStatus } from './schema';
import { emptyDocument } from './schema';
import { validateDocument } from './validate';
import { applyPaywall } from './paywall';
import type { Viewer } from './paywall';
import type { RuntimeEnv } from '../../env';
import type { Principal } from '../members/policy';
import { resolvePrincipal, viewerFromPrincipal } from '../members/policy';

export interface ArticleSummary {
  id: string;
  slug: string;
  locale: string;
  title: string;
  excerpt: string;
  tags: string[];
  access: ArticleAccess;
  status: ArticleStatus;
  revision: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  has_unpublished_changes: boolean;
}

export interface ArticleRecord extends ArticleSummary {
  draft: ArticleDocument;
  published: ArticleDocument | null;
}

/** What a reader (or admin preview) receives: one document, already paywalled. */
export interface ArticleView extends ArticleSummary {
  document: ArticleDocument;
  truncated: boolean;
  preview: boolean;
}

export interface ArticleInput {
  slug?: string;
  title?: string;
  excerpt?: string;
  locale?: string;
  access?: ArticleAccess;
  tags?: string[];
  document?: ArticleDocument;
}

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCALES = ['vi', 'en'];

type Row = Record<string, unknown>;

function s(row: Row, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v : '';
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseStoredDoc(text: string, slug: string): ArticleDocument {
  const res = validateDocument(parseJson(text));
  if (res.ok) return res.doc;
  console.error(`Stored document for article "${slug}" failed validation`);
  return emptyDocument();
}

function rowToRecord(row: Row): ArticleRecord {
  const slug = s(row, 'slug');
  const tagsRaw = parseJson(s(row, 'tags'));
  const publishedJson = typeof row.published_json === 'string' ? row.published_json : null;
  const draftJson = s(row, 'draft_json');
  return {
    id: s(row, 'id'),
    slug,
    locale: s(row, 'locale') || 'vi',
    title: s(row, 'title'),
    excerpt: s(row, 'excerpt'),
    tags: Array.isArray(tagsRaw) ? tagsRaw.filter((t): t is string => typeof t === 'string') : [],
    access: row.access === 'knowledges' ? 'knowledges' : 'free',
    status: row.status === 'published' ? 'published' : 'draft',
    revision: typeof row.revision === 'number' ? row.revision : Number(row.revision) || 1,
    created_at: s(row, 'created_at'),
    updated_at: s(row, 'updated_at'),
    published_at: typeof row.published_at === 'string' ? row.published_at : null,
    has_unpublished_changes: publishedJson !== draftJson,
    draft: parseStoredDoc(draftJson, slug),
    published: publishedJson ? parseStoredDoc(publishedJson, slug) : null,
  };
}

export function toSummary(rec: ArticleRecord): ArticleSummary {
  const { draft: _draft, published: _published, ...summary } = rec;
  return summary;
}

function requireDb(d1: D1DatabaseLike | undefined): D1DatabaseLike {
  if (!d1) throw new AppError(503, 'db_unavailable', 'Database binding is not configured');
  return d1;
}

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
  out.locale = optStr('locale', 5);
  if (out.locale !== undefined && !LOCALES.includes(out.locale)) bad('locale', `must be one of ${LOCALES.join(', ')}`);
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
export async function adminGuard(request: Request, d1?: D1DatabaseLike): Promise<Response | null> {
  const auth = await authenticateAdmin(request, d1);
  if (auth.authenticated) return null;
  return auth.role
    ? jsonError(403, 'forbidden', auth.error ?? 'Admin role required')
    : jsonError(401, 'unauthorized', auth.error ?? 'Unauthorized');
}

/**
 * Resolves who is reading. Every article surface (HTML page, .md, REST, MCP) goes through
 * the central membership policy so full text is granted by exactly the same rule.
 */
export async function resolveReader(request: Request, d1?: D1DatabaseLike, env: RuntimeEnv = {}): Promise<{ viewer: Viewer; principal: Principal }> {
  const principal = await resolvePrincipal(request, { ...env, DB: d1 ?? env.DB });
  return { viewer: viewerFromPrincipal(principal), principal };
}

export async function resolveViewer(request: Request, d1?: D1DatabaseLike, env: RuntimeEnv = {}): Promise<Viewer> {
  return (await resolveReader(request, d1, env)).viewer;
}

export async function listArticles(d1: D1DatabaseLike | undefined, opts: { includeDrafts?: boolean } = {}): Promise<ArticleSummary[]> {
  if (!d1) return [];
  const where = opts.includeDrafts ? 'deleted_at IS NULL' : "deleted_at IS NULL AND published_json IS NOT NULL";
  const { results } = await d1
    .prepare(`SELECT * FROM articles WHERE ${where} ORDER BY COALESCE(published_at, updated_at) DESC LIMIT 500`)
    .all<Row>();
  return (results ?? []).map(r => toSummary(rowToRecord(r)));
}

export async function getArticle(d1: D1DatabaseLike | undefined, slug: string): Promise<ArticleRecord | null> {
  if (!d1) return null;
  const row = await d1.prepare('SELECT * FROM articles WHERE slug = ? AND deleted_at IS NULL').bind(slug).first<Row>();
  return row ? rowToRecord(row) : null;
}

/**
 * The single authorization point for reading an article: published + paywalled for readers,
 * draft only for admins who asked for it. Returns null when the viewer may not see it.
 */
export async function getArticleView(
  d1: D1DatabaseLike | undefined,
  slug: string,
  viewer: Viewer,
  opts: { draft?: boolean } = {},
): Promise<ArticleView | null> {
  const rec = await getArticle(d1, slug);
  if (!rec) return null;
  const summary = toSummary(rec);
  if (opts.draft && viewer.isAdmin) return { ...summary, document: rec.draft, truncated: false, preview: true };
  if (!rec.published) return null;
  const { doc, truncated } = applyPaywall(rec.published, rec.access, viewer);
  return { ...summary, document: doc, truncated, preview: false };
}

export async function createArticle(d1: D1DatabaseLike | undefined, input: ArticleInput): Promise<ArticleRecord> {
  const db = requireDb(d1);
  if (!input.slug || !input.title) throw new AppError(400, 'invalid_field', 'slug and title are required');
  const existing = await db.prepare('SELECT id FROM articles WHERE slug = ?').bind(input.slug).first<Row>();
  if (existing) throw new AppError(409, 'slug_taken', `Slug "${input.slug}" is already used`);
  const now = new Date().toISOString();
  const id = 'art_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  await db.prepare(`
    INSERT INTO articles (id, slug, locale, title, excerpt, tags, access, status, draft_json, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, 1, ?, ?)
  `).bind(
    id, input.slug, input.locale ?? 'vi', input.title, input.excerpt ?? '', JSON.stringify(input.tags ?? []),
    input.access ?? 'free', JSON.stringify(input.document ?? emptyDocument()), now, now,
  ).run();
  const rec = await getArticle(db, input.slug);
  if (!rec) throw new AppError(500, 'internal_error', 'Article was not persisted');
  return rec;
}

function requireRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new AppError(400, 'invalid_field', 'expected_revision must be a positive integer', { field: 'expected_revision' });
  }
  return value;
}

async function conflict(db: D1DatabaseLike, slug: string): Promise<never> {
  const current = await getArticle(db, slug);
  if (!current) throw new AppError(404, 'not_found', 'Article not found');
  throw new AppError(409, 'revision_conflict', 'Article was changed by someone else; reload and retry', { current_revision: current.revision });
}

/** Updates the draft (and metadata) when expected_revision matches; bumps the revision. */
export async function updateArticle(d1: D1DatabaseLike | undefined, slug: string, input: ArticleInput, expectedRevision: unknown): Promise<ArticleRecord> {
  const db = requireDb(d1);
  const expected = requireRevision(expectedRevision);
  const rec = await getArticle(db, slug);
  if (!rec) throw new AppError(404, 'not_found', 'Article not found');
  const nextSlug = input.slug ?? rec.slug;
  if (nextSlug !== rec.slug) {
    const taken = await db.prepare('SELECT id FROM articles WHERE slug = ?').bind(nextSlug).first<Row>();
    if (taken) throw new AppError(409, 'slug_taken', `Slug "${nextSlug}" is already used`);
  }
  const res = await db.prepare(`
    UPDATE articles SET slug = ?, locale = ?, title = ?, excerpt = ?, tags = ?, access = ?, draft_json = ?,
      revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ? AND deleted_at IS NULL
  `).bind(
    nextSlug, input.locale ?? rec.locale, input.title ?? rec.title, input.excerpt ?? rec.excerpt,
    JSON.stringify(input.tags ?? rec.tags), input.access ?? rec.access, JSON.stringify(input.document ?? rec.draft),
    new Date().toISOString(), rec.id, expected,
  ).run();
  if (!res.meta?.changes) return conflict(db, slug);
  const updated = await getArticle(db, nextSlug);
  if (!updated) throw new AppError(500, 'internal_error', 'Article disappeared after update');
  return updated;
}

/** Copies the current draft to the public snapshot. Requires confirm === true. */
export async function publishArticle(d1: D1DatabaseLike | undefined, slug: string, expectedRevision: unknown, confirm: unknown): Promise<ArticleRecord> {
  const db = requireDb(d1);
  if (confirm !== true) throw new AppError(400, 'confirmation_required', 'Publishing requires confirm: true');
  const expected = requireRevision(expectedRevision);
  const now = new Date().toISOString();
  const res = await db.prepare(`
    UPDATE articles SET published_json = draft_json, status = 'published', published_at = COALESCE(published_at, ?),
      revision = revision + 1, updated_at = ?
    WHERE slug = ? AND revision = ? AND deleted_at IS NULL
  `).bind(now, now, slug, expected).run();
  if (!res.meta?.changes) return conflict(db, slug);
  const rec = await getArticle(db, slug);
  if (!rec) throw new AppError(500, 'internal_error', 'Article disappeared after publish');
  return rec;
}

/** Soft delete; the slug stays reserved. */
export async function deleteArticle(d1: D1DatabaseLike | undefined, slug: string): Promise<void> {
  const db = requireDb(d1);
  const now = new Date().toISOString();
  const res = await db.prepare('UPDATE articles SET deleted_at = ?, updated_at = ? WHERE slug = ? AND deleted_at IS NULL')
    .bind(now, now, slug).run();
  if (!res.meta?.changes) throw new AppError(404, 'not_found', 'Article not found');
}
