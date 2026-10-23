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
/** Macro expansions per formula (KaTeX's own default), which stops `\def` loops. */
export const MATH_MAX_EXPAND = 1000;
/** TeX characters typeset per document; formulas beyond it fall back to their source. */
export const MAX_DOCUMENT_MATH_CHARS = 100_000;
/** Largest markup kept for one formula (deep nesting multiplies spans); bigger output falls back to the source. */
export const MAX_MATH_HTML_CHARS = 200_000;

/**
 * Typesets one formula. Author TeX is untrusted: `trust: false` turns `\href`, `\url`, `\includegraphics`
 * and `\html*` into plain text, sizes and macro expansion are capped, and every failure (parse errors,
 * runaway nesting) becomes an error result instead of an exception.
 */
export function renderTex(tex: string, mode: MathMode = 'display'): MathResult {
  try {
    const html = katex.renderToString(tex, {
      displayMode: mode === 'display',
      output: 'htmlAndMathml',
      throwOnError: true,
      trust: false,
      strict: 'ignore',
      maxSize: MATH_MAX_SIZE_EM,
      maxExpand: MATH_MAX_EXPAND,
      // A fresh object per call: `\gdef` writes into it, and definitions must never leak between formulas or requests.
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
 * per-document budget. Failed formulas get no entry, so readers see their TeX source.
 */
export function renderMathBlocks(blocks: Block[]): MathRenders {
  const entries: Array<[string, string]> = [];
  let budget = MAX_DOCUMENT_MATH_CHARS;
  walkBlocks(blocks, block => {
    if (block.type !== 'math' || block.tex.length > budget) return;
    budget -= block.tex.length;
    const result = renderTex(block.tex, block.mode);
    if (result.ok) entries.push([block.id, result.html]);
  });
  return Object.fromEntries(entries);
}
