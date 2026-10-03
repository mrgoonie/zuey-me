import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { Locale } from '../i18n/locales';
import { isLocale } from '../i18n/locales';
import { reindexArticle } from '../search/indexer';
import type { LocalizedNames, Row } from './common';
import {
  bad, localizedName, newId, normalizeKey, nowIso, num, parseNames, parseNamesInput, parseSlug, parseStringArray,
  requireDb, requireRevision, safeText, slugify, str, writeAuditLog,
} from './common';

export const TAG_LIMITS = { perArticle: 20, nameLength: 40, aliases: 10 } as const;

/** Public tag metadata (safe for every reader, including free and anonymous). */
export interface PublicTag { id: string; slug: string; name: string }

export interface TopicTag {
  id: string;
  slug: string;
  names: LocalizedNames;
  aliases: string[];
  revision: number;
  article_count: number;
  created_at: string;
  updated_at: string;
}

export interface TagInput { slug?: string; names?: LocalizedNames; aliases?: string[] }

function rowToTag(r: Row): TopicTag {
  return {
    id: str(r, 'id'), slug: str(r, 'slug'), names: parseNames(r.names), aliases: parseStringArray(r.aliases),
    revision: num(r, 'revision', 1), article_count: num(r, 'article_count'), created_at: str(r, 'created_at'), updated_at: str(r, 'updated_at'),
  };
}

export function toPublicTag(tag: Pick<TopicTag, 'id' | 'slug' | 'names'>, locale: Locale): PublicTag {
  return { id: tag.id, slug: tag.slug, name: localizedName(tag.names, locale, tag.slug) };
}

export function parseTagInput(body: Record<string, unknown>, mode: 'create' | 'update'): TagInput {
  const out: TagInput = {};
  if (body.names !== undefined) out.names = parseNamesInput('names', body.names, TAG_LIMITS.nameLength);
  if (body.slug !== undefined) out.slug = parseSlug('slug', body.slug);
  if (body.aliases !== undefined) {
    if (!Array.isArray(body.aliases) || body.aliases.length > TAG_LIMITS.aliases) bad('aliases', `must be an array of at most ${TAG_LIMITS.aliases} strings`);
    const seen = new Set<string>();
    out.aliases = [];
    body.aliases.forEach((a: unknown, i: number) => {
      const v = safeText(`aliases[${i}]`, a, TAG_LIMITS.nameLength) ?? '';
      const k = normalizeKey(v);
      if (!seen.has(k)) { seen.add(k); out.aliases?.push(v); }
    });
  }
  if (mode === 'create') {
    if (!out.names) bad('names', 'is required');
    if (!out.slug) {
      const first = Object.values(out.names ?? {}).find(Boolean) ?? '';
      const derived = slugify(first);
      if (!derived) bad('slug', 'could not be derived from names; provide one');
      out.slug = derived;
    }
  }
  return out;
}

