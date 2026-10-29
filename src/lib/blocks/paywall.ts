import type { ArticleAccess, ArticleDocument, Block, CardBlock, ItemWidgetBlock, LayoutBlock, LayoutChild, SectionBlock, ToggleBlock } from './schema';
import { widgetItems } from './schema';
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

/** A withheld heading: plain text and level only, never the body under it. */
export interface LockedHeading { level: 1 | 2 | 3; text: string }

/**
 * What a non-entitled reader may know about the withheld part: its headings and its size.
 * No other withheld text is ever exposed.
 */
export interface LockedOutline {
  headings: LockedHeading[];
  /** Number of withheld units (a block inside a section, card, toggle or layout cell counts on its own). */
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

/** Outline of withheld blocks: heading text + level and the withheld size, nothing else. */
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

/** One container a unit sits in: a section, card or toggle body, one cell of a layout, or one tabs, steps or comparison item. */
type UnitFrame =
  | { kind: 'body'; block: SectionBlock | CardBlock | ToggleBlock }
  | { kind: 'cell'; block: LayoutBlock; cell: LayoutChild }
  | { kind: 'item'; block: ItemWidgetBlock; index: number };

/**
 * A unit the paywall keeps or withholds: a leaf block, with the containers it sits in. A shell unit stands for a
 * widget item with an empty body: keeping it keeps the item (its label, pros, …) and adds no block.
 */
interface PaywallUnit { block: Block; path: UnitFrame[]; shell?: true }

/** Visible text of one widget item outside its blocks (what a shell unit keeps). */
function itemTextWeight(block: ItemWidgetBlock, index: number): number {
  switch (block.type) {
    case 'tabs': return block.tabs[index].label.length;
    case 'steps': return inlineToPlain(block.items[index].title).length + (block.items[index].date?.length ?? 0);
    case 'comparison': {
      const o = block.options[index];
      return o.name.length + [o.description ?? '', ...(o.pros ?? []), ...(o.cons ?? [])].reduce((n, s) => n + inlineToPlain(s).length, 0);
    }
  }
}

function unitWeight(u: PaywallUnit): number {
  const frame = u.path[u.path.length - 1];
  return u.shell && frame?.kind === 'item' ? Math.max(1, itemTextWeight(frame.block, frame.index)) : blockWeight(u.block);
}

/**
 * Splits a block into paywall units. Sections, cards and toggles are split down to their body blocks
 * and layouts cell by cell, at any depth and at the top level alike, so no container that holds the
 * whole article (or most of it) can bypass the paywall. A container with nothing to split (an empty
 * body, or a layout whose cells are all empty) is one unit on its own, so it never disappears. Tabs, steps and
 * comparison widgets split item by item; an item without blocks is a shell unit, so its label still counts.
 */
function blockUnits(block: Block, path: UnitFrame[]): PaywallUnit[] {
  let units: PaywallUnit[] = [];
  if (block.type === 'section' || block.type === 'card' || block.type === 'toggle') {
    const inner: UnitFrame[] = [...path, { kind: 'body', block }];
    units = block.blocks.flatMap(child => blockUnits(child, inner));
  } else if (block.type === 'layout') {
    units = block.children.flatMap(cell => cell.blocks.flatMap(child => blockUnits(child, [...path, { kind: 'cell', block, cell }])));
  } else if (block.type === 'tabs' || block.type === 'steps' || block.type === 'comparison') {
    units = widgetItems(block).flatMap((item, index) => {
      const inner: UnitFrame[] = [...path, { kind: 'item', block, index }];
      const own = item.blocks.flatMap(child => blockUnits(child, inner));
      return own.length > 0 ? own : [{ block, path: inner, shell: true as const }];
    });
  }
  return units.length > 0 ? units : [{ block, path }];
}

function paywallUnits(blocks: Block[]): PaywallUnit[] {
  return blocks.flatMap(block => blockUnits(block, []));
}

/** Number of units inside each card body (at any depth), used to tell a whole card from a partly kept one. */
function cardUnitCounts(units: PaywallUnit[]): Map<CardBlock, number> {
  const counts = new Map<CardBlock, number>();
  for (const { path } of units) {
    for (const frame of path) {
      if (frame.kind === 'body' && frame.block.type === 'card') counts.set(frame.block, (counts.get(frame.block) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Rebuilds top-level blocks from kept units. A partly kept container keeps its settings and only the
 * kept blocks; a card that lost any unit (even deep inside a layout) also drops its footer, which
 * belongs to the withheld end of the card.
 */
function joinUnits(units: PaywallUnit[], totals: Map<CardBlock, number>): Block[] {
  const out: Block[] = [];
  const bodies = new Map<SectionBlock | CardBlock | ToggleBlock | LayoutChild, Block[]>();
  const layouts = new Map<LayoutBlock, LayoutBlock>();
  const cards: Array<[CardBlock, CardBlock]> = [];
  const widgets = new Map<ItemWidgetBlock, { copy: ItemWidgetBlock; kept: number[] }>();
  const itemBodies = new Map<{ blocks: Block[] }, Block[]>();
  for (const { block, path, shell } of units) {
    let list = out;
    for (const frame of path) {
      if (frame.kind === 'item') {
        let widget = widgets.get(frame.block);
        if (!widget) {
          widget = { copy: { ...frame.block }, kept: [] };
          list.push(widget.copy);
          widgets.set(frame.block, widget);
        }
        const item = widgetItems(frame.block)[frame.index];
        let body = itemBodies.get(item);
        if (!body) {
          body = [];
          itemBodies.set(item, body);
          widget.kept.push(frame.index);
        }
        list = body;
        continue;
      }
      if (frame.kind === 'body') {
        let body = bodies.get(frame.block);
        if (!body) {
          const copy: SectionBlock | CardBlock | ToggleBlock = { ...frame.block, blocks: [] };
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
    if (!shell) list.push(block);
  }
  for (const [source, { copy, kept }] of widgets) keepItems(source, copy, kept, itemBodies);
  const kept = cardUnitCounts(units);
  for (const [source, copy] of cards) {
    if ((kept.get(source) ?? 0) < (totals.get(source) ?? 0)) delete copy.footer;
  }
  return out;
}

function pick<T extends { blocks: Block[] }>(items: T[], kept: number[], bodies: Map<{ blocks: Block[] }, Block[]>): T[] {
  return kept.map(i => ({ ...items[i], blocks: bodies.get(items[i]) ?? [] }));
}

/**
 * Fills a partly kept widget with its kept items (in order). A comparison keeps the matrix columns of its kept
 * options only; tabs keep their default tab when it was kept.
 */
function keepItems(source: ItemWidgetBlock, copy: ItemWidgetBlock, kept: number[], bodies: Map<{ blocks: Block[] }, Block[]>): void {
  if (source.type === 'tabs' && copy.type === 'tabs') {
    copy.tabs = pick(source.tabs, kept, bodies);
    const first = kept.indexOf(source.defaultTab ?? 0);
    if (first > 0) copy.defaultTab = first;
    else delete copy.defaultTab;
  } else if (source.type === 'steps' && copy.type === 'steps') {
    copy.items = pick(source.items, kept, bodies);
  } else if (source.type === 'comparison' && copy.type === 'comparison') {
    copy.options = pick(source.options, kept, bodies);
    if (source.features) copy.features = source.features.map(f => ({ ...f, values: kept.map(i => f.values[i]) }));
  }
}

/**
 * Keeps roughly the first third (by text weight) of the article's units (blocks inside sections, cards,
 * toggles, layout cells and widget items count one by one) for paid articles when the viewer is not entitled. Always keeps at least one unit
 * and, when the article has more than one, always withholds at least one.
 */
export function applyPaywall(doc: ArticleDocument, access: ArticleAccess, viewer: Viewer): PaywallResult {
  if (access !== 'knowledges' || canReadFull(viewer)) return { doc, truncated: false };
  const units = paywallUnits(doc.blocks);
  const total = units.reduce((n, u) => n + unitWeight(u), 0);
  let keep = 0;
  let acc = 0;
  while (keep < units.length && (keep === 0 || acc < total / 3)) {
    acc += unitWeight(units[keep]);
    keep += 1;
  }
  if (units.length > 1) keep = Math.min(keep, units.length - 1);
  const kept: ArticleDocument = { version: 1, blocks: joinUnits(units.slice(0, keep), cardUnitCounts(units)) };
  if (keep >= units.length) return { doc: kept, truncated: false };
  const outline = lockedOutline(units.slice(keep).map(u => u.block));
  // Text around withheld units (a withheld toggle summary, card title or footer) is withheld too.
  outline.words = Math.max(0, wordCount(documentText(doc)) - wordCount(documentText(kept)));
  return { doc: kept, truncated: true, outline };
}
