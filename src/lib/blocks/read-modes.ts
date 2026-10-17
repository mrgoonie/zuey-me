import { AppError } from '../http';
import type { ArticleView } from './articles';
import type { ArticleDocument, Block } from './schema';
import { childBlockLists, walkBlocks } from './schema';
import { contentHash, sha256Hex } from './stable-json';

export const READ_MODES = ['summary', 'outline', 'translatables', 'section', 'full'] as const;
export type ReadMode = (typeof READ_MODES)[number];

export const DEFAULT_TRANSLATABLE_LIMIT = 200;
export const MAX_TRANSLATABLE_LIMIT = 1_000;
const LABEL_MAX = 80;

export interface ReadQuery {
  mode: ReadMode;
  sectionId?: string;
  cursor?: string;
  limit: number;
}

export type ResponseMode = 'full' | 'summary';

/** `response_mode` of a write: `summary` returns a receipt (block count + hash) instead of echoing the document. */
export function parseResponseMode(raw: unknown): ResponseMode {
  if (raw === undefined || raw === null || raw === 'full') return 'full';
  if (raw === 'summary') return 'summary';
  throw new AppError(400, 'invalid_field', 'response_mode must be "full" or "summary"', { field: 'response_mode' });
}

/** What a `response_mode: summary` write returns in place of the document. */
export async function documentReceipt(doc: ArticleDocument): Promise<{ document_blocks: number; content_hash: string }> {
  return { document_blocks: countBlocks(doc), content_hash: await contentHash(doc) };
}

/** Parses the read-mode arguments shared by the MCP tool and the REST query string. */
export function parseReadQuery(input: { mode?: unknown; section_id?: unknown; cursor?: unknown; limit?: unknown }): ReadQuery {
  const mode = input.mode === undefined || input.mode === null || input.mode === '' ? 'full' : input.mode;
  if (typeof mode !== 'string' || !(READ_MODES as readonly string[]).includes(mode)) {
    throw new AppError(400, 'invalid_field', `mode must be one of ${READ_MODES.join(', ')}`, { field: 'mode' });
  }
  const sectionId = typeof input.section_id === 'string' && input.section_id !== '' ? input.section_id : undefined;
  if (mode === 'section' && !sectionId) throw new AppError(400, 'invalid_field', 'section_id is required for mode "section"', { field: 'section_id' });
  const cursor = typeof input.cursor === 'string' && input.cursor !== '' ? input.cursor : undefined;
  if (cursor !== undefined && !/^\d{1,7}$/.test(cursor)) throw new AppError(400, 'invalid_field', 'cursor is not valid; pass next_cursor from the previous page', { field: 'cursor' });
  const rawLimit = typeof input.limit === 'string' && input.limit !== '' ? Number(input.limit) : input.limit;
  let limit = DEFAULT_TRANSLATABLE_LIMIT;
  if (rawLimit !== undefined && rawLimit !== null) {
    if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_TRANSLATABLE_LIMIT) {
      throw new AppError(400, 'invalid_field', `limit must be an integer 1-${MAX_TRANSLATABLE_LIMIT}`, { field: 'limit' });
    }
    limit = rawLimit;
  }
  return { mode: mode as ReadMode, sectionId, cursor, limit };
}

const clip = (text: string) => (text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text);

/** Short human label of a block for outlines (heading text, card title, alt text, …); never more than 80 characters. */
export function blockLabel(block: Block): string | undefined {
  switch (block.type) {
    case 'heading': case 'paragraph': case 'quote': case 'callout': return clip(block.text);
    case 'card': return block.title ? clip(block.title) : undefined;
    case 'toggle': return clip(block.summary);
    case 'section': return block.anchor ? `#${block.anchor}` : undefined;
    case 'image': return block.alt ? clip(block.alt) : undefined;
    case 'interactive': return clip(block.title);
    case 'survey': return clip(block.question);
    case 'chart': return block.title ? clip(block.title) : undefined;
    case 'file': return clip(block.name);
    case 'bookmark': case 'audio': case 'video': return block.title ? clip(block.title) : undefined;
    case 'diagram': case 'math': case 'embed': case 'gallery': return block.caption ? clip(block.caption) : undefined;
    default: return undefined;
  }
}

export interface OutlineNode { id: string; type: string; label?: string; children?: OutlineNode[] }

function outlineOf(blocks: Block[]): OutlineNode[] {
  return blocks.map(block => {
    const children = childBlockLists(block).flatMap(outlineOf);
    const label = blockLabel(block);
    return { id: block.id, type: block.type, ...(label ? { label } : {}), ...(children.length ? { children } : {}) };
  });
}

