import type { ArticleDocument, Block } from '../blocks/schema';
import { walkBlocks } from '../blocks/schema';
import { inlineToPlain } from '../blocks/inline';

/** Visible text of one block (nested layout/toggle children are visited separately by walkBlocks). */
function blockText(block: Block): string[] {
  const p = (s: string | undefined): string => (s ? inlineToPlain(s) : '');
  switch (block.type) {
    case 'paragraph': case 'heading': case 'callout': return [p(block.text)];
    case 'quote': return [p(block.text), p(block.cite)];
    case 'list': return block.items.map(p);
    case 'checklist': return block.items.map(i => p(i.text));
    case 'code': return [block.code];
    case 'image': return [block.alt, p(block.caption)];
    case 'embed': return [p(block.caption)];
    case 'table': return [...block.headers, ...block.rows.flat()].map(p);
    case 'chart': return [block.title ?? '', ...block.labels, ...block.series.map(s => s.name)];
    case 'diagram': return [p(block.caption)];
    case 'survey': return [block.question, ...block.options.map(o => o.label)];
    case 'math': return [block.tex, p(block.caption)];
    case 'gallery': return [...block.images.flatMap(i => [i.alt, p(i.caption)]), p(block.caption)];
    case 'audio': case 'video': return [block.title ?? '', p(block.caption)];
    case 'file': return [block.name, p(block.caption)];
    case 'bookmark': return [block.title ?? '', block.description ?? '', block.siteName ?? ''];
    case 'toggle': return [p(block.summary)];
    default: return [];
  }
}

/** Plain reading text of a document in reading order (used for search, embeddings and word counts). */
export function documentText(doc: ArticleDocument): string {
  const parts: string[] = [];
  walkBlocks(doc.blocks, block => {
    for (const t of blockText(block)) if (t && t.trim()) parts.push(t.trim());
  });
  return parts.join('\n');
}

const CJK = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af';
const CJK_CHAR_RE = new RegExp(`[${CJK}]`, 'g');
const CJK_TEST_RE = new RegExp(`[${CJK}]`);
const CJK_JOIN_RE = new RegExp(`([${CJK}]) (?=[${CJK}])`, 'g');

export function hasCjk(text: string): boolean {
  return CJK_TEST_RE.test(text);
}

/**
 * Separates CJK ideographs/syllables with spaces so the unicode61 tokenizer indexes each one;
 * a query run then matches as a phrase of consecutive characters (any length, including 2).
 */
export function spaceCjk(text: string): string {
  return text.replace(CJK_CHAR_RE, ch => ` ${ch} `).replace(/[ \t]{2,}/g, ' ').trim();
}

/** Reverses spaceCjk for display (snippets). */
export function unspaceCjk(text: string): string {
  return text.replace(CJK_JOIN_RE, '$1');
}

/** Approximate word count; CJK characters count as one word each. */
export function wordCount(text: string): number {
  const cjk = (text.match(CJK_CHAR_RE) ?? []).length;
  const latin = text.replace(CJK_CHAR_RE, ' ').split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
  return latin + cjk;
}

/** Reading time in minutes (~220 words/min; CJK ~400 chars/min), at least 1. */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 220));
}

/**
 * Builds a safe FTS5 MATCH expression from user input: every term becomes a quoted phrase
 * (operators and column filters in the input are treated as text). The last Latin term gets a
 * prefix wildcard so results appear while typing. Returns null when nothing searchable remains.
 */
export function buildMatchQuery(input: string): string | null {
  const terms = input
    .normalize('NFC')
    .replace(/["*^:()+\-]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => /[\p{L}\p{N}]/u.test(t))
    .slice(0, 8)
    .map(t => t.slice(0, 64));
  if (terms.length === 0) return null;
  return terms
    .map((t, i) => {
      if (hasCjk(t)) return `"${spaceCjk(t)}"`;
      const prefix = i === terms.length - 1 && t.length >= 2 ? '*' : '';
      return `"${t}"${prefix}`;
    })
    .join(' ');
}
