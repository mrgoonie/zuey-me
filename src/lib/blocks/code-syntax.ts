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
  walkBlocks(blocks, b => { if (!found && b.type === 'code' && highlightSource(b)) found = true; });
  return found;
}

/** The fields of a code block that decide what is shown, highlighted and copied. */
export interface CodeSource {
  code: string;
  language: string;
  diff?: boolean;
}

/** How one line of a diff block reads: added (`+`), removed (`-`) or context (a space, or no marker). */
export type DiffMark = 'add' | 'del' | 'ctx';

export interface CodeDisplay {
  /** Text shown and highlighted: the normalised code, with diff markers removed. */
  text: string;
  /** Diff mark of every line of `text` (trailing empty line included); null unless the block is a diff. */
  marks: DiffMark[] | null;
}

const DIFF_MARKS: Record<string, DiffMark> = { '+': 'add', '-': 'del', ' ': 'ctx' };

/** Text and diff marks of a code block. A diff line's first character is its marker and is not part of the code. */
export function codeDisplay(block: CodeSource): CodeDisplay {
  const text = normalizeCode(block.code);
  if (!block.diff) return { text, marks: null };
  const marks: DiffMark[] = [];
  const lines = text.split('\n').map(line => {
    const mark = Object.hasOwn(DIFF_MARKS, line.charAt(0)) ? DIFF_MARKS[line.charAt(0)] : undefined;
    marks.push(mark ?? 'ctx');
    return mark ? line.slice(1) : line;
  });
  return { text: lines.join('\n'), marks };
}

/** Lines as a reader sees them: a final line break ends the last line instead of opening an empty one. */
export function displayLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Text and grammar the highlighter tokenises for a block, or null when it renders plain. */
export function highlightSource(block: CodeSource): { text: string; language: HighlightLanguage } | null {
  const language = resolveHighlightLanguage(block.language);
  // A diff block shows its own +/- colours; the diff grammar would only see the code once the markers are gone.
  if (!language || !block.code || (block.diff && language === 'diff')) return null;
  return { text: codeDisplay(block).text, language };
}

/**
 * What the copy button puts on the clipboard: the code itself, never the diff markers. A diff copies the code
 * after the change (added and context lines without their marker; removed lines are left out).
 */
export function copyText(block: CodeSource): string {
  const { text, marks } = codeDisplay(block);
  if (!marks) return text;
  return text.split('\n').filter((_, i) => marks[i] !== 'del').join('\n');
}

/** `highlightLines` syntax: 1-based line numbers and inclusive ranges, comma separated ("2,4-6"). */
export const LINE_RANGES_RE = /^\d{1,6}(?:-\d{1,6})?(?:,\d{1,6}(?:-\d{1,6})?)*$/;

/** Ranges of a `highlightLines` value, or null when it is not well formed. */
export function parseLineRanges(spec: string): Array<[number, number]> | null {
  const compact = spec.replace(/\s+/g, '');
  if (!LINE_RANGES_RE.test(compact)) return null;
  return compact.split(',').map(part => {
    const [from = '0', to] = part.split('-');
    return [Number(from), Number(to ?? from)];
  });
}

/** Lines (1-based, at most `lineCount`) named by a `highlightLines` value; empty for a missing or invalid one. */
export function highlightedLines(spec: string | undefined, lineCount: number): Set<number> {
  const out = new Set<number>();
  for (const [from, to] of (spec ? parseLineRanges(spec) : null) ?? []) {
    for (let n = Math.max(1, from); n <= Math.min(to, lineCount); n++) out.add(n);
  }
  return out;
}
