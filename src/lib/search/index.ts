import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { canReadFull } from '../blocks/paywall';
import { AppError } from '../http';
import type { Locale } from '../i18n/locales';
import type { Principal } from '../members/policy';
import { viewerFromPrincipal } from '../members/policy';
import type { SearchTier } from './indexer';
import { jevConfig, jevRelevance, MAX_JEV_CANDIDATES, orderByRelevance } from './jev';
import { embedTexts, parseMatches, parseVectorId, semanticBackend } from './semantic';
import { buildMatchQuery, unspaceCjk } from './text';
import type { VideoHit } from '../videos/types';
import { searchVideos } from '../videos/video-search';

export type { SearchTier } from './indexer';
export { reindexAll, reindexArticle } from './indexer';

export interface KnowledgeHit {
  article_id: string;
  slug: string;
  locale: string;
  title: string;
  excerpt: string;
  /** Matched text from the tier this principal may read; `**` marks matched terms (no HTML). */
  snippet: string;
  tier: SearchTier;
  access: 'free' | 'knowledges';
  /** True when the snippet came from (and the principal may read) the full text. */
  full_text: boolean;
  published_revision: number | null;
  published_at: string | null;
  score: number;
  /** Jev probability that the hit answers the query (null when the Jev layer did not run). */
  relevance: number | null;
  sources: Array<'bm25' | 'semantic'>;
  url: string;
  markdown_url: string;
}

export interface KnowledgeSearchResult {
  query: string;
  locale: Locale | null;
  semantic: boolean;
  /** True when the Jev relevance layer reordered the results. */
  reranked: boolean;
  /** Tiers this principal was allowed to search; everything else was excluded before ranking. */
  tiers: SearchTier[];
  results: KnowledgeHit[];
  /** Zueytube videos whose title, description or transcript match (public; ranked separately from articles). */
  videos: VideoHit[];
}

const MAX_VIDEO_HITS = 5;

/** Video hits never fail the article search: a missing table or bad row yields an empty list. */
async function videoHits(db: D1DatabaseLike, query: string, locale: Locale | null, origin: string): Promise<VideoHit[]> {
  try {
    return await searchVideos(db, query, { limit: MAX_VIDEO_HITS, origin, locale });
  } catch (err) {
    console.error('Video search failed:', err instanceof Error ? err.message : 'unknown');
    return [];
  }
}

/** Which index rows a principal may see: decided by the single read_full policy. */
export function allowedTiers(principal: Principal): SearchTier[] {
  return canReadFull(viewerFromPrincipal(principal)) ? ['free', 'full'] : ['free', 'preview'];
}

type Row = Record<string, unknown>;
const s = (row: Row, key: string): string => (typeof row[key] === 'string' ? String(row[key]) : '');
const n = (row: Row, key: string): number => (typeof row[key] === 'number' ? Number(row[key]) : Number(row[key]) || 0);

interface Candidate { articleId: string; locale: string; tier: SearchTier; snippet: string; bm25Rank?: number; semanticRank?: number }

const RRF_K = 60;
const SNIPPET_CHARS = 220;

function tierOf(v: string): SearchTier | null {
  return v === 'free' || v === 'preview' || v === 'full' ? v : null;
}

function key(c: { articleId: string; locale: string }): string {
  return `${c.articleId}|${c.locale}`;
}

async function bm25Candidates(db: D1DatabaseLike, match: string, tiers: SearchTier[], locale: Locale | null, limit: number): Promise<Candidate[]> {
  const where = [`knowledge_fts MATCH ?`, `tier IN (${tiers.map(() => '?').join(', ')})`];
  const binds: unknown[] = [match, ...tiers];
  if (locale) { where.push('locale = ?'); binds.push(locale); }
  // The tier filter is part of the same query as MATCH: disallowed rows never enter bm25 ranking or snippet().
  const { results } = await db.prepare(`
    SELECT article_id, locale, tier, snippet(knowledge_fts, -1, '**', '**', '…', 18) AS snip,
      bm25(knowledge_fts, 0.0, 0.0, 0.0, 8.0, 4.0, 1.0) AS score
    FROM knowledge_fts WHERE ${where.join(' AND ')}
    ORDER BY score LIMIT ${limit}
  `).bind(...binds).all<Row>();
  const out: Candidate[] = [];
  (results ?? []).forEach((r, i) => {
    const tier = tierOf(s(r, 'tier'));
    if (tier && tiers.includes(tier)) out.push({ articleId: s(r, 'article_id'), locale: s(r, 'locale'), tier, snippet: unspaceCjk(s(r, 'snip')), bm25Rank: i + 1 });
  });
  return out;
}

async function semanticCandidates(
  db: D1DatabaseLike, env: RuntimeEnv, query: string, tiers: SearchTier[], locale: Locale | null, limit: number,
): Promise<Candidate[] | null> {
  const backend = semanticBackend(env);
  if (!backend) return null;
  const [vector] = await embedTexts(backend.ai, [query]);
  const filter: Record<string, unknown> = { tier: { $in: tiers } };
  if (locale) filter.locale = locale;
  const matches = parseMatches(await backend.index.query(vector, { topK: Math.min(limit, 50), filter, returnMetadata: false }));
  const out: Candidate[] = [];
  for (const m of matches) {
    const parsed = parseVectorId(m.id);
    const tier = parsed ? tierOf(parsed.tier) : null;
    // Defence in depth: never trust the index filter alone.
    if (!parsed || !tier || !tiers.includes(tier) || (locale && parsed.locale !== locale)) continue;
    const row = await db.prepare('SELECT body FROM knowledge_fts WHERE article_id = ? AND locale = ? AND tier = ?')
      .bind(parsed.articleId, parsed.locale, tier).first<Row>();
    if (!row) continue;
    const body = unspaceCjk(s(row, 'body'));
    out.push({
      articleId: parsed.articleId, locale: parsed.locale, tier,
      snippet: body.length > SNIPPET_CHARS ? `${body.slice(0, SNIPPET_CHARS)}…` : body,
      semanticRank: out.length + 1,
    });
  }
  return out;
}

