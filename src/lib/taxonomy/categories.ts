import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { Locale } from '../i18n/locales';
import { reindexArticle } from '../search/indexer';
import type { LocalizedNames, Row } from './common';
import {
  bad, localizedName, newId, normalizeKey, nowIso, num, parseNames, parseNamesInput, parseSlug, requireDb, requireRevision,
  slugify, str, writeAuditLog,
} from './common';

export interface PublicCategory { id: string; slug: string; name: string }

export interface Category {
  id: string;
  slug: string;
  names: LocalizedNames;
  position: number;
  revision: number;
  article_count: number;
  created_at: string;
  updated_at: string;
}

export interface CategoryInput { slug?: string; names?: LocalizedNames; position?: number }

function rowToCategory(r: Row): Category {
  return {
    id: str(r, 'id'), slug: str(r, 'slug'), names: parseNames(r.names), position: num(r, 'position'),
    revision: num(r, 'revision', 1), article_count: num(r, 'article_count'), created_at: str(r, 'created_at'), updated_at: str(r, 'updated_at'),
  };
}

export function toPublicCategory(cat: Pick<Category, 'id' | 'slug' | 'names'>, locale: Locale): PublicCategory {
  return { id: cat.id, slug: cat.slug, name: localizedName(cat.names, locale, cat.slug) };
}

export function parseCategoryInput(body: Record<string, unknown>, mode: 'create' | 'update'): CategoryInput {
  const out: CategoryInput = {};
  if (body.names !== undefined) out.names = parseNamesInput('names', body.names, 60);
  if (body.slug !== undefined) out.slug = parseSlug('slug', body.slug);
  if (body.position !== undefined) {
    if (typeof body.position !== 'number' || !Number.isInteger(body.position) || body.position < 0 || body.position > 10_000) bad('position', 'must be an integer 0–10000');
    out.position = body.position;
  }
  if (mode === 'create') {
    if (!out.names) bad('names', 'is required');
    if (!out.slug) {
      out.slug = slugify(Object.values(out.names ?? {}).find(Boolean) ?? '');
      if (!out.slug) bad('slug', 'could not be derived from names; provide one');
    }
  }
  return out;
}

