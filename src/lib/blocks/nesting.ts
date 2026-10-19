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
  /** False only for the document's own top-level list. */
  nested: boolean;
}

export const ROOT_CONTEXT: NestContext = { layoutDepth: 0, inToggle: false, inCard: false, nested: false };

/** Types a toggle body may not contain. */
const TOGGLE_EXCLUDED: readonly BlockType[] = ['toggle', 'layout', 'section'];

/** Why `type` may not appear in a list with this context, or null when it may. Layout depth is checked by the layout itself. */
export function nestingError(type: BlockType, ctx: NestContext): string | null {
  if (ctx.inToggle && TOGGLE_EXCLUDED.includes(type)) return `a toggle may not contain a ${type}`;
  if (type === 'section' && ctx.nested) return 'a section may only be used at the top level of a document';
  if (type === 'card' && ctx.inCard) return 'a card may not contain a card';
  return null;
}

/** Whether `type` may be inserted into a list with this context (includes the layout depth limit). */
export function canContain(ctx: NestContext, type: BlockType): boolean {
  if (type === 'layout' && ctx.layoutDepth >= LIMITS.layoutDepth) return false;
  return nestingError(type, ctx) === null;
}

/** Context for the body of a container block of `type` placed in a list with context `ctx`. */
export function childContext(ctx: NestContext, type: 'layout' | 'toggle' | 'section' | 'card'): NestContext {
  switch (type) {
    case 'layout': return { ...ctx, layoutDepth: ctx.layoutDepth + 1, nested: true };
    case 'toggle': return { ...ctx, inToggle: true, nested: true };
    case 'section': return { ...ctx, nested: true };
    case 'card': return { ...ctx, inCard: true, nested: true };
  }
}
