/**
 * Syntax highlighting for article code blocks.
 *
 * Shiki's fine-grained core with the JavaScript regex engine (no WASM) and only the grammars listed in
 * `code-syntax.ts`. Output is plain data — lines of `[text, kind?]` tokens — that React renders as
 * text nodes inside spans, so author input is never turned into HTML. Colours live in CSS
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
import { TOKEN_KINDS, resolveHighlightLanguage } from './code-syntax';
import type { CodeHighlights, HighlightLanguage, HighlightLine, TokenKind } from './code-syntax';

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
 * Tokenises `code` for `language`. Returns null — meaning "render plain code" — for an unsupported language,
 * empty or oversized code, a tokenizer failure, or output whose text does not reproduce the source exactly.
 */
export function highlightCode(code: string, language: string | undefined): HighlightLine[] | null {
  const lang: HighlightLanguage | null = resolveHighlightLanguage(language);
  if (!lang || !code || code.length > MAX_HIGHLIGHT_CHARS) return null;
  const key = `${lang}\u0000${code}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const lines = tokenize(code, lang);
  remember(key, lines);
  return lines;
}

const cache = new Map<string, HighlightLine[] | null>();
let cachedChars = 0;

function remember(key: string, lines: HighlightLine[] | null): void {
  cache.set(key, lines);
  cachedChars += key.length;
  // Map iteration follows insertion order, so the oldest entries are evicted first.
  for (const oldest of cache.keys()) {
    if (cachedChars <= CACHE_MAX_CHARS) break;
    cache.delete(oldest);
    cachedChars -= oldest.length;
  }
}

function tokenize(code: string, lang: HighlightLanguage): HighlightLine[] | null {
  let tokenLines: Array<Array<{ content: string; color?: string }>>;
  try {
    tokenLines = getHighlighter().codeToTokensBase(code, {
      lang,
      theme: THEME.name,
      tokenizeMaxLineLength: 2_000,
      // Generous: the limit includes first-use grammar compilation, and Workers freeze timers during CPU work anyway.
      tokenizeTimeLimit: 2_000,
    });
  } catch {
    return null;
  }
  const sourceLines = code.split('\n');
  if (tokenLines.length > sourceLines.length) return null;
  const lines: HighlightLine[] = [];
  for (let i = 0; i < sourceLines.length; i++) {
    const source = sourceLines[i] ?? '';
    const line: HighlightLine = [];
    let text = '';
    for (const token of tokenLines[i] ?? []) {
      if (!token.content) continue;
      text += token.content;
      const kind = token.color ? COLOR_TO_KIND.get(token.color.toLowerCase()) : undefined;
      const prev = line[line.length - 1];
      // Merge neighbours of the same kind to keep the payload small.
      if (prev && prev[1] === kind) prev[0] += token.content;
      else line.push(kind ? [token.content, kind] : [token.content]);
    }
    // The tokenizer drops a CRLF's carriage return; restore it so the text stays byte-identical.
    if (text !== source) {
      if (source === `${text}\r`) line.push(['\r']);
      else return null;
    }
    lines.push(line);
  }
  return lines;
}

/** Highlights every code block in a document (layouts and toggles included), within the per-document budget. */
export function highlightBlocks(blocks: Block[]): CodeHighlights {
  const out: CodeHighlights = {};
  let budget = MAX_DOCUMENT_HIGHLIGHT_CHARS;
  walkBlocks(blocks, block => {
    if (block.type !== 'code' || block.code.length > budget) return;
    const lines = highlightCode(block.code, block.language);
    if (!lines) return;
    budget -= block.code.length;
    out[block.id] = lines;
  });
  return out;
}
