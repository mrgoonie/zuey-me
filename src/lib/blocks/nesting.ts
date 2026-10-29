import { LIMITS } from './schema';
import type { BlockType } from './schema';

/**
 * Where a block list sits in the document. Shared by the validator and the Studio block menu so both
 * apply the same containment rules.
 */
export interface NestContext {
  /** Number of layouts around this list. */
  layoutDepth: number;
  /** Inside a toggle body. */
  inToggle: boolean;
  /** Inside a card body (at any depth). */
  inCard: boolean;
  /** Inside a tabs, steps or comparison item (at any depth). */
  inWidget: boolean;
  /** False only for the document's own top-level list. */
  nested: boolean;
}

export const ROOT_CONTEXT: NestContext = { layoutDepth: 0, inToggle: false, inCard: false, inWidget: false, nested: false };

/** Types a toggle body may not contain. */
const TOGGLE_EXCLUDED: readonly BlockType[] = ['toggle', 'layout', 'section', 'tabs'];

/** Widgets with nested items; one may not sit inside another's item. */
const ITEM_WIDGETS: readonly BlockType[] = ['tabs', 'steps', 'comparison'];

/** Why `type` may not appear in a list with this context, or null when it may. Layout depth is checked by the layout itself. */
export function nestingError(type: BlockType, ctx: NestContext): string | null {
  if (ctx.inToggle && TOGGLE_EXCLUDED.includes(type)) return `a toggle may not contain a ${type}`;
  if (type === 'section' && ctx.nested) return 'a section may only be used at the top level of a document';
  if (type === 'card' && ctx.inCard) return 'a card may not contain a card';
  if (ctx.inWidget && ITEM_WIDGETS.includes(type)) return `a tabs, steps or comparison item may not contain a ${type}`;
  return null;
}

/** Whether `type` may be inserted into a list with this context (includes the layout depth limit). */
export function canContain(ctx: NestContext, type: BlockType): boolean {
  if (type === 'layout' && ctx.layoutDepth >= LIMITS.layoutDepth) return false;
  return nestingError(type, ctx) === null;
}

/** Block types whose bodies are nested lists; widget is any tabs, steps or comparison item. */
export type ContainerKind = 'layout' | 'toggle' | 'section' | 'card' | 'widget';

/** Context for the body of a container block of `type` placed in a list with context `ctx`. */
export function childContext(ctx: NestContext, type: ContainerKind): NestContext {
  switch (type) {
    case 'layout': return { ...ctx, layoutDepth: ctx.layoutDepth + 1, nested: true };
    case 'toggle': return { ...ctx, inToggle: true, nested: true };
    case 'section': return { ...ctx, nested: true };
    case 'card': return { ...ctx, inCard: true, nested: true };
    case 'widget': return { ...ctx, inWidget: true, nested: true };
  }
}
