import { AppError } from '../http';
import type { ArticleView } from './articles';
import { childBlockLists, findBlock, walkBlocks } from './schema';
import type { ArticleDocument, Block } from './schema';
import { sha256Hex, stableStringify } from './schema-view';
import { columnOf, isProseColumn } from './table-data';

/** How much of an article an agent reads; `full` (the default) is the complete document. */
export const READ_MODES = ['summary', 'outline', 'translatables', 'section', 'full'] as const;
export type ReadMode = (typeof READ_MODES)[number];

export const TRANSLATABLES_DEFAULT_LIMIT = 100;
export const TRANSLATABLES_MAX_LIMIT = 500;
const OUTLINE_LABEL_MAX = 80;

export interface ReadOptions {
  mode: ReadMode;
  /** `section` mode: id of the block (and its subtree) to return. */
  blockId?: string;
  /** `translatables` mode paging. */
  cursor?: string;
  limit?: number;
}

export function parseReadMode(raw: unknown): ReadMode {
  if (raw === undefined || raw === '') return 'full';
  if (typeof raw !== 'string' || !(READ_MODES as readonly string[]).includes(raw)) {
    throw new AppError(400, 'invalid_field', `mode must be one of ${READ_MODES.join(', ')}`, { field: 'mode' });
  }
  return raw as ReadMode;
}

/** Validates the mode-specific arguments shared by the REST query string and the MCP arguments. */
export function parseReadOptions(input: { mode?: unknown; block_id?: unknown; cursor?: unknown; limit?: unknown }): ReadOptions {
  const mode = parseReadMode(input.mode);
  const blockId = typeof input.block_id === 'string' && input.block_id ? input.block_id : undefined;
  if (mode === 'section' && !blockId) throw new AppError(400, 'invalid_field', 'block_id is required for mode section', { field: 'block_id' });
  const cursor = typeof input.cursor === 'string' && input.cursor ? input.cursor : undefined;
  let limit: number | undefined;
  if (input.limit !== undefined && input.limit !== null && input.limit !== '') {
    const n = typeof input.limit === 'number' ? input.limit : Number(input.limit);
    if (!Number.isInteger(n) || n < 1 || n > TRANSLATABLES_MAX_LIMIT) {
      throw new AppError(400, 'invalid_field', `limit must be an integer from 1 to ${TRANSLATABLES_MAX_LIMIT}`, { field: 'limit' });
    }
    limit = n;
  }
  return { mode, blockId, cursor, limit };
}

/** Hash of the document the reader receives: equal hashes mean equal content. */
export async function documentHash(doc: ArticleDocument): Promise<string> {
  return (await sha256Hex(stableStringify(doc))).slice(0, 16);
}

export function countBlocks(doc: ArticleDocument): number {
  let n = 0;
  walkBlocks(doc.blocks, () => { n += 1; });
  return n;
}

export interface OutlineEntry { id: string; type: Block['type']; depth: number; label?: string }

function trimLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > OUTLINE_LABEL_MAX ? `${flat.slice(0, OUTLINE_LABEL_MAX - 1)}…` : flat;
}

/** Text that names a block in an outline: heading text, section anchor, card/interactive title, toggle summary. */
function outlineLabel(block: Block): string | undefined {
  switch (block.type) {
    case 'heading': return trimLabel(block.text);
    case 'section': return block.anchor;
    case 'card': return block.title ? trimLabel(block.title) : undefined;
    case 'interactive': return trimLabel(block.title);
    case 'toggle': return trimLabel(block.summary);
    case 'chart': return block.title ? trimLabel(block.title) : undefined;
    case 'survey': return trimLabel(block.question);
    case 'file': return trimLabel(block.name);
    default: return undefined;
  }
}

/** Flat depth-first list of every block id and type with a short label where one exists. */
export function documentOutline(doc: ArticleDocument): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const visit = (blocks: Block[], depth: number) => {
    for (const block of blocks) {
      const label = outlineLabel(block);
      out.push({ id: block.id, type: block.type, depth, ...(label ? { label } : {}) });
      for (const list of childBlockLists(block)) visit(list, depth + 1);
    }
  };
  visit(doc.blocks, 0);
  return out;
}

export interface Translatable { block_id: string; field_path: string; source_text: string; source_hash: string }

/** A visible text field of a block, without its hash. */
type TextField = { path: string; text: string };

const text = (path: string, value: string | undefined): TextField[] => (value ? [{ path, text: value }] : []);

/**
 * Human-visible strings a translator edits, per block. URLs, ids, anchors, code, TeX, Mermaid source
 * and interactive HTML/CSS/JS are never listed: only fields that are prose by construction. Interactive
 * blocks contribute just their title and caption, because their widget strings live inside code that
 * is never rewritten or executed to extract text.
 */