/**
 * Hybrid knowledge search shared by REST, MCP, the /articles discovery page and Zuey AI.
 * Authorization happens first: the principal's allowed tiers filter the FTS query and the vector
 * query, so paid full text is never ranked or quoted for principals without read_full.
 */
export async function searchKnowledge(
  principal: Principal,
  query: string,
  locale: Locale | null,
  limit: number,
  env: RuntimeEnv,
): Promise<KnowledgeSearchResult> {
  const db = env.DB;
  if (!db) throw new AppError(503, 'db_unavailable', 'Database binding is not configured');
  const tiers = allowedTiers(principal);
  const q = query.trim().slice(0, 200);
  const max = Math.min(Math.max(Math.floor(limit) || 10, 1), 50);
  const empty: KnowledgeSearchResult = { query: q, locale, semantic: false, reranked: false, tiers, results: [], videos: [] };
  const match = buildMatchQuery(q);
  if (!match) return empty;
  const origin = (env.PUBLIC_SITE_URL || 'https://zuey.me').replace(/\/$/, '');
  const videos = await videoHits(db, q, locale, origin);

  const bm25 = await bm25Candidates(db, match, tiers, locale, max * 2);
  let semantic = false;
  let vectors: Candidate[] = [];
  try {
    const res = await semanticCandidates(db, env, q, tiers, locale, max * 2);
    if (res) { vectors = res; semantic = true; }
  } catch (err) {
    console.error('Semantic search failed; using BM25 only:', err instanceof Error ? err.message : 'unknown');
  }

  // Reciprocal rank fusion of both lists, keyed by article edition.
  const merged = new Map<string, Candidate & { score: number; sources: Set<'bm25' | 'semantic'> }>();
  for (const c of bm25) merged.set(key(c), { ...c, score: 1 / (RRF_K + (c.bm25Rank ?? 0)), sources: new Set(['bm25']) });
  for (const c of vectors) {
    const existing = merged.get(key(c));
    const add = 1 / (RRF_K + (c.semanticRank ?? 0));
    if (existing) { existing.score += add; existing.sources.add('semantic'); } else merged.set(key(c), { ...c, score: add, sources: new Set(['semantic']) });
  }
  // With Jev configured, a wider fused pool is fetched so the relevance layer can promote lower-ranked hits.
  const jev = jevConfig(env);
  const poolSize = jev ? Math.min(MAX_JEV_CANDIDATES, Math.max(max * 2, 10)) : max;
  const ranked = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, poolSize);
  if (ranked.length === 0) return { ...empty, semantic, videos };

  const results: KnowledgeHit[] = [];
  for (const c of ranked) {
    const row = await db.prepare(`
      SELECT a.slug, a.access, e.title, e.excerpt, e.published_revision, e.published_at
      FROM articles a JOIN article_editions e ON e.article_id = a.id
      WHERE a.id = ? AND e.locale = ? AND a.deleted_at IS NULL AND e.deleted_at IS NULL AND e.published_json IS NOT NULL
    `).bind(c.articleId, c.locale).first<Row>();
    if (!row) continue;
    const access = row.access === 'knowledges' ? 'knowledges' : 'free';
    const slug = s(row, 'slug');
    const lang = `?lang=${encodeURIComponent(c.locale)}`;
    results.push({
      article_id: c.articleId, slug, locale: c.locale, title: s(row, 'title'), excerpt: s(row, 'excerpt'),
      snippet: c.snippet, tier: c.tier, access, full_text: c.tier !== 'preview',
      published_revision: row.published_revision === null ? null : n(row, 'published_revision'),
      published_at: typeof row.published_at === 'string' ? row.published_at : null,
      score: Number(c.score.toFixed(6)), relevance: null, sources: [...c.sources],
      url: `${origin}/articles/${slug}${lang}`, markdown_url: `${origin}/articles/${slug}.md${lang}`,
    });
  }
  if (!jev || results.length < 2) return { query: q, locale, semantic, reranked: false, tiers, results: results.slice(0, max), videos };
  // Only text this principal may read (public title/excerpt + the tier-filtered snippet) reaches Jev.
  const scores = await jevRelevance(jev, q, results.map(h => ({ id: key({ articleId: h.article_id, locale: h.locale }), text: `${h.title}\n${h.excerpt}\n${h.snippet}` })));
  if (!scores) return { query: q, locale, semantic, reranked: false, tiers, results: results.slice(0, max), videos };
  const scored = results.map(h => ({ ...h, relevance: scores.get(key({ articleId: h.article_id, locale: h.locale })) ?? null }));
  const reordered = orderByRelevance(scored, h => key({ articleId: h.article_id, locale: h.locale }), scores);
  return { query: q, locale, semantic, reranked: true, tiers, results: reordered.slice(0, max), videos };
}
