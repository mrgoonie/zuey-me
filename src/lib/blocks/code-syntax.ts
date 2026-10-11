/**
 * Lightweight syntax-highlighting contract shared by the server highlighter and the client renderer:
 * supported languages and their aliases, token kinds, and the token data shape. No highlighter code here,
 * so client islands can import it without pulling the grammars into their bundle.
 */
import type { Block } from './schema';
import { walkBlocks } from './schema';

export const HIGHLIGHT_LANGUAGES = [
  'typescript', 'javascript', 'tsx', 'jsx', 'json', 'shellscript', 'python', 'sql',
  'html', 'css', 'yaml', 'markdown', 'diff',
] as const;

export type HighlightLanguage = (typeof HIGHLIGHT_LANGUAGES)[number];

const ALIASES: Record<string, HighlightLanguage> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  bash: 'shellscript', sh: 'shellscript', shell: 'shellscript', zsh: 'shellscript', console: 'shellscript',
  py: 'python', python3: 'python',
  yml: 'yaml',
  md: 'markdown',
  htm: 'html',
  jsonc: 'json', json5: 'json',
  patch: 'diff',
};

const LANGUAGE_SET = new Set<string>(HIGHLIGHT_LANGUAGES);

function isHighlightLanguage(value: string): value is HighlightLanguage {
  return LANGUAGE_SET.has(value);
}

/** Grammar for an author-supplied language label, or null when the block should render as plain code. */
export function resolveHighlightLanguage(language: string | undefined): HighlightLanguage | null {
  const key = (language ?? '').trim().toLowerCase();
  if (!key) return null;
  if (isHighlightLanguage(key)) return key;
  return Object.hasOwn(ALIASES, key) ? ALIASES[key] ?? null : null;
}

/** Token kinds; each maps to a `.zb-tk-<kind>` colour class in blocks.css. */
export const TOKEN_KINDS = [
  'comment', 'keyword', 'string', 'constant', 'function', 'type', 'tag', 'attr', 'variable',
  'regexp', 'inserted', 'deleted', 'heading', 'link', 'meta',
] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

/**
 * Compact token runs for one code block: a flat `[length, kindIndex, length, kindIndex, …]` list covering the
 * block's normalised code (see `normalizeCode`) from start to end. `kindIndex` 0 means uncoloured text; `k > 0`
 * means `TOKEN_KINDS[k - 1]`. Runs carry no text, so the payload is a fraction of the code's size and the
 * rendered text always comes from the block itself. A typed array because Astro serialises island props of that
 * type as one flat number list, whereas each element of a plain array gets its own `[type, value]` wrapper.
 */
export type TokenRuns = Uint32Array;
/**
 * Token runs per code block id. Block ids may be any `[A-Za-z0-9_-]` string, `constructor` and `__proto__`
 * included, so build this with `Object.fromEntries` (own data properties) and read it via `codeRuns`.
 */
export type CodeHighlights = Record<string, TokenRuns>;

/** One rendered piece of a highlighted block: its exact text and, when coloured, its kind. */
export interface CodeSegment {
  text: string;
  kind?: TokenKind;
}

/**
 * Line endings as an HTML parser would deliver them (CRLF and lone CR become LF). Both the highlighter and the
 * renderer work on this form, so server HTML, hydration and the copied text all agree.
 */
export function normalizeCode(code: string): string {
  return code.replace(/\r\n?/g, '\n');
}

/** Index of `kind` in the runs encoding (1-based; 0 is uncoloured). */
export function tokenKindIndex(kind: TokenKind | undefined): number {
  return kind ? TOKEN_KINDS.indexOf(kind) + 1 : 0;
}

/** True when `runs` is a well-formed run list that covers exactly `length` characters. */
export function isValidRuns(runs: unknown, length: number): runs is TokenRuns {
  // Elements of a Uint32Array are always non-negative integers, so only zero sizes and kind range need checks.
  if (!(runs instanceof Uint32Array) || runs.length === 0 || runs.length % 2 !== 0) return false;
  let total = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const size = runs[i] ?? 0;
    const kind = runs[i + 1] ?? 0;
    if (size === 0 || kind > TOKEN_KINDS.length) return false;
    total += size;
    if (total > length) return false;
  }
  return total === length;
}

/** Validated runs for block `id`, ignoring inherited keys (`constructor`, `toString`, …) and malformed data. */
export function codeRuns(highlights: CodeHighlights | undefined, id: string, length: number): TokenRuns | null {
  if (!highlights || !Object.hasOwn(highlights, id)) return null;
  const runs: unknown = highlights[id];
  return isValidRuns(runs, length) ? runs : null;
}

/** Splits normalised `code` by `runs`; null (render plain) unless the runs cover the code exactly. */
export function codeSegments(code: string, runs: unknown): CodeSegment[] | null {
  if (!isValidRuns(runs, code.length)) return null;
  const segments: CodeSegment[] = [];
  let at = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const size = runs[i] ?? 0;
    const kind = TOKEN_KINDS[(runs[i + 1] ?? 0) - 1];
    const text = code.slice(at, at + size);
    at += size;
    segments.push(kind ? { text, kind } : { text });
  }
  return segments;
}

/** True when some code block (nested ones included) has a supported language, i.e. loading the highlighter pays off. */
export function hasHighlightableCode(blocks: Block[]): boolean {
  let found = false;
  walkBlocks(blocks, b => { if (!found && b.type === 'code' && b.code && resolveHighlightLanguage(b.language)) found = true; });
  return found;
}
