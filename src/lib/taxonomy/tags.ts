import type { D1DatabaseLike, D1PreparedStatementLike, SqlCondition } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { Locale } from '../i18n/locales';
import { LOCALES } from '../i18n/locales';
import { reindexArticle } from '../search/indexer';
import type { LocalizedNames, Row } from './common';
import {
  auditLogStatement, bad, localizedName, newId, normalizeKey, nowIso, num, parseNames, parseNamesInput, parseSlug, parseStringArray,
  requireDb, requireRevision, safeText, slugify, softDeletedAt, str, writeAuditLog,
} from './common';

export const TAG_LIMITS = { perArticle: 20, slugLength: 60, nameLength: 40, aliases: 10 } as const;

/** Field docs shared by the REST tag body and the MCP tag tools, so both describe the same contract. */
export const TAG_SLUG_DOC = `Lowercase kebab-case of at most ${TAG_LIMITS.slugLength} characters, unique across tags; derived from the first name when omitted on create. Creating with a deleted tag's slug restores that tag (same id, new names and aliases); renaming onto it is a conflict`;
export const TAG_NAMES_DOC = `Localized names keyed by locale (${LOCALES.join(', ')}), at least one, each up to ${TAG_LIMITS.nameLength} characters, e.g. {"vi": "Trí tuệ nhân tạo", "en": "AI"}; replaces the whole object`;
export const TAG_ALIASES_DOC = `Alternative names, at most ${TAG_LIMITS.aliases} strings of up to ${TAG_LIMITS.nameLength} characters; duplicates collapse; replaces the whole list`;

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
  if (body.slug !== undefined) out.slug = parseSlug('slug', body.slug, TAG_LIMITS.slugLength);
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

/** Id of the tag other than `selfId` whose row holds `slug`; soft-deleted rows count, since they keep their slug. */
async function slugOwner(db: D1DatabaseLike, slug: string, selfId: string | null): Promise<string | null> {
  const row = await db.prepare('SELECT id FROM topic_tags WHERE slug = ? AND id <> ?').bind(slug, selfId ?? '').first<Row>();
  return row ? str(row, 'id') : null;
}

function slugConflict(slug: string, ownerId: string | null): AppError {
  return new AppError(409, 'tag_conflict', `Slug "${slug}" is already used by another tag`, ownerId ? { tag_id: ownerId } : {});
}

/** The unique index on `topic_tags.slug` covers soft-deleted rows too; only that index maps to `tag_conflict`. */
function isSlugViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed: topic_tags\.slug\b/i.test(err.message);
}

/** Reindexes every article carrying the tag so search and public metadata follow renames immediately. */
async function reindexTagged(db: D1DatabaseLike, tagId: string, env?: RuntimeEnv): Promise<void> {
  const { results } = await db.prepare('SELECT article_id FROM article_tags WHERE tag_id = ?').bind(tagId).all<Row>();
  for (const r of results ?? []) await reindexArticle(db, str(r, 'article_id'), env);
}

/**
 * Inserts the tag row, or restores a soft-deleted one (its slug stays reserved and its id stable).
 * Returns false when a concurrent writer already owns the slug, instead of failing on the unique index.
 */
async function writeTagRow(db: D1DatabaseLike, candidate: Pick<TopicTag, 'slug' | 'aliases' | 'names'>): Promise<boolean> {
  const now = nowIso();
  const names = JSON.stringify(candidate.names);
  const aliases = JSON.stringify(candidate.aliases);
  const existing = await db.prepare('SELECT id, deleted_at FROM topic_tags WHERE slug = ?').bind(candidate.slug).first<Row>();
  if (existing) {
    if (existing.deleted_at == null) return false;
    const res = await db.prepare('UPDATE topic_tags SET names = ?, aliases = ?, deleted_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL')
      .bind(names, aliases, now, str(existing, 'id')).run();
    return Boolean(res.meta?.changes);
  }
  const res = await db.prepare('INSERT INTO topic_tags (id, slug, names, aliases, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(slug) DO NOTHING')
    .bind(newId('tag_'), candidate.slug, names, aliases, now, now).run();
  return Boolean(res.meta?.changes);
}

