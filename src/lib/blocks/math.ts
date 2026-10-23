/**
 * Math contract shared by the server typesetter (./math-render.ts) and the client renderer: the rendered
 * markup shape and equation numbering. No KaTeX here, so client islands can import it for free.
 */
import type { Block } from './schema';
import { walkBlocks } from './schema';

/**
 * Typeset KaTeX markup (HTML + MathML) per math block id, produced on the server by `renderMathBlocks`.
 * Block ids may be any `[A-Za-z0-9_-]` string, `__proto__` included, so build it with `Object.fromEntries`
 * and read it via `mathMarkup` (own keys only). Blocks that failed to typeset have no entry.
 */
export type MathRenders = Record<string, string>;

/** Outcome of typesetting one formula. */
export type MathResult = { ok: true; html: string } | { ok: false; error: string };

/** Server markup for block `id`, ignoring inherited keys and non-string values. */
export function mathMarkup(renders: MathRenders | undefined, id: string): string | null {
  if (!renders || !Object.hasOwn(renders, id)) return null;
  const html: unknown = renders[id];
  return typeof html === 'string' && html ? html : null;
}

/** True when the document (nested blocks included) has a math block, i.e. loading KaTeX pays off. */
export function hasMath(blocks: Block[]): boolean {
  let found = false;
  walkBlocks(blocks, b => { if (!found && b.type === 'math') found = true; });
  return found;
}

/** Equation numbers of the numbered display formulas, 1-based in document (reading) order. */
export function mathNumbers(blocks: Block[]): Map<string, number> {
  const numbers = new Map<string, number>();
  walkBlocks(blocks, b => {
    if (b.type === 'math' && b.numbered && b.mode !== 'inline') numbers.set(b.id, numbers.size + 1);
  });
  return numbers;
}
