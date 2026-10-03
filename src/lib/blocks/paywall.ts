import type { ArticleAccess, ArticleDocument, Block } from './schema';
import { inlineToPlain } from './inline';

export interface Viewer {
  isAdmin: boolean;
  /** Membership entitlements effective for article reads (e.g. 'read_full'), already narrowed by API-key scopes. */
  entitlements: string[];
  /** True when the response depends on the caller's credentials (must not be stored by shared caches). */
  personalized?: boolean;
}

/** Entitlement granted by the Knowledges, Kết hợp and Cộng đồng plans. AI-only does not include it. */
export const READ_FULL_ENTITLEMENT = 'read_full';

export interface PaywallResult { doc: ArticleDocument; truncated: boolean }

/** Whether the viewer may read paid ('knowledges' access) articles in full. */
export function canReadFull(viewer: Viewer): boolean {
  return viewer.isAdmin || viewer.entitlements.includes(READ_FULL_ENTITLEMENT);
}

/** Cache-Control for a reader response: anything credential-dependent is private. */
export function readerCacheControl(viewer: Viewer): string {
  return viewer.isAdmin || viewer.personalized ? 'private, no-store' : 'public, max-age=300';
}

/** Approximate reading weight of a block (characters of visible text, at least 1). */
export function blockWeight(block: Block): number {
  const len = (s: string | undefined): number => (s ? inlineToPlain(s).length : 0);
  let w: number;
  switch (block.type) {
    case 'paragraph': case 'heading': case 'callout': w = len(block.text); break;
    case 'quote': w = len(block.text) + len(block.cite); break;
    case 'list': w = block.items.reduce((n, s) => n + len(s), 0); break;
    case 'checklist': w = block.items.reduce((n, s) => n + len(s.text), 0); break;
    case 'code': w = block.code.length; break;
    case 'divider': w = 1; break;
    case 'image': w = 40 + len(block.alt) + len(block.caption); break;
    case 'embed': w = 40 + len(block.caption); break;
    case 'table': w = [block.headers, ...block.rows].flat().reduce((n, s) => n + len(s), 0); break;
    case 'chart': w = 40 + block.labels.join('').length + block.series.length * block.labels.length * 3; break;
    case 'diagram': w = block.source.length + len(block.caption); break;
    case 'survey': w = len(block.question) + block.options.reduce((n, o) => n + o.label.length, 0); break;
    case 'layout': w = block.children.reduce((n, c) => n + c.blocks.reduce((m, b) => m + blockWeight(b), 0), 0); break;
    case 'interactive': w = 40 + len(block.title) + len(block.caption); break;
    case 'math': w = block.tex.length + len(block.caption); break;
    case 'gallery': w = block.images.reduce((n, img) => n + 40 + len(img.alt) + len(img.caption), 0) + len(block.caption); break;
    case 'audio': case 'video': w = 40 + len(block.title) + len(block.caption); break;
    case 'file': w = 20 + len(block.name) + len(block.caption); break;
    case 'bookmark': w = 20 + len(block.title) + len(block.description); break;
    case 'toggle': w = len(block.summary) + block.blocks.reduce((n, b) => n + blockWeight(b), 0); break;
  }
  return Math.max(1, w);
}

/**
 * Keeps roughly the first third (by text weight) of top-level blocks for paid articles
 * when the viewer is not entitled. Always keeps at least one block and, when the article
 * has more than one block, always withholds at least one.
 */
export function applyPaywall(doc: ArticleDocument, access: ArticleAccess, viewer: Viewer): PaywallResult {
  if (access !== 'knowledges' || canReadFull(viewer)) return { doc, truncated: false };
  const blocks = doc.blocks;
  const total = blocks.reduce((n, b) => n + blockWeight(b), 0);
  let keep = 0;
  let acc = 0;
  while (keep < blocks.length && (keep === 0 || acc < total / 3)) {
    acc += blockWeight(blocks[keep]);
    keep += 1;
  }
  if (blocks.length > 1) keep = Math.min(keep, blocks.length - 1);
  return { doc: { version: 1, blocks: blocks.slice(0, keep) }, truncated: keep < blocks.length };
}
