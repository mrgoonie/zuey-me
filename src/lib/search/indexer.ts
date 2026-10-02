import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { applyPaywall } from '../blocks/paywall';
import type { Viewer } from '../blocks/paywall';
import { validateDocument } from '../blocks/validate';
import { LOCALES } from '../i18n/locales';
import { documentText, spaceCjk } from './text';
import { embedTexts, semanticBackend, vectorId } from './semantic';

export const SEARCH_TIERS = ['free', 'preview', 'full'] as const;
export type SearchTier = (typeof SEARCH_TIERS)[number];

/** A reader without read_full: used to cut the public preview, through the one shared paywall function. */
const PUBLIC_VIEWER: Viewer = { isAdmin: false, entitlements: [] };

type Row = Record<string, unknown>;
const s = (row: Row, key: string): string => (typeof row[key] === 'string' ? String(row[key]) : '');

interface IndexEntry { locale: string; tier: SearchTier; title: string; tags: string; body: string }

function parseDoc(text: string) {
  try {
    const res = validateDocument(JSON.parse(text));
    return res.ok ? res.doc : null;
  } catch {
    return null;
  }
}

/** Public metadata text indexed with every row: tag names/aliases and the category name in all locales. */
async function metadataText(db: D1DatabaseLike, articleId: string, categoryId: string | null): Promise<string> {
  const { results } = await db.prepare(`
    SELECT t.names, t.aliases, t.slug FROM article_tags at JOIN topic_tags t ON t.id = at.tag_id
    WHERE at.article_id = ? AND t.deleted_at IS NULL
  `).bind(articleId).all<Row>();
  const parts: string[] = [];
  for (const r of results ?? []) {
    parts.push(s(r, 'slug'));
    for (const text of [s(r, 'names'), s(r, 'aliases')]) {
      try {
        const v: unknown = JSON.parse(text);
        if (Array.isArray(v)) parts.push(...v.filter((x): x is string => typeof x === 'string'));
        else if (typeof v === 'object' && v !== null) parts.push(...Object.values(v).filter((x): x is string => typeof x === 'string'));
      } catch { /* malformed metadata is skipped */ }
    }
  }
  if (categoryId) {
    const cat = await db.prepare('SELECT names FROM knowledge_categories WHERE id = ? AND deleted_at IS NULL').bind(categoryId).first<Row>();
    if (cat) {
      try {
        const v: unknown = JSON.parse(s(cat, 'names'));
        if (typeof v === 'object' && v !== null) parts.push(...Object.values(v).filter((x): x is string => typeof x === 'string'));
      } catch { /* skipped */ }
    }
  }
  return Array.from(new Set(parts)).join(' ');
}

/** Builds the index rows for one article: free → full text; paid → separate preview and full rows. */
async function buildEntries(db: D1DatabaseLike, articleId: string): Promise<IndexEntry[]> {
  const article = await db.prepare('SELECT id, access, category_id, deleted_at FROM articles WHERE id = ?').bind(articleId).first<Row>();
  if (!article || article.deleted_at) return [];
  const { results } = await db.prepare(`
    SELECT locale, title, excerpt, published_json FROM article_editions
    WHERE article_id = ? AND deleted_at IS NULL AND published_json IS NOT NULL
  `).bind(articleId).all<Row>();
  const tags = await metadataText(db, articleId, typeof article.category_id === 'string' ? article.category_id : null);
  const paid = article.access === 'knowledges';
  const entries: IndexEntry[] = [];
  for (const ed of results ?? []) {
    const doc = parseDoc(s(ed, 'published_json'));
    if (!doc) continue;
    const base = { locale: s(ed, 'locale'), title: spaceCjk(s(ed, 'title')), tags: spaceCjk(tags) };
    const excerpt = s(ed, 'excerpt');
    const full = spaceCjk([excerpt, documentText(doc)].filter(Boolean).join('\n'));
    if (!paid) {
      entries.push({ ...base, tier: 'free', body: full });
      continue;
    }
    const preview = applyPaywall(doc, 'knowledges', PUBLIC_VIEWER).doc;
    entries.push({ ...base, tier: 'preview', body: spaceCjk([excerpt, documentText(preview)].filter(Boolean).join('\n')) });
    entries.push({ ...base, tier: 'full', body: full });
  }
  return entries;
}

export interface ReindexResult { article_id: string; rows: number; semantic: boolean; semantic_error?: string }

/**
 * Rebuilds the search rows (and vectors, when Vectorize is bound) for one article.
 * Called after every publish, delete, access/tag/category change; safe to call repeatedly.
 */
export async function reindexArticle(db: D1DatabaseLike, articleId: string, env?: RuntimeEnv): Promise<ReindexResult> {
  const entries = await buildEntries(db, articleId);
  await db.prepare('DELETE FROM knowledge_fts WHERE article_id = ?').bind(articleId).run();
  for (const e of entries) {
    await db.prepare('INSERT INTO knowledge_fts (article_id, locale, tier, title, tags, body) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(articleId, e.locale, e.tier, e.title, e.tags, e.body).run();
  }
  const backend = semanticBackend(env);
  if (!backend) return { article_id: articleId, rows: entries.length, semantic: false };
  try {
    const stale = LOCALES.flatMap(l => SEARCH_TIERS.map(t => vectorId(articleId, l, t)));
    await backend.index.deleteByIds(stale);
    if (entries.length) {
      const vectors = await embedTexts(backend.ai, entries.map(e => `${e.title}\n${e.body}`));
      await backend.index.upsert(entries.map((e, i) => ({
        id: vectorId(articleId, e.locale, e.tier),
        values: vectors[i],
        metadata: { article_id: articleId, locale: e.locale, tier: e.tier },
      })));
    }
    return { article_id: articleId, rows: entries.length, semantic: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    console.error('Vector reindex failed:', message);
    return { article_id: articleId, rows: entries.length, semantic: false, semantic_error: message };
  }
}

/** Admin maintenance: rebuild the whole index (e.g. after enabling Vectorize or restoring a backup). */
export async function reindexAll(db: D1DatabaseLike, env?: RuntimeEnv): Promise<{ articles: number; rows: number; semantic: boolean }> {
  const { results } = await db.prepare('SELECT id FROM articles').all<Row>();
  let rows = 0;
  let semantic = semanticBackend(env) !== null;
  const ids = (results ?? []).map(r => s(r, 'id'));
  for (const id of ids) {
    const res = await reindexArticle(db, id, env);
    rows += res.rows;
    if (!res.semantic) semantic = false;
  }
  return { articles: ids.length, rows, semantic };
}
