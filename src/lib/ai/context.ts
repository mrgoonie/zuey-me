/**
 * Grounding for Zuey AI (v1): lexical BM25 over published articles, filtered and cut by the
 * same paywall decision every reader surface uses. The model only ever sees text the caller
 * may read; paid articles the caller cannot read in full contribute their public preview only.
 *
 * `retrieveContext` is the swap point for a later FTS5/vector index (src/lib/search/*).
 */
import type { D1DatabaseLike } from '../../db/store';
import type { Locale } from '../i18n/locales';
import { inlineToPlain } from '../blocks/inline';
import { applyPaywall, canReadFull } from '../blocks/paywall';
import type { ArticleAccess, ArticleDocument, Block } from '../blocks/schema';
import { walkBlocks } from '../blocks/schema';
import { validateDocument } from '../blocks/validate';
import type { Principal } from '../members/policy';
import { viewerFromPrincipal } from '../members/policy';

export interface ContextSource {
  id: string;
  slug: string;
  title: string;
  url: string;
  /** Article access level: 'paid' marks Knowledges articles (quote sparingly). */
  access: 'free' | 'paid';
  /** 'full' when the caller may read the whole article, 'preview' when only the public part was used. */
  scope: 'full' | 'preview';
  locale: string;
  published_at: string | null;
  excerpt: string;
  /** Passage handed to the model (never more than the caller may read). */
  text: string;
}

/** The citation metadata a client receives (no passage text). */
export type SourceRef = Pick<ContextSource, 'id' | 'slug' | 'title' | 'url' | 'access' | 'scope'>;

export interface RetrievalDeps {
  d1: D1DatabaseLike;
  /** Absolute site origin used for source URLs, e.g. https://zuey.me */
  siteUrl: string;
  limit?: number;
}

export type ContextRetriever = (principal: Principal, query: string, locale: Locale, deps: RetrievalDeps) => Promise<ContextSource[]>;

export const MAX_SOURCES = 4;
const MAX_CANDIDATES = 300;
const FULL_PASSAGE_CHARS = 1_400;
const PREVIEW_PASSAGE_CHARS = 700;
const K1 = 1.2;
const B = 0.75;

type Row = Record<string, unknown>;

function s(row: Row, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v : '';
}

/** Lowercase, strip diacritics (Vietnamese đ included) and split into word tokens. */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length > 1 || /\p{N}/u.test(t) || /[぀-ヿ㐀-鿿가-힯]/u.test(t));
}

function blockText(block: Block): string {
  const t = (v: string | undefined) => (v ? inlineToPlain(v) : '');
  switch (block.type) {
    case 'paragraph': case 'heading': case 'callout': return t(block.text);
    case 'quote': return [t(block.text), t(block.cite)].join(' ');
    case 'list': return block.items.map(t).join('\n');
    case 'checklist': return block.items.map(i => t(i.text)).join('\n');
    case 'code': return block.code;
    case 'image': return [block.alt, t(block.caption)].join(' ');
    case 'embed': return t(block.caption);
    case 'table': return [block.headers, ...block.rows].map(r => r.map(t).join(' | ')).join('\n');
    case 'chart': return [block.title ?? '', block.labels.join(', ')].join(' ');
    case 'diagram': return t(block.caption);
    case 'survey': return [block.question, ...block.options.map(o => o.label)].join(' ');
    case 'interactive': return [block.title, t(block.caption)].join(' ');
    case 'divider': case 'layout': return '';
  }
}

/** Visible plain text of a document in reading order (layout children included). */
export function documentText(doc: ArticleDocument): string {
  const parts: string[] = [];
  walkBlocks(doc.blocks, b => {
    const text = blockText(b).trim();
    if (text) parts.push(text);
  });
  return parts.join('\n');
}

interface Candidate {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  tags: string[];
  locale: string;
  access: ArticleAccess;
  published_at: string | null;
  /** Paywalled text for this caller. */
  body: string;
  full: boolean;
  tokens: { title: string[]; tags: string[]; excerpt: string[]; body: string[] };
}

