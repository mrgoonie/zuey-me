/**
 * Syntax highlighting for article code blocks.
 *
 * Shiki's fine-grained core with the JavaScript regex engine (no WASM) and only the grammars listed in
 * `code-syntax.ts`. Output is plain data — `[length, kindIndex]` runs over the block's normalised code — that the
 * renderer turns into text slices inside spans, so author input is never turned into HTML. Colours live in CSS
 * (`.zb-tk-<kind>` in blocks.css); the theme below only maps TextMate scopes to token kinds.
 *
 * Heavy module: import it dynamically (server pages, Studio preview), never statically from a client island.
 */
import { createHighlighterCoreSync } from 'shiki/core';
import type { HighlighterCore, ThemeRegistration } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import typescript from 'shiki/langs/typescript.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import tsx from 'shiki/langs/tsx.mjs';
import jsx from 'shiki/langs/jsx.mjs';
import json from 'shiki/langs/json.mjs';
import shellscript from 'shiki/langs/shellscript.mjs';
import python from 'shiki/langs/python.mjs';
import sql from 'shiki/langs/sql.mjs';
import html from 'shiki/langs/html.mjs';
import css from 'shiki/langs/css.mjs';
import yaml from 'shiki/langs/yaml.mjs';
import markdown from 'shiki/langs/markdown.mjs';
import diff from 'shiki/langs/diff.mjs';
import type { Block } from './schema';
import { walkBlocks } from './schema';
import { TOKEN_KINDS, highlightSource, isValidRuns, normalizeCode, resolveHighlightLanguage, tokenKindIndex } from './code-syntax';
import type { CodeHighlights, HighlightLanguage, TokenKind, TokenRuns } from './code-syntax';

/** Larger blocks stay plain: bounds tokenizer CPU per request on the edge worker. */
export const MAX_HIGHLIGHT_CHARS = 20_000;
/** Total highlighted characters per document; later blocks fall back to plain code. */
export const MAX_DOCUMENT_HIGHLIGHT_CHARS = 100_000;
/** Source characters kept in the per-isolate result cache, so repeat views of an article cost no tokenizer CPU. */
const CACHE_MAX_CHARS = 500_000;

const VAR_PREFIX = '--zb-tk-';
const kindColor = (kind: TokenKind): string => `var(${VAR_PREFIX}${kind})`;

const SCOPES: Array<[TokenKind, string[]]> = [
  ['comment', ['comment', 'punctuation.definition.comment', 'string.comment']],
  ['string', ['string', 'punctuation.definition.string', 'string.template', 'markup.inline.raw', 'markup.fenced_code']],
  ['regexp', ['string.regexp', 'constant.character.escape', 'constant.other.character-class.regexp']],
  ['keyword', [
    'keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.operator.new', 'keyword.operator.expression',
    'keyword.operator.logical.python', 'keyword.other.DML.sql', 'variable.language.this', 'variable.language.self',
    'markup.list',
  ]],
  ['constant', [
    'constant', 'constant.numeric', 'constant.language', 'support.constant', 'variable.other.constant',
    'variable.other.enummember', 'keyword.other.unit', 'constant.other.color',
  ]],
  ['function', ['entity.name.function', 'support.function', 'meta.function-call.generic', 'variable.function']],
  ['type', [
    'entity.name.type', 'entity.name.class', 'entity.name.namespace', 'support.type', 'support.class',
    'entity.other.inherited-class', 'storage.type.primitive', 'entity.name.type.module',
  ]],
  ['tag', ['entity.name.tag', 'punctuation.definition.tag', 'support.class.component', 'entity.name.tag.css']],
  ['attr', [
    'entity.other.attribute-name', 'support.type.property-name', 'meta.object-literal.key',
    'entity.name.tag.yaml', 'support.type.property-name.json', 'variable.other.property',
  ]],
  ['variable', ['variable.parameter', 'variable.other.readwrite.shell', 'variable.other.normal.shell', 'punctuation.definition.variable']],
  ['inserted', ['markup.inserted', 'punctuation.definition.inserted']],
  ['deleted', ['markup.deleted', 'punctuation.definition.deleted']],
  ['heading', ['markup.heading', 'entity.name.section', 'markup.bold']],
  ['link', ['markup.underline.link', 'string.other.link']],
  ['meta', ['meta.diff.range', 'meta.diff.header', 'meta.preprocessor', 'entity.name.function.decorator', 'meta.decorator']],
];

/** Scope-to-kind theme; colours resolve to `var(--zb-tk-<kind>)` sentinels mapped back to kinds below. */
const THEME: ThemeRegistration = {
  name: 'zuey-tokens',
  type: 'dark',
  colors: { 'editor.foreground': `var(${VAR_PREFIX}fg)`, 'editor.background': `var(${VAR_PREFIX}bg)` },
  tokenColors: SCOPES.map(([kind, scope]) => ({ scope, settings: { foreground: kindColor(kind) } })),
};