/** Explicitly creates a tag; a slug, alias or name that is already taken (even by a concurrent create) is `409 tag_conflict`. */
export async function createTag(d1: D1DatabaseLike | undefined, input: TagInput, actor: string): Promise<TopicTag> {
  const db = requireDb(d1);
  if (!input.slug || !input.names) throw new AppError(400, 'invalid_field', 'names are required');
  const candidate = { slug: input.slug, names: input.names, aliases: input.aliases ?? [] };
  await assertNoCollision(db, candidate, null);
  if (!await writeTagRow(db, candidate)) throw slugConflict(candidate.slug, await slugOwner(db, candidate.slug, null));
  const tag = await getTag(db, input.slug);
  if (!tag) throw new AppError(500, 'internal_error', 'Tag was not persisted');
  await writeAuditLog(db, { actor, action: 'tag.create', targetType: 'tag', targetId: tag.id, after: tag });
  return tag;
}

/**
 * Creates the tag, or returns the one a concurrent write just created for the same name. A tag is reused only
 * when it owns the slug and already resolves every requested name; a different tag that merely shares the slug
 * (`slugify` maps "C++" and "C#" both to "c") or an alias stays a `409 tag_conflict`.
 */
async function ensureTag(db: D1DatabaseLike, input: Required<TagInput>, actor: string): Promise<TopicTag> {
  try {
    return await createTag(db, input, actor);
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'tag_conflict') throw err;
    const existing = await getTag(db, input.slug);
    if (existing?.slug !== input.slug) throw err;
    const keys = new Set(tagKeys(existing));
    if (!Object.values(input.names).every(name => typeof name === 'string' && keys.has(normalizeKey(name)))) throw err;
    return existing;
  }
}

export async function updateTag(
  d1: D1DatabaseLike | undefined, idOrSlug: string, input: TagInput, expectedRevision: unknown, actor: string, env?: RuntimeEnv,
): Promise<TopicTag> {
  const db = requireDb(d1);
  const expected = requireRevision(expectedRevision);
  const tag = await getTag(db, idOrSlug);
  if (!tag) throw new AppError(404, 'not_found', 'Tag not found');
  const next = { slug: input.slug ?? tag.slug, names: input.names ?? tag.names, aliases: input.aliases ?? tag.aliases };
  if (next.slug !== tag.slug) {
    // A soft-deleted tag keeps its slug reserved, so a rename onto it conflicts like a rename onto a live tag.
    const owner = await slugOwner(db, next.slug, tag.id);
    if (owner) throw slugConflict(next.slug, owner);
  }
  await assertNoCollision(db, next, tag.id);
  const now = nowIso();
  // The row this rename stores when it applies; the guard above holds only if `tag` was read at `expected`.
  const written: TopicTag = { ...tag, ...next, revision: expected + 1, updated_at: now };
  // One batch (one transaction): the rename, the legacy tag names of its articles and the audit row commit together,
  // so a crash cannot leave the old name in `articles.tags` or a rename without its audit row. When the rename does
  // not apply, the rebuild leaves the column as it was and the audit row is not written.
  const batch = db.batch([
    db.prepare(`
      UPDATE topic_tags SET slug = ?, names = ?, aliases = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND deleted_at IS NULL
    `).bind(next.slug, JSON.stringify(next.names), JSON.stringify(next.aliases), now, tag.id, expected),
    legacyTagsStatement(db, 'id IN (SELECT article_id FROM article_tags WHERE tag_id = ?)', tag.id),
    auditLogStatement(db, { actor, action: 'tag.update', targetType: 'tag', targetId: tag.id, before: tag, after: written }, renamedAt(tag.id, expected, now)),
  ]);
  // A concurrent write can take the slug after the checks above; that is a conflict, not a raw 500.
  const [res] = await batch.catch(async (err: unknown) => { throw isSlugViolation(err) ? slugConflict(next.slug, await slugOwner(db, next.slug, tag.id)) : err; });
  if (!res?.meta?.changes) throw new AppError(409, 'revision_conflict', 'Tag was changed by someone else; reload and retry', { current_revision: tag.revision });
  const updated = await getTag(db, tag.id);
  if (!updated) throw new AppError(500, 'internal_error', 'Tag disappeared after update');
  await reindexTagged(db, tag.id, env);
  return updated;
}

/** Holds once an update guarded by `expected` has moved the live tag to `expected + 1` at `updatedAt`. */
function renamedAt(id: string, expected: number, updatedAt: string): SqlCondition {
  return { sql: 'EXISTS (SELECT 1 FROM topic_tags WHERE id = ? AND revision = ? AND updated_at = ? AND deleted_at IS NULL)', params: [id, expected + 1, updatedAt] };
}

