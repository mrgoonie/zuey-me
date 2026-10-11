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

const KIND_SET = new Set<string>(TOKEN_KINDS);

export function isTokenKind(value: unknown): value is TokenKind {
  return typeof value === 'string' && KIND_SET.has(value);
}

/** One token: its exact source text and, when coloured, its kind. */
export type HighlightToken = [text: string, kind?: TokenKind];
export type HighlightLine = HighlightToken[];
/** Highlighted lines per code block id. Blocks without an entry render as plain code. */
export type CodeHighlights = Record<string, HighlightLine[]>;

/** Exact source text of highlighted lines; renderers compare it with the block's code before using tokens. */
export function highlightedText(lines: HighlightLine[]): string {
  return lines.map(line => line.map(t => t[0]).join('')).join('\n');
}

/** True when some code block (nested ones included) has a supported language, i.e. loading the highlighter pays off. */
export function hasHighlightableCode(blocks: Block[]): boolean {
  let found = false;
  walkBlocks(blocks, b => { if (!found && b.type === 'code' && b.code && resolveHighlightLanguage(b.language)) found = true; });
  return found;
}