async function allTags(db: D1DatabaseLike): Promise<TopicTag[]> {
  const { results } = await db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM article_tags at JOIN articles a ON a.id = at.article_id
      WHERE at.tag_id = t.id AND a.deleted_at IS NULL) AS article_count
    FROM topic_tags t WHERE t.deleted_at IS NULL ORDER BY t.slug
  `).all<Row>();
  return (results ?? []).map(rowToTag);
}

export async function listTags(d1: D1DatabaseLike | undefined): Promise<TopicTag[]> {
  if (!d1) return [];
  return allTags(d1);
}

export async function getTag(d1: D1DatabaseLike | undefined, idOrSlug: string): Promise<TopicTag | null> {
  const db = requireDb(d1);
  const row = await db.prepare('SELECT * FROM topic_tags WHERE (id = ? OR slug = ?) AND deleted_at IS NULL').bind(idOrSlug, idOrSlug).first<Row>();
  return row ? rowToTag(row) : null;
}

/** Every key (slug, aliases, names) that would resolve to a tag; used for duplicate detection. */
function tagKeys(tag: Pick<TopicTag, 'slug' | 'aliases' | 'names'>): string[] {
  return [tag.slug, ...tag.aliases, ...Object.values(tag.names)].filter((v): v is string => typeof v === 'string').map(normalizeKey);
}

async function assertNoCollision(db: D1DatabaseLike, candidate: Pick<TopicTag, 'slug' | 'aliases' | 'names'>, selfId: string | null): Promise<void> {
  const keys = new Set(tagKeys(candidate));
  for (const other of await allTags(db)) {
    if (other.id === selfId) continue;
    const clash = tagKeys(other).find(k => keys.has(k));
    if (clash) throw new AppError(409, 'tag_conflict', `Slug or alias "${clash}" is already used by tag "${other.slug}"`, { tag_id: other.id });
  }
}

/** Reindexes every article carrying the tag so search and public metadata follow renames immediately. */
async function refreshTagged(db: D1DatabaseLike, tagId: string, env?: RuntimeEnv): Promise<void> {
  const { results } = await db.prepare('SELECT article_id FROM article_tags WHERE tag_id = ?').bind(tagId).all<Row>();
  for (const r of results ?? []) {
    const articleId = str(r, 'article_id');
    await mirrorLegacyTags(db, articleId);
    await reindexArticle(db, articleId, env);
  }
}

export async function createTag(d1: D1DatabaseLike | undefined, input: TagInput, actor: string): Promise<TopicTag> {
  const db = requireDb(d1);
  if (!input.slug || !input.names) throw new AppError(400, 'invalid_field', 'names are required');
  const candidate = { slug: input.slug, names: input.names, aliases: input.aliases ?? [] };
  await assertNoCollision(db, candidate, null);
  const now = nowIso();
  const id = newId('tag_');
  const existing = await db.prepare('SELECT id FROM topic_tags WHERE slug = ?').bind(input.slug).first<Row>();
  if (existing) {
    // A soft-deleted tag keeps its slug reserved; restoring it keeps its stable id.
    await db.prepare('UPDATE topic_tags SET names = ?, aliases = ?, deleted_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(candidate.names), JSON.stringify(candidate.aliases), now, str(existing, 'id')).run();
  } else {
    await db.prepare('INSERT INTO topic_tags (id, slug, names, aliases, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .bind(id, candidate.slug, JSON.stringify(candidate.names), JSON.stringify(candidate.aliases), now, now).run();
  }
  const tag = await getTag(db, input.slug);
  if (!tag) throw new AppError(500, 'internal_error', 'Tag was not persisted');
  await writeAuditLog(db, { actor, action: 'tag.create', targetType: 'tag', targetId: tag.id, after: tag });
  return tag;
}

export async function updateTag(
  d1: D1DatabaseLike | undefined, idOrSlug: string, input: TagInput, expectedRevision: unknown, actor: string, env?: RuntimeEnv,
): Promise<TopicTag> {
  const db = requireDb(d1);
  const expected = requireRevision(expectedRevision);
  const tag = await getTag(db, idOrSlug);
  if (!tag) throw new AppError(404, 'not_found', 'Tag not found');
  const next = { slug: input.slug ?? tag.slug, names: input.names ?? tag.names, aliases: input.aliases ?? tag.aliases };
  await assertNoCollision(db, next, tag.id);
  const res = await db.prepare(`
    UPDATE topic_tags SET slug = ?, names = ?, aliases = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ? AND deleted_at IS NULL
  `).bind(next.slug, JSON.stringify(next.names), JSON.stringify(next.aliases), nowIso(), tag.id, expected).run();
  if (!res.meta?.changes) throw new AppError(409, 'revision_conflict', 'Tag was changed by someone else; reload and retry', { current_revision: tag.revision });
  const updated = await getTag(db, tag.id);
  if (!updated) throw new AppError(500, 'internal_error', 'Tag disappeared after update');
  await writeAuditLog(db, { actor, action: 'tag.update', targetType: 'tag', targetId: tag.id, before: tag, after: updated });
  await refreshTagged(db, tag.id, env);
  return updated;
}

export async function deleteTag(d1: D1DatabaseLike | undefined, idOrSlug: string, expectedRevision: unknown, actor: string, env?: RuntimeEnv): Promise<void> {
  const db = requireDb(d1);
  const expected = requireRevision(expectedRevision);
  const tag = await getTag(db, idOrSlug);
  if (!tag) throw new AppError(404, 'not_found', 'Tag not found');
  const res = await db.prepare('UPDATE topic_tags SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL')
    .bind(nowIso(), nowIso(), tag.id, expected).run();
  if (!res.meta?.changes) throw new AppError(409, 'revision_conflict', 'Tag was changed by someone else; reload and retry', { current_revision: tag.revision });
  const { results } = await db.prepare('SELECT article_id FROM article_tags WHERE tag_id = ?').bind(tag.id).all<Row>();
  await db.prepare('DELETE FROM article_tags WHERE tag_id = ?').bind(tag.id).run();
  for (const r of results ?? []) {
    await mirrorLegacyTags(db, str(r, 'article_id'));
    await reindexArticle(db, str(r, 'article_id'), env);
  }
  await writeAuditLog(db, { actor, action: 'tag.delete', targetType: 'tag', targetId: tag.id, before: tag });
}

/**
 * Resolves tag references (id, slug, alias or localized name). Unknown names create a tag when
 * `createMissing` (admin article edits); duplicates collapse silently, count/length/characters are validated.
 */
export async function resolveTagRefs(
  db: D1DatabaseLike, refs: unknown, opts: { createMissing: boolean; locale: Locale; actor: string },
): Promise<string[]> {
  if (!Array.isArray(refs)) bad('tags', 'must be an array');
  const tags = await allTags(db);
  const byKey = new Map<string, TopicTag>();
  for (const t of tags) {
    byKey.set(t.id, t);
    for (const k of tagKeys(t)) if (!byKey.has(k)) byKey.set(k, t);
  }
  const ids: string[] = [];
  for (let i = 0; i < refs.length; i++) {
    const raw = safeText(`tags[${i}]`, refs[i], TAG_LIMITS.nameLength) ?? '';
    let tag = byKey.get(raw) ?? byKey.get(normalizeKey(raw));
    if (!tag) {
      if (!opts.createMissing) throw new AppError(400, 'unknown_tag', `Unknown tag "${raw}"`, { tag: raw });
      const slug = slugify(raw);
      if (!slug) bad(`tags[${i}]`, 'must contain letters or digits');
      tag = await createTag(db, { slug, names: { [opts.locale]: raw }, aliases: [] }, opts.actor);
      byKey.set(tag.id, tag);
      for (const k of tagKeys(tag)) byKey.set(k, tag);
    }
    if (!ids.includes(tag.id)) ids.push(tag.id);
  }
  if (ids.length > TAG_LIMITS.perArticle) bad('tags', `must contain at most ${TAG_LIMITS.perArticle} distinct tags`);
  return ids;
}

/** Keeps the legacy `articles.tags` JSON (read by older builds) in sync with topic tags. */
export async function mirrorLegacyTags(db: D1DatabaseLike, articleId: string): Promise<void> {
  const art = await db.prepare('SELECT locale FROM articles WHERE id = ?').bind(articleId).first<Row>();
  if (!art) return;
  const { results } = await db.prepare(`
    SELECT t.slug, t.names FROM article_tags at JOIN topic_tags t ON t.id = at.tag_id
    WHERE at.article_id = ? AND t.deleted_at IS NULL ORDER BY at.position
  `).bind(articleId).all<Row>();
  const locale = str(art, 'locale');
  const names = (results ?? []).map(r => localizedName(parseNames(r.names), isLocale(locale) ? locale : 'vi', str(r, 'slug')));
  await db.prepare('UPDATE articles SET tags = ? WHERE id = ?').bind(JSON.stringify(names), articleId).run();
}

export async function setArticleTags(db: D1DatabaseLike, articleId: string, tagIds: string[]): Promise<void> {
  await db.prepare('DELETE FROM article_tags WHERE article_id = ?').bind(articleId).run();
  const now = nowIso();
  for (let i = 0; i < tagIds.length; i++) {
    await db.prepare('INSERT OR IGNORE INTO article_tags (article_id, tag_id, position, created_at) VALUES (?, ?, ?, ?)')
      .bind(articleId, tagIds[i], i, now).run();
  }
  await mirrorLegacyTags(db, articleId);
}

/** Tags per article in display order (deleted tags excluded). */
export async function tagsForArticles(db: D1DatabaseLike, articleIds: string[]): Promise<Map<string, TopicTag[]>> {
  const out = new Map<string, TopicTag[]>();
  if (articleIds.length === 0) return out;
  const { results } = await db.prepare(`
    SELECT at.article_id, t.* FROM article_tags at JOIN topic_tags t ON t.id = at.tag_id
    WHERE t.deleted_at IS NULL ORDER BY at.position
  `).all<Row>();
  const wanted = new Set(articleIds);
  for (const r of results ?? []) {
    const articleId = str(r, 'article_id');
    if (!wanted.has(articleId)) continue;
    const list = out.get(articleId) ?? [];
    list.push(rowToTag(r));
    out.set(articleId, list);
  }
  return out;
}