export async function listCategories(d1: D1DatabaseLike | undefined): Promise<Category[]> {
  if (!d1) return [];
  const { results } = await d1.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM articles a WHERE a.category_id = c.id AND a.deleted_at IS NULL) AS article_count
    FROM knowledge_categories c WHERE c.deleted_at IS NULL ORDER BY c.position, c.slug
  `).all<Row>();
  return (results ?? []).map(rowToCategory);
}

export async function getCategory(d1: D1DatabaseLike | undefined, idOrSlug: string): Promise<Category | null> {
  const db = requireDb(d1);
  const row = await db.prepare('SELECT * FROM knowledge_categories WHERE (id = ? OR slug = ?) AND deleted_at IS NULL').bind(idOrSlug, idOrSlug).first<Row>();
  return row ? rowToCategory(row) : null;
}

async function assertUniqueSlug(db: D1DatabaseLike, slug: string, selfId: string | null): Promise<void> {
  const row = await db.prepare('SELECT id FROM knowledge_categories WHERE slug = ?').bind(slug).first<Row>();
  if (row && str(row, 'id') !== selfId) throw new AppError(409, 'slug_taken', `Category slug "${slug}" is already used`);
  const cats = await listCategories(db);
  const key = normalizeKey(slug);
  const clash = cats.find(c => c.id !== selfId && normalizeKey(c.slug) === key);
  if (clash) throw new AppError(409, 'slug_taken', `Category slug "${slug}" duplicates "${clash.slug}"`);
}

export async function createCategory(d1: D1DatabaseLike | undefined, input: CategoryInput, actor: string): Promise<Category> {
  const db = requireDb(d1);
  if (!input.slug || !input.names) throw new AppError(400, 'invalid_field', 'names are required');
  await assertUniqueSlug(db, input.slug, null);
  const now = nowIso();
  const id = newId('cat_');
  await db.prepare('INSERT INTO knowledge_categories (id, slug, names, position, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .bind(id, input.slug, JSON.stringify(input.names), input.position ?? 0, now, now).run();
  const cat = await getCategory(db, id);
  if (!cat) throw new AppError(500, 'internal_error', 'Category was not persisted');
  await writeAuditLog(db, { actor, action: 'category.create', targetType: 'category', targetId: id, after: cat });
  return cat;
}

async function reindexCategory(db: D1DatabaseLike, categoryId: string, env?: RuntimeEnv): Promise<void> {
  const { results } = await db.prepare('SELECT id FROM articles WHERE category_id = ?').bind(categoryId).all<Row>();
  for (const r of results ?? []) await reindexArticle(db, str(r, 'id'), env);
}

export async function updateCategory(
  d1: D1DatabaseLike | undefined, idOrSlug: string, input: CategoryInput, expectedRevision: unknown, actor: string, env?: RuntimeEnv,
): Promise<Category> {
  const db = requireDb(d1);
  const expected = requireRevision(expectedRevision);
  const cat = await getCategory(db, idOrSlug);
  if (!cat) throw new AppError(404, 'not_found', 'Category not found');
  if (input.slug && input.slug !== cat.slug) await assertUniqueSlug(db, input.slug, cat.id);
  const res = await db.prepare(`
    UPDATE knowledge_categories SET slug = ?, names = ?, position = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ? AND deleted_at IS NULL
  `).bind(input.slug ?? cat.slug, JSON.stringify(input.names ?? cat.names), input.position ?? cat.position, nowIso(), cat.id, expected).run();
  if (!res.meta?.changes) throw new AppError(409, 'revision_conflict', 'Category was changed by someone else; reload and retry', { current_revision: cat.revision });
  const updated = await getCategory(db, cat.id);
  if (!updated) throw new AppError(500, 'internal_error', 'Category disappeared after update');
  await writeAuditLog(db, { actor, action: 'category.update', targetType: 'category', targetId: cat.id, before: cat, after: updated });
  await reindexCategory(db, cat.id, env);
  return updated;
}

/** Soft-deletes a category and detaches it from its articles. */
export async function deleteCategory(d1: D1DatabaseLike | undefined, idOrSlug: string, expectedRevision: unknown, actor: string, env?: RuntimeEnv): Promise<void> {
  const db = requireDb(d1);
  const expected = requireRevision(expectedRevision);
  const cat = await getCategory(db, idOrSlug);
  if (!cat) throw new AppError(404, 'not_found', 'Category not found');
  const now = nowIso();
  const res = await db.prepare('UPDATE knowledge_categories SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL')
    .bind(now, now, cat.id, expected).run();
  if (!res.meta?.changes) throw new AppError(409, 'revision_conflict', 'Category was changed by someone else; reload and retry', { current_revision: cat.revision });
  const { results } = await db.prepare('SELECT id FROM articles WHERE category_id = ?').bind(cat.id).all<Row>();
  await db.prepare('UPDATE articles SET category_id = NULL WHERE category_id = ?').bind(cat.id).run();
  for (const r of results ?? []) await reindexArticle(db, str(r, 'id'), env);
  await writeAuditLog(db, { actor, action: 'category.delete', targetType: 'category', targetId: cat.id, before: cat });
}

/** Resolves a category reference (id or slug); null clears the category. */
export async function resolveCategoryRef(db: D1DatabaseLike, ref: unknown): Promise<string | null> {
  if (ref === null || ref === '') return null;
  if (typeof ref !== 'string') bad('category', 'must be a category id, slug or null');
  const cat = await getCategory(db, ref);
  if (!cat) throw new AppError(400, 'unknown_category', `Unknown category "${ref}"`);
  return cat.id;
}
