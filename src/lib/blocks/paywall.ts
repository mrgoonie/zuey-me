import type { ArticleAccess, ArticleDocument, Block, CardBlock, LayoutBlock, LayoutChild, SectionBlock } from './schema';
import { inlineToPlain } from './inline';
import { blockDefinition } from './registry';
import { documentText, wordCount } from '../search/text';

export interface Viewer {
  isAdmin: boolean;
  /** Membership entitlements effective for article reads (e.g. 'read_full'), already narrowed by API-key scopes. */
  entitlements: string[];
  /** True when the response depends on the caller's credentials (must not be stored by shared caches). */
  personalized?: boolean;
}

/** Entitlement granted by the Knowledges, Kết hợp and Cộng đồng plans. AI-only does not include it. */
export const READ_FULL_ENTITLEMENT = 'read_full';

/** A withheld top-level heading: plain text and level only, never the body under it. */
export interface LockedHeading { level: 1 | 2 | 3; text: string }

/**
 * What a non-entitled reader may know about the withheld part: its top-level headings and its size.
 * No other withheld text is ever exposed.
 */
export interface LockedOutline {
  headings: LockedHeading[];
  /** Number of withheld top-level blocks (a block inside a top-level section counts on its own). */
  blocks: number;
  /** Approximate number of withheld words. */
  words: number;
}

export interface PaywallResult {
  doc: ArticleDocument;
  truncated: boolean;
  /** Present only when truncated. */
  outline?: LockedOutline;
}

/** Outline of withheld blocks: top-level heading text + level and the withheld size, nothing else. */
export function lockedOutline(withheld: Block[]): LockedOutline {
  const headings: LockedHeading[] = [];
  for (const b of withheld) {
    if (b.type !== 'heading') continue;
    const text = inlineToPlain(b.text).trim();
    if (text) headings.push({ level: b.level, text });
  }
  return { headings, blocks: withheld.length, words: wordCount(documentText({ version: 1, blocks: withheld })) };
}

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
  return Math.max(1, blockDefinition(block.type).weight(block, nestedWeight));
}

function nestedWeight(blocks: Block[]): number {
  return blocks.reduce((n, b) => n + blockWeight(b), 0);
}

/** One container a unit sits in: a section or card body, or one cell of a layout. */
type UnitFrame = { kind: 'body'; block: SectionBlock | CardBlock } | { kind: 'cell'; block: LayoutBlock; cell: LayoutChild };

/** A unit the paywall keeps or withholds: a top-level block, or a leaf block inside a top-level section. */
interface PaywallUnit { block: Block; path: UnitFrame[] }

/**
 * Inside a top-level section, cards and layouts are split down to their blocks as well, so a section
 * (or a landing-style section of cards) that holds the whole article cannot bypass the paywall.
 * Top-level blocks outside sections stay whole, exactly as before sections existed.
 */
function sectionUnits(block: Block, path: UnitFrame[]): PaywallUnit[] {
  if ((block.type === 'section' || block.type === 'card') && block.blocks.length > 0) {
    const inner: UnitFrame[] = [...path, { kind: 'body', block }];
    return block.blocks.flatMap(child => sectionUnits(child, inner));
  }
  if (block.type === 'layout') {
    return block.children.flatMap(cell => cell.blocks.flatMap(child => sectionUnits(child, [...path, { kind: 'cell', block, cell }])));
  }
  return [{ block, path }];
}

function paywallUnits(blocks: Block[]): PaywallUnit[] {
  return blocks.flatMap(block => (block.type === 'section' ? sectionUnits(block, []) : [{ block, path: [] }]));
}

/**
 * Rebuilds top-level blocks from kept units. A partly kept container keeps its settings and only the
 * kept blocks; a partly kept card also drops its footer, which belongs to the withheld end of the card.
 */
function joinUnits(units: PaywallUnit[]): Block[] {
  const out: Block[] = [];
  const bodies = new Map<SectionBlock | CardBlock | LayoutChild, Block[]>();
  const layouts = new Map<LayoutBlock, LayoutBlock>();
  const cards: Array<[CardBlock, CardBlock]> = [];
  for (const { block, path } of units) {
    let list = out;
    for (const frame of path) {
      if (frame.kind === 'body') {
        let body = bodies.get(frame.block);
        if (!body) {
          const copy: SectionBlock | CardBlock = { ...frame.block, blocks: [] };
          if (copy.type === 'card' && frame.block.type === 'card') cards.push([frame.block, copy]);
          list.push(copy);
          body = copy.blocks;
          bodies.set(frame.block, body);
        }
        list = body;
        continue;
      }
      let layout = layouts.get(frame.block);
      if (!layout) {
        layout = { ...frame.block, children: [] };
        list.push(layout);
        layouts.set(frame.block, layout);
      }
      let body = bodies.get(frame.cell);
      if (!body) {
        const cell: LayoutChild = { ...frame.cell, blocks: [] };
        layout.children.push(cell);
        body = cell.blocks;
        bodies.set(frame.cell, body);
      }
      list = body;
    }
    list.push(block);
  }
  for (const [source, copy] of cards) {
    if (copy.blocks.length < source.blocks.length) delete copy.footer;
  }
  return out;
}

/**
 * Keeps roughly the first third (by text weight) of top-level blocks (blocks inside top-level sections,
 * their cards and layouts count one by one) for paid articles when the viewer is not entitled. Always keeps at least one unit
 * and, when the article has more than one, always withholds at least one.
 */
export function applyPaywall(doc: ArticleDocument, access: ArticleAccess, viewer: Viewer): PaywallResult {
  if (access !== 'knowledges' || canReadFull(viewer)) return { doc, truncated: false };
  const units = paywallUnits(doc.blocks);
  const total = units.reduce((n, u) => n + blockWeight(u.block), 0);
  let keep = 0;
  let acc = 0;
  while (keep < units.length && (keep === 0 || acc < total / 3)) {
    acc += blockWeight(units[keep].block);
    keep += 1;
  }
  if (units.length > 1) keep = Math.min(keep, units.length - 1);
  const kept: ArticleDocument = { version: 1, blocks: joinUnits(units.slice(0, keep)) };
  if (keep >= units.length) return { doc: kept, truncated: false };
  return { doc: kept, truncated: true, outline: lockedOutline(units.slice(keep).map(u => u.block)) };
}
