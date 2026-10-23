/**
 * KaTeX typesetting. Loaded with a dynamic import, only by pages whose document has math (server) and by
 * Studio previews (client), so neither the edge worker's other routes nor reader islands carry KaTeX.
 */
import katex from 'katex';
import type { Block, MathMode } from './schema';
import { walkBlocks } from './schema';
import type { MathRenders, MathResult } from './math';

/** Largest user size (`\rule`, `\kern`, …) in em, so a formula cannot paint over the page. */
export const MATH_MAX_SIZE_EM = 20;
/** Macro expansions per formula (KaTeX's own default), which stops runaway built-in expansion. */
export const MATH_MAX_EXPAND = 1000;
/** Deepest group nesting (braces, `\left`…`\right`, environments) typeset; deeper TeX is costly and never legitimate. */
export const MATH_MAX_DEPTH = 40;
/** Longest TeX typeset as one formula; KaTeX's cost per character grows with length, so longer TeX shows as source. */
export const MATH_MAX_TEX_CHARS = 3_000;
/** Largest markup kept for one formula (deep nesting multiplies spans); bigger output falls back to the source. */
export const MAX_MATH_HTML_CHARS = 200_000;
/**
 * Typesetting budget per document, in cost units (see `mathCost`). Workers clocks do not advance during
 * synchronous work, so the budget is a deterministic estimate rather than a timer: with macros refused and
 * nesting capped, KaTeX's cost is close to linear in the TeX length plus a fixed per-formula overhead, and
 * this budget keeps the slowest document measured to a few tens of milliseconds of CPU.
 */
export const MAX_DOCUMENT_MATH_COST = 16_000;
/** Fixed cost of one formula in characters' worth of TeX (parser and DOM-tree setup). */
export const MATH_FORMULA_BASE_COST = 120;
/** Markup typeset per document (it ships twice: in the HTML and in the island props). */
export const MAX_DOCUMENT_MATH_HTML_CHARS = 1_500_000;

/**
 * User macro definitions are refused: a short `\def` chain expands into far more work than its length
 * suggests (hundreds of milliseconds for a hundred characters), which no per-character budget can bound.
 */
const MACRO_DEFINITION = /\\(?:[gex]?def|let|futurelet|global|newcommand|renewcommand|providecommand|DeclareMathOperator|newenvironment)(?![A-Za-z])/;
const NESTING_COMMAND = /\\(left|right|begin|end)(?![A-Za-z])/y;

/** Deepest nesting of `{…}`, `\left…\right` and `\begin…\end` in the TeX (escaped braces ignored). */
export function texDepth(tex: string): number {
  let depth = 0;
  let max = 0;
  for (let i = 0; i < tex.length; i++) {
    const c = tex[i];
    if (c === '\\') {
      NESTING_COMMAND.lastIndex = i;
      const m = NESTING_COMMAND.exec(tex);
      if (m) {
        depth += m[1] === 'left' || m[1] === 'begin' ? 1 : -1;
        i += m[0].length - 1;
      } else {
        i++; // Skip the escaped character (`\{`, `\}`, `\\`) or the command's first letter.
      }
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
    }
    if (depth > max) max = depth;
  }
  return max;
}

/** Budget units one formula consumes. */
export function mathCost(tex: string): number {
  return MATH_FORMULA_BASE_COST + tex.length;
}

/**
 * Typesets one formula. Author TeX is untrusted: `trust: false` turns `\href`, `\url`, `\includegraphics`
 * and `\html*` into plain text, sizes, nesting and macro expansion are capped, macro definitions are refused,
 * and every failure (parse errors, runaway nesting) becomes an error result instead of an exception.
 */
export function renderTex(tex: string, mode: MathMode = 'display'): MathResult {
  if (tex.length > MATH_MAX_TEX_CHARS) return { ok: false, error: `Formula is longer than ${MATH_MAX_TEX_CHARS} characters` };
  if (MACRO_DEFINITION.test(tex)) return { ok: false, error: 'Macro definitions (\\def, \\newcommand, \\let, …) are not supported' };
  if (texDepth(tex) > MATH_MAX_DEPTH) return { ok: false, error: `Formula is nested more than ${MATH_MAX_DEPTH} levels deep` };
  try {
    const html = katex.renderToString(tex, {
      displayMode: mode === 'display',
      output: 'htmlAndMathml',
      throwOnError: true,
      trust: false,
      strict: 'ignore',
      maxSize: MATH_MAX_SIZE_EM,
      maxExpand: MATH_MAX_EXPAND,
      // A fresh object per call, so nothing defined while typesetting can leak between formulas or requests.
      macros: {},
    });
    if (html.length > MAX_MATH_HTML_CHARS) return { ok: false, error: 'Formula is too complex to typeset' };
    return { ok: true, html };
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.message ? error.message : 'Invalid TeX' };
  }
}

/**
 * Typesets every math block of a document (layouts, toggles, sections and cards included) within the
 * per-document cost and markup budgets. Formulas beyond either budget, and failed ones, get no entry, so
 * readers see their TeX source without the server spending any more time on them.
 */
export function renderMathBlocks(blocks: Block[]): MathRenders {
  const entries: Array<[string, string]> = [];
  let cost = 0;
  let markup = 0;
  walkBlocks(blocks, block => {
    if (block.type !== 'math' || markup >= MAX_DOCUMENT_MATH_HTML_CHARS) return;
    const blockCost = mathCost(block.tex);
    if (cost + blockCost > MAX_DOCUMENT_MATH_COST) return;
    cost += blockCost;
    const result = renderTex(block.tex, block.mode);
    if (!result.ok) return;
    markup += result.html.length;
    if (markup <= MAX_DOCUMENT_MATH_HTML_CHARS) entries.push([block.id, result.html]);
  });
  return Object.fromEntries(entries);
}