function blockTexts(block: Block): TextField[] {
  switch (block.type) {
    case 'paragraph': return text('text', block.text);
    case 'heading': return text('text', block.text);
    case 'list': return block.items.flatMap((item, i) => text(`items.${i}`, item));
    case 'checklist': return block.items.flatMap((item, i) => text(`items.${i}.text`, item.text));
    case 'quote': return [...text('text', block.text), ...text('cite', block.cite)];
    case 'callout': return text('text', block.text);
    case 'image': return [...text('alt', block.alt), ...text('caption', block.caption)];
    case 'embed': case 'diagram': case 'math': return text('caption', block.caption);
    case 'table': return [
      ...text('title', block.title),
      ...block.headers.flatMap((h, i) => text(`headers.${i}`, h)),
      ...block.rows.flatMap((row, r) => row.flatMap((cell, c) => (isProseColumn(columnOf(block, c)) ? text(`rows.${r}.${c}`, cell) : []))),
      ...text('caption', block.caption),
    ];
    case 'chart': return [
      ...text('title', block.title),
      // ISO date labels are data, not prose.
      ...(block.x?.format === 'date' ? [] : block.labels.flatMap((l, i) => text(`labels.${i}`, l))),
      ...block.series.flatMap((s, i) => text(`series.${i}.name`, s.name)),
      ...(['x', 'y', 'y2'] as const).flatMap(k => [...text(`${k}.title`, block[k]?.title), ...text(`${k}.unit`, block[k]?.unit)]),
      ...(block.references ?? []).flatMap((r, i) => text(`references.${i}.label`, r.label)),
      ...(block.annotations ?? []).flatMap((a, i) => text(`annotations.${i}.text`, a.text)),
      ...text('caption', block.caption),
    ];
    case 'survey': return [...text('question', block.question), ...block.options.flatMap((o, i) => text(`options.${i}.label`, o.label))];
    case 'interactive': return [...text('title', block.title), ...text('caption', block.caption)];
    case 'gallery': return [
      ...block.images.flatMap((img, i) => [...text(`images.${i}.alt`, img.alt), ...text(`images.${i}.caption`, img.caption)]),
      ...text('caption', block.caption),
    ];
    case 'audio': case 'video': return [...text('title', block.title), ...text('caption', block.caption)];
    case 'file': return text('caption', block.caption);
    case 'bookmark': return [...text('title', block.title), ...text('description', block.description)];
    case 'toggle': return text('summary', block.summary);
    case 'icon': return text('label', block.label);
    case 'card': return [...text('title', block.title), ...text('image.alt', block.image?.alt), ...text('footer', block.footer)];
    case 'code': case 'divider': case 'layout': case 'section': return [];
  }
}

/** Every translatable field of the document, in reading order, keyed by stable block id and field path. */
export async function documentTranslatables(doc: ArticleDocument): Promise<Translatable[]> {
  const fields: Array<{ block_id: string; field_path: string; source_text: string }> = [];
  walkBlocks(doc.blocks, block => {
    for (const f of blockTexts(block)) fields.push({ block_id: block.id, field_path: f.path, source_text: f.text });
  });
  const hashes = await Promise.all(fields.map(f => sha256Hex(f.source_text)));
  return fields.map((f, i) => ({ ...f, source_hash: hashes[i].slice(0, 16) }));
}

function decodeCursor(cursor: string | undefined, total: number): number {
  if (cursor === undefined) return 0;
  const n = /^o(\d{1,9})$/.exec(cursor)?.[1];
  const offset = n === undefined ? NaN : Number(n);
  if (!Number.isInteger(offset) || offset > total) throw new AppError(400, 'invalid_field', 'cursor is not valid for this document', { field: 'cursor' });
  return offset;
}

/**
 * Projects an already authorised, already paywalled article view into the requested read mode. Because
 * it only ever narrows `view.document`, no mode can reveal text the full read would withhold.
 */
export async function projectView(view: ArticleView, options: ReadOptions): Promise<Record<string, unknown>> {
  if (options.mode === 'full') return view as unknown as Record<string, unknown>;
  const { document, ...summary } = view;
  const base = { ...summary, mode: options.mode, document_blocks: countBlocks(document), content_hash: await documentHash(document) };
  switch (options.mode) {
    case 'summary': return base;
    case 'outline': return { ...base, outline: documentOutline(document) };
    case 'section': {
      const block = findBlock(document.blocks, options.blockId ?? '');
      if (!block) throw new AppError(404, 'block_not_found', `No block ${options.blockId} in the ${view.preview ? 'draft' : 'published'} edition`, { field: 'block_id' });
      return { ...base, block };
    }
    case 'translatables': {
      const all = await documentTranslatables(document);
      const start = decodeCursor(options.cursor, all.length);
      const limit = options.limit ?? TRANSLATABLES_DEFAULT_LIMIT;
      const page = all.slice(start, start + limit);
      const end = start + page.length;
      return { ...base, translatables: page, translatables_total: all.length, next_cursor: end < all.length ? `o${end}` : null };
    }
  }
}

/** `response_mode: "summary"` makes a write answer with a receipt only, never the saved document. */
export function parseResponseMode(raw: unknown): 'full' | 'summary' {
  if (raw === undefined || raw === 'full') return 'full';
  if (raw === 'summary') return 'summary';
  throw new AppError(400, 'invalid_field', 'response_mode must be "full" or "summary"', { field: 'response_mode' });
}

/** What a summary-mode write returns in place of the document: its size and content hash. */
export async function documentReceipt(doc: ArticleDocument): Promise<{ document_blocks: number; content_hash: string }> {
  return { document_blocks: countBlocks(doc), content_hash: await documentHash(doc) };
}
