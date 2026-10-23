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

/**
 * How a display formula is numbered: our `(n)` label (a `numbered` formula), or KaTeX's own numbers
 * (`equation`, `align`, `gather`, …) continuing the document's sequence from `counterStart`.
 */
export type MathNumber = { label: number } | { counterStart: number };

/** TeX that numbers or tags itself: numbered environments (not their starred forms) and `\tag`. */
const SELF_NUMBERING_TEX = /\\tag\*?\s*\{|\\begin\s*\{(?:equation|align|alignat|gather|multline|flalign)\}/;
const KATEX_TAG = 'class="katex-tag"';
const KATEX_EQN_NUM = /class="eqn-num"/g;

/**
 * Equation numbering in document (reading) order. One counter runs through our labels and KaTeX's
 * automatic numbers, so a document never shows the same number twice. A formula that numbers or tags
 * itself never gets our label as well, even when it is marked `numbered`. With server markup the
 * decision and the count come from KaTeX's output; without it, from the TeX.
 */
export function mathNumbers(blocks: Block[], renders?: MathRenders): Map<string, MathNumber> {
  const numbers = new Map<string, MathNumber>();
  let counter = 0;
  walkBlocks(blocks, b => {
    if (b.type !== 'math' || b.mode === 'inline') return;
    const markup = mathMarkup(renders, b.id);
    if (markup ? markup.includes(KATEX_TAG) : SELF_NUMBERING_TEX.test(b.tex)) {
      numbers.set(b.id, { counterStart: counter });
      counter += markup?.match(KATEX_EQN_NUM)?.length ?? 0;
    } else if (b.numbered) {
      counter += 1;
      numbers.set(b.id, { label: counter });
    }
  });
  return numbers;
}