export interface Translatable { block_id: string; field_path: string; text: string; source_hash: string }
type RawTranslatable = Omit<Translatable, 'source_hash'>;

/**
 * Visible text of one block as (field_path, text) pairs, relative to the block. Fail-closed: only fields that
 * readers see as prose are listed; URLs, ids, code, TeX, Mermaid and interactive html/css/js are never offered
 * (Mermaid labels are not extracted yet because the diagram source is structural).
 */
function textFields(block: Block): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const add = (path: string, text: string | undefined) => { if (text) out.push({ path, text }); };
  switch (block.type) {
    case 'paragraph': case 'heading': case 'callout': add('text', block.text); break;
    case 'quote': add('text', block.text); add('cite', block.cite); break;
    case 'list': block.items.forEach((t, i) => add(`items[${i}]`, t)); break;
    case 'checklist': block.items.forEach((item, i) => add(`items[${i}].text`, item.text)); break;
    case 'image': add('alt', block.alt); add('caption', block.caption); break;
    case 'embed': case 'math': case 'diagram': add('caption', block.caption); break;
    case 'table':
      block.headers.forEach((t, c) => add(`headers[${c}]`, t));
      block.rows.forEach((row, r) => row.forEach((t, c) => add(`rows[${r}][${c}]`, t)));
      break;
    case 'chart':
      add('title', block.title);
      block.labels.forEach((t, i) => add(`labels[${i}]`, t));
      block.series.forEach((s, i) => add(`series[${i}].name`, s.name));
      break;
    case 'survey': add('question', block.question); block.options.forEach((o, i) => add(`options[${i}].label`, o.label)); break;
    case 'interactive': add('title', block.title); add('caption', block.caption); break;
    case 'gallery':
      add('caption', block.caption);
      block.images.forEach((img, i) => { add(`images[${i}].alt`, img.alt); add(`images[${i}].caption`, img.caption); });
      break;
    case 'audio': case 'video': add('title', block.title); add('caption', block.caption); break;
    case 'file': add('caption', block.caption); break;
    case 'bookmark': add('title', block.title); add('description', block.description); break;
    case 'toggle': add('summary', block.summary); break;
    case 'icon': add('label', block.label); break;
    case 'card': add('title', block.title); add('footer', block.footer); add('image.alt', block.image?.alt); break;
    case 'code': case 'divider': case 'layout': case 'section': break;
  }
  return out;
}

export function collectTranslatables(doc: ArticleDocument): RawTranslatable[] {
  const out: RawTranslatable[] = [];
  walkBlocks(doc.blocks, block => {
    for (const f of textFields(block)) out.push({ block_id: block.id, field_path: f.path, text: f.text });
  });
  return out;
}

export function countBlocks(doc: ArticleDocument): number {
  let n = 0;
  walkBlocks(doc.blocks, () => { n += 1; });
  return n;
}

/** Block with the ids of the blocks that contain it (outermost first); null when no block has that id. */
function locate(blocks: Block[], id: string, trail: string[] = []): { block: Block; path: string[] } | null {
  for (const block of blocks) {
    if (block.id === id) return { block, path: trail };
    for (const list of childBlockLists(block)) {
      const hit = locate(list, id, [...trail, block.id]);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Shapes an already paywalled article view for a read mode. Every mode derives from `view.document`, so a
 * reader never receives more than `full` would show them.
 */
export async function shapeArticleView(view: ArticleView, query: ReadQuery): Promise<Record<string, unknown>> {
  if (query.mode === 'full') return { ...view };
  const { document, ...rest } = view;
  const base = { ...rest, read_mode: query.mode, document_blocks: countBlocks(document), content_hash: await contentHash(document) };
  switch (query.mode) {
    case 'summary': return base;
    case 'outline': return { ...base, outline: outlineOf(document.blocks) };
    case 'section': {
      const hit = locate(document.blocks, query.sectionId ?? '');
      if (!hit) throw new AppError(404, 'section_not_found', `No block with id "${query.sectionId}" in this edition`, { field: 'section_id' });
      return { ...base, section: hit.block, section_path: hit.path };
    }
    case 'translatables': {
      const all = collectTranslatables(document);
      const start = query.cursor ? Number(query.cursor) : 0;
      if (start > all.length) throw new AppError(400, 'invalid_field', 'cursor is past the end of the manifest', { field: 'cursor' });
      const page = all.slice(start, start + query.limit);
      const items: Translatable[] = await Promise.all(page.map(async t => ({ ...t, source_hash: (await sha256Hex(t.text)).slice(0, 12) })));
      const next = start + page.length;
      return { ...base, translatables: items, total: all.length, next_cursor: next < all.length ? String(next) : null };
    }
  }
}