export async function deleteTag(d1: D1DatabaseLike | undefined, idOrSlug: string, expectedRevision: unknown, actor: string, env?: RuntimeEnv): Promise<void> {
  const db = requireDb(d1);
  const expected = requireRevision(expectedRevision);
  const tag = await getTag(db, idOrSlug);
  if (!tag) throw new AppError(404, 'not_found', 'Tag not found');
  const now = nowIso();
  // One batch (one transaction): the tag is deleted, dropped from its articles' legacy tag names, unassigned and
  // audited together; the unassign and the audit row apply only when this batch's own delete did. The legacy names
  // are rewritten while the assignments still identify the articles, after the mark has hidden the tag.
  const deleted = softDeletedAt('topic_tags', tag.id, expected, now);
  const [mark, assigned] = await db.batch([
    db.prepare('UPDATE topic_tags SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL')
      .bind(now, now, tag.id, expected),
    db.prepare('SELECT article_id FROM article_tags WHERE tag_id = ?').bind(tag.id),
    legacyTagsStatement(db, 'id IN (SELECT article_id FROM article_tags WHERE tag_id = ?)', tag.id),
    db.prepare(`DELETE FROM article_tags WHERE tag_id = ? AND ${deleted.sql}`).bind(tag.id, ...deleted.params),
    auditLogStatement(db, { actor, action: 'tag.delete', targetType: 'tag', targetId: tag.id, before: tag }, deleted),
  ]);
  if (!mark?.meta?.changes) throw new AppError(409, 'revision_conflict', 'Tag was changed by someone else; reload and retry', { current_revision: tag.revision });
  for (const r of assigned?.results ?? []) await reindexArticle(db, str(r, 'article_id'), env);
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
      tag = await ensureTag(db, { slug, names: { [opts.locale]: raw }, aliases: [] }, opts.actor);
      byKey.set(tag.id, tag);
      for (const k of tagKeys(tag)) byKey.set(k, tag);
    }
    if (!ids.includes(tag.id)) ids.push(tag.id);
  }
  if (ids.length > TAG_LIMITS.perArticle) bad('tags', `must contain at most ${TAG_LIMITS.perArticle} distinct tags`);
  return ids;
}

/** Every code point `String.prototype.trim` strips (ECMAScript WhiteSpace and LineTerminator), as SQL `char(...)` arguments. */
const JS_TRIM_CODE_POINTS = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
].join(', ');

/**
 * The value of `t.names` under `key` when it is a non-blank string, else NULL; the same check `parseNames` applies.
 * Like `JSON.parse`, the last occurrence of a duplicated key wins (`json_each` ids follow document order), and blank
 * means empty after stripping the characters JS `trim` strips.
 */
const tagNameAt = (key: string) => `(SELECT CASE WHEN j.type = 'text' AND trim(j.value, char(${JS_TRIM_CODE_POINTS})) <> '' THEN j.value END
  FROM json_each(t.names) j WHERE j.key = ${key} ORDER BY j.id DESC LIMIT 1)`;

/** SQL twin of `localizedName(parseNames(...))` for an article's live tags: its locale (unknown means vi), en, vi, any locale, the slug. */
const LEGACY_TAG_NAME_SQL = `COALESCE(CASE WHEN json_valid(t.names) AND json_type(t.names) = 'object' THEN COALESCE(${[
  `CASE WHEN articles.locale IN (${LOCALES.map(l => `'${l}'`).join(', ')}) THEN articles.locale ELSE 'vi' END`,
  "'en'", "'vi'", ...LOCALES.map(l => `'${l}'`),
].map(tagNameAt).join(', ')}) END, t.slug)`;

/**
 * Rewrites the legacy `articles.tags` JSON (read by older builds) from each matched article's live tags, in display
 * order. It is one statement, so callers put it in the same batch as the tag change it follows; recomputing is
 * idempotent, so running it when that change did not apply leaves the column as it was.
 */
function legacyTagsStatement(db: D1DatabaseLike, where: string, ...params: unknown[]): D1PreparedStatementLike {
  return db.prepare(`
    UPDATE articles SET tags = (
      SELECT json_group_array(name) FROM (
        SELECT ${LEGACY_TAG_NAME_SQL} AS name FROM article_tags at JOIN topic_tags t ON t.id = at.tag_id
        WHERE at.article_id = articles.id AND t.deleted_at IS NULL ORDER BY at.position
      )
    ) WHERE ${where}
  `).bind(...params);
}

/** Rebuilds one article's legacy `articles.tags` JSON; article writes put it in the batch that writes its tag rows. */
export function articleLegacyTagsStatement(db: D1DatabaseLike, articleId: string): D1PreparedStatementLike {
  return legacyTagsStatement(db, 'id = ?', articleId);
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