const COLOR_TO_KIND = new Map<string, TokenKind>(TOKEN_KINDS.map(k => [kindColor(k).toLowerCase(), k]));

const GRAMMARS = [typescript, javascript, tsx, jsx, json, shellscript, python, sql, html, css, yaml, markdown, diff];

let highlighter: HighlighterCore | null = null;

function getHighlighter(): HighlighterCore {
  // Grammars are compiled lazily per language on first use, so creating this is cheap.
  highlighter ??= createHighlighterCoreSync({
    themes: [THEME],
    langs: GRAMMARS,
    // Forgiving: a grammar regex the JS engine cannot translate matches nothing instead of throwing.
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

/**
 * Tokenises `code` for `language` into runs over `normalizeCode(code)`. Returns null — meaning "render plain
 * code" — for an unsupported language, empty or oversized code, a tokenizer failure, or output whose text does
 * not reproduce the source exactly.
 */
export function highlightCode(code: string, language: string | undefined): TokenRuns | null {
  const lang: HighlightLanguage | null = resolveHighlightLanguage(language);
  if (!lang || !code || code.length > MAX_HIGHLIGHT_CHARS) return null;
  const text = normalizeCode(code);
  const key = `${lang}\u0000${text}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const runs = tokenize(text, lang);
  remember(key, runs);
  return runs;
}

const cache = new Map<string, TokenRuns | null>();
let cachedChars = 0;

function remember(key: string, runs: TokenRuns | null): void {
  cache.set(key, runs);
  cachedChars += key.length;
  // Map iteration follows insertion order, so the oldest entries are evicted first.
  for (const oldest of cache.keys()) {
    if (cachedChars <= CACHE_MAX_CHARS) break;
    cache.delete(oldest);
    cachedChars -= oldest.length;
  }
}

/** `text` is already normalised (LF only), so its lines are exactly what the tokenizer sees. */
function tokenize(text: string, lang: HighlightLanguage): TokenRuns | null {
  let tokenLines: Array<Array<{ content: string; color?: string }>>;
  try {
    tokenLines = getHighlighter().codeToTokensBase(text, {
      lang,
      theme: THEME.name,
      // Longer lines are emitted as one uncoloured token. This, with the per-block and per-document character
      // caps, is what bounds tokenizer CPU.
      tokenizeMaxLineLength: 1_000,
      // Not a CPU bound on Workers: the isolate clock does not advance during synchronous CPU work, so this
      // limit only takes effect in runtimes with a live clock (Node, Bun, dev). It also counts first-use
      // grammar compilation, hence the generous value.
      tokenizeTimeLimit: 2_000,
    });
  } catch {
    return null;
  }
  const sourceLines = text.split('\n');
  if (tokenLines.length > sourceLines.length) return null;
  const runs: number[] = [];
  // Appends a run, merging it into the previous one when the kind matches to keep the payload small.
  const push = (size: number, kindIndex: number): void => {
    const last = runs.length - 2;
    if (last >= 0 && runs[last + 1] === kindIndex) runs[last] = (runs[last] ?? 0) + size;
    else runs.push(size, kindIndex);
  };
  for (let i = 0; i < sourceLines.length; i++) {
    if (i > 0) {
      // A newline carries no colour, so it joins whatever run precedes it.
      const last = runs.length - 2;
      if (last >= 0) runs[last] = (runs[last] ?? 0) + 1;
      else push(1, 0);
    }
    let lineText = '';
    for (const token of tokenLines[i] ?? []) {
      if (!token.content) continue;
      lineText += token.content;
      const kind: TokenKind | undefined = token.color ? COLOR_TO_KIND.get(token.color.toLowerCase()) : undefined;
      push(token.content.length, tokenKindIndex(kind));
    }
    if (lineText !== sourceLines[i]) return null;
  }
  const encoded = Uint32Array.from(runs);
  return isValidRuns(encoded, text.length) ? encoded : null;
}

/**
 * Highlights every code block in a document (layouts and toggles included), within the per-document budget.
 * Built with `Object.fromEntries`, so ids such as `__proto__` stay own data properties instead of touching the
 * prototype; readers must still look entries up with `codeRuns` (own keys only).
 */
export function highlightBlocks(blocks: Block[]): CodeHighlights {
  const entries: Array<[string, TokenRuns]> = [];
  let budget = MAX_DOCUMENT_HIGHLIGHT_CHARS;
  walkBlocks(blocks, block => {
    if (block.type !== 'code' || block.code.length > budget) return;
    const source = highlightSource(block);
    const runs = source && highlightCode(source.text, source.language);
    if (!runs) return;
    budget -= block.code.length;
    entries.push([block.id, runs]);
  });
  return Object.fromEntries(entries);
}