function parseTags(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function parseDoc(raw: string): ArticleDocument | null {
  try {
    const res = validateDocument(JSON.parse(raw));
    return res.ok ? res.doc : null;
  } catch {
    return null;
  }
}

function count(tokens: string[], term: string): number {
  let n = 0;
  for (const t of tokens) if (t === term) n += 1;
  return n;
}

/** Window of `size` characters with the most query-term hits (falls back to the start). */
export function bestPassage(text: string, terms: string[], size: number): string {
  if (text.length <= size) return text;
  const folded = text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
  // NFD folding can change length; only use positions when it did not.
  if (folded.length !== text.length || terms.length === 0) return text.slice(0, size).trimEnd() + '…';
  let bestStart = 0;
  let bestHits = 0;
  const step = Math.max(100, Math.floor(size / 4));
  for (let start = 0; start < text.length; start += step) {
    const window = folded.slice(start, start + size);
    const hits = terms.reduce((n, term) => n + (window.includes(term) ? 1 : 0), 0);
    if (hits > bestHits) { bestHits = hits; bestStart = start; }
  }
  const slice = text.slice(bestStart, bestStart + size).trim();
  return `${bestStart > 0 ? '…' : ''}${slice}${bestStart + size < text.length ? '…' : ''}`;
}

/**
 * Default retriever: BM25 over title (×3), tags (×2), excerpt (×1.5) and the caller-visible body.
 * Scores only ever use text the caller may read, so ranking cannot leak withheld paid content.
 */
export async function retrieveContext(principal: Principal, query: string, locale: Locale, deps: RetrievalDeps): Promise<ContextSource[]> {
  const terms = Array.from(new Set(tokenize(query))).slice(0, 16);
  if (terms.length === 0) return [];
  const viewer = viewerFromPrincipal(principal);
  const full = canReadFull(viewer);
  const { results } = await deps.d1.prepare(
    `SELECT id, slug, locale, title, excerpt, tags, access, published_json, published_at FROM articles
     WHERE deleted_at IS NULL AND published_json IS NOT NULL ORDER BY published_at DESC LIMIT ${MAX_CANDIDATES}`
  ).all<Row>();

  const candidates: Candidate[] = [];
  for (const row of results ?? []) {
    const doc = parseDoc(s(row, 'published_json'));
    if (!doc) continue;
    const access: ArticleAccess = row.access === 'knowledges' ? 'knowledges' : 'free';
    // The shared paywall decision: identical to the HTML page, .md, REST and MCP reads.
    const visible = applyPaywall(doc, access, viewer);
    const body = documentText(visible.doc);
    const tags = parseTags(s(row, 'tags'));
    candidates.push({
      id: s(row, 'id'), slug: s(row, 'slug'), title: s(row, 'title'), excerpt: s(row, 'excerpt'), tags,
      locale: s(row, 'locale') || 'vi', access, published_at: typeof row.published_at === 'string' ? row.published_at : null,
      body, full: access === 'free' || full,
      tokens: { title: tokenize(s(row, 'title')), tags: tokenize(tags.join(' ')), excerpt: tokenize(s(row, 'excerpt')), body: tokenize(body) },
    });
  }
  if (candidates.length === 0) return [];

  const avgLen = candidates.reduce((n, c) => n + c.tokens.body.length + c.tokens.excerpt.length, 0) / candidates.length || 1;
  const docFreq = new Map<string, number>();
  for (const term of terms) {
    docFreq.set(term, candidates.filter(c => Object.values(c.tokens).some(list => list.includes(term))).length);
  }
  const scored = candidates.map(c => {
    const len = c.tokens.body.length + c.tokens.excerpt.length;
    let score = 0;
    for (const term of terms) {
      const tf = 3 * count(c.tokens.title, term) + 2 * count(c.tokens.tags, term) + 1.5 * count(c.tokens.excerpt, term) + count(c.tokens.body, term);
      if (tf === 0) continue;
      const df = docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (candidates.length - df + 0.5) / (df + 0.5));
      score += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * len) / avgLen));
    }
    if (score > 0 && c.locale === locale) score *= 1.2;
    return { c, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, deps.limit ?? MAX_SOURCES);

  const site = deps.siteUrl.replace(/\/+$/, '');
  return scored.map(({ c }) => ({
    id: c.id,
    slug: c.slug,
    title: c.title,
    url: `${site}/articles/${encodeURIComponent(c.slug)}`,
    access: c.access === 'knowledges' ? 'paid' : 'free',
    scope: c.full ? 'full' : 'preview',
    locale: c.locale,
    published_at: c.published_at,
    excerpt: c.excerpt,
    text: bestPassage(c.body, terms, c.full ? FULL_PASSAGE_CHARS : PREVIEW_PASSAGE_CHARS),
  }));
}

export function toSourceRef(src: ContextSource): SourceRef {
  return { id: src.id, slug: src.slug, title: src.title, url: src.url, access: src.access, scope: src.scope };
}

/** XML-escapes attribute values. */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] ?? c));
}

/** Escapes element text so untrusted article text can never open or close envelope tags. */
export function escapeText(value: string): string {
  return value.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] ?? c));
}

/** Output conventions for interactive blocks (parsed by ./artifacts.ts). */
export const INTERACTIVE_FORMAT_NOTE =
  'Only if the user asks for an interactive demo, widget or visualization: reply with one fenced block ```zuey-interactive ' +
  'containing JSON {"title","html","css","js","height"} (plain HTML/CSS/JS, no external scripts, max ~20 KB). It runs in a sandboxed iframe ' +
  'without network access; for data use `await zuey.fetch(url)` (HTTPS GET to approved hosts, returns {status, text(), json()}).';

/**
 * Builds the gateway message: `<zuey_context><source …>…</source></zuey_context><question>…</question>`.
 * Article text is untrusted data; every value is escaped so it stays inside its `<source>`.
 */
export function buildContextMessage(sources: ContextSource[], question: string): string {
  const body = sources.map(src => {
    const attrs = [
      `id="${escapeXml(src.id)}"`,
      `title="${escapeXml(src.title)}"`,
      `url="${escapeXml(src.url)}"`,
      `access="${src.access}"`,
      `scope="${src.scope}"`,
      src.published_at ? `published="${escapeXml(src.published_at.slice(0, 10))}"` : '',
    ].filter(Boolean).join(' ');
    const excerpt = src.excerpt ? `${escapeText(src.excerpt)}\n` : '';
    return `<source ${attrs}>\n${excerpt}${escapeText(src.text)}\n</source>`;
  }).join('\n');
  return `<zuey_context>\n${body}\n</zuey_context>\n<zuey_format>${escapeText(INTERACTIVE_FORMAT_NOTE)}</zuey_format>\n<question>${escapeText(question)}</question>`;
}
