/** Text blocks: paragraph, heading, list, checklist, quote, callout, code, divider and icon. */
import type { BlockDefinition } from '../block-definition';
import { CALLOUT_TONES, LIMITS } from '../schema';
import type {
  CalloutBlock, ChecklistBlock, ChecklistItem, CodeBlock, DividerBlock, HeadingBlock, IconBlock, ListBlock, ParagraphBlock, QuoteBlock,
} from '../schema';
import { ICON_ALIGNS, ICON_PIXELS, ICON_SIZES, ICON_TONES } from '../icons';
import { LINE_RANGES_RE, codeDisplay, displayLines, parseLineRanges } from '../code-syntax';
import { fence, quoteLines } from '../markdown-format';
import { iconName, inline, short } from './schema-fragments';
import { flag, isInt, isObj, isOneOf, plain, plainLength } from './shared';

const T = LIMITS.text;
const S = LIMITS.shortText;

/** Example icon block (also returned by the block_schema MCP tool). */
export const ICON_BLOCK_EXAMPLE = { type: 'icon', name: 'lightbulb', size: 'lg', tone: 'accent', label: 'Ý tưởng chính', align: 'center' } as const;
/** Example callout with an icon (also returned by the block_schema MCP tool). */
export const CALLOUT_ICON_EXAMPLE = { type: 'callout', tone: 'tip', icon: 'rocket', text: 'Deploy **after** the tests pass.' } as const;

export const paragraph: BlockDefinition<ParagraphBlock> = {
  type: 'paragraph',
  validate(v, raw, { id, path }) {
    const text = v.str(raw, 'text', path, T);
    return text === undefined ? undefined : { id, type: 'paragraph', text };
  },
  markdown: b => b.text,
  searchText: b => [plain(b.text)],
  aiText: b => plain(b.text),
  weight: b => plainLength(b.text),
  schema: { properties: { text: inline }, required: ['text'] },
};

export const heading: BlockDefinition<HeadingBlock> = {
  type: 'heading',
  validate(v, raw, { id, path }) {
    const text = v.str(raw, 'text', path, S, { nonEmpty: true });
    if (!isInt(raw.level, 1, 3)) { v.err(`${path}.level`, 'must be 1, 2 or 3'); return undefined; }
    const level = raw.level === 1 ? 1 : raw.level === 2 ? 2 : 3;
    return text === undefined ? undefined : { id, type: 'heading', level, text };
  },
  markdown: b => `${'#'.repeat(b.level + 1)} ${b.text}`,
  searchText: b => [plain(b.text)],
  aiText: b => plain(b.text),
  weight: b => plainLength(b.text),
  schema: { properties: { level: { type: 'integer', enum: [1, 2, 3] }, text: short }, required: ['level', 'text'] },
};

export const list: BlockDefinition<ListBlock> = {
  type: 'list',
  validate(v, raw, { id, path }) {
    const style = raw.style === undefined ? 'bullet' : raw.style;
    if (style !== 'bullet' && style !== 'number') { v.err(`${path}.style`, "must be 'bullet' or 'number'"); return undefined; }
    const items = v.strArray(raw, 'items', path, LIMITS.listItems, T, 1);
    return items ? { id, type: 'list', style, items } : undefined;
  },
  markdown: b => b.items.map((item, i) => `${b.style === 'number' ? `${i + 1}.` : '-'} ${item}`).join('\n'),
  searchText: b => b.items.map(plain),
  aiText: b => b.items.map(plain).join('\n'),
  weight: b => b.items.reduce((n, s) => n + plainLength(s), 0),
  schema: {
    properties: { style: { type: 'string', enum: ['bullet', 'number'] }, items: { type: 'array', minItems: 1, maxItems: LIMITS.listItems, items: inline } },
    required: ['items'],
  },
};

export const checklist: BlockDefinition<ChecklistBlock> = {
  type: 'checklist',
  validate(v, raw, { id, path }) {
    if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > LIMITS.listItems) {
      v.err(`${path}.items`, `must contain 1–${LIMITS.listItems} items`);
      return undefined;
    }
    const items: ChecklistItem[] = [];
    raw.items.forEach((item: unknown, i: number) => {
      const p = `${path}.items[${i}]`;
      if (!isObj(item)) { v.err(p, 'must be an object {text, checked}'); return; }
      const text = v.str(item, 'text', p, T);
      if (text !== undefined) items.push({ text, checked: item.checked === true });
    });
    return items.length === raw.items.length ? { id, type: 'checklist', items } : undefined;
  },
  markdown: b => b.items.map(item => `- [${item.checked ? 'x' : ' '}] ${item.text}`).join('\n'),
  searchText: b => b.items.map(i => plain(i.text)),
  aiText: b => b.items.map(i => plain(i.text)).join('\n'),
  weight: b => b.items.reduce((n, s) => n + plainLength(s.text), 0),
  schema: {
    properties: {
      items: { type: 'array', minItems: 1, maxItems: LIMITS.listItems, items: { type: 'object', required: ['text'], properties: { text: inline, checked: { type: 'boolean' } } } },
    },
    required: ['items'],
  },
};

export const quote: BlockDefinition<QuoteBlock> = {
  type: 'quote',
  validate(v, raw, { id, path }) {
    const text = v.str(raw, 'text', path, T);
    const cite = v.str(raw, 'cite', path, S, { optional: true });
    return text === undefined ? undefined : { id, type: 'quote', text, ...(cite ? { cite } : {}) };
  },
  markdown: b => quoteLines(b.text) + (b.cite ? `\n>\n> — ${b.cite}` : ''),
  searchText: b => [plain(b.text), plain(b.cite)],
  aiText: b => [plain(b.text), plain(b.cite)].join(' '),
  weight: b => plainLength(b.text) + plainLength(b.cite),
  schema: { properties: { text: inline, cite: short }, required: ['text'] },
};

export const callout: BlockDefinition<CalloutBlock> = {
  type: 'callout',
  validate(v, raw, { id, path }) {
    const tone = raw.tone === undefined ? 'info' : raw.tone;
    if (!isOneOf(CALLOUT_TONES, tone)) { v.err(`${path}.tone`, `must be one of ${CALLOUT_TONES.join(', ')}`); return undefined; }
    const text = v.str(raw, 'text', path, T);
    const icon = v.iconName(raw, 'icon', path, true);
    if (icon === null) return undefined;
    return text === undefined ? undefined : { id, type: 'callout', tone, text, ...(icon ? { icon } : {}) };
  },
  markdown: b => quoteLines(`**${b.tone.toUpperCase()}:** ${b.text}`),
  searchText: b => [plain(b.text)],
  aiText: b => plain(b.text),
  weight: b => plainLength(b.text),
  schema: {
    properties: {
      tone: { type: 'string', enum: [...CALLOUT_TONES] },
      text: inline,
      icon: { ...iconName, description: 'Optional allowlisted icon replacing the tone glyph' },
    },
    required: ['text'],
  },
};

/** Example code block using the optional presentation fields (also returned by the block_schema MCP tool). */
export const CODE_BLOCK_EXAMPLE = {
  type: 'code', language: 'ts', filename: 'src/config.ts', lineNumbers: true, highlightLines: '2',
  diff: true, code: ' export const config = {\n-  retries: 1,\n+  retries: 3,\n };',
} as const;

/** One line, no backticks or double quotes: the name also goes into the Markdown fence's info string. */
const FILENAME_RE = /^[^\u0000-\u001f\u007f`"]+$/;
/**
 * Bidirectional formatting characters can make a shown path read differently from the real one. They are
 * removed rather than rejected, so a stored block that has them keeps rendering (stored reads drop invalid blocks).
 */
const BIDI_CONTROLS_RE = /[؜‎‏‪-‮⁦-⁩]/g;


/** Markdown fence info string: the language, then `title="…"`, `{lines}` and `showLineNumbers` metadata. */
function codeInfo(b: CodeBlock): string {
  const parts = [b.diff ? `diff${b.language ? ` lang="${b.language}"` : ''}` : b.language];
  if (b.filename) parts.push(`title="${b.filename}"`);
  if (b.highlightLines) parts.push(`{${b.highlightLines}}`);
  if (b.lineNumbers) parts.push('showLineNumbers');
  return parts.filter(Boolean).join(' ');
}

export const code: BlockDefinition<CodeBlock> = {
  type: 'code',
  validate(v, raw, { id, path }) {
    const language = v.str(raw, 'language', path, 40, { optional: true }) ?? '';
    if (language && !/^[\w+#.-]+$/.test(language)) { v.err(`${path}.language`, 'contains invalid characters'); return undefined; }
    const source = v.str(raw, 'code', path, LIMITS.code);
    const filename = v.str(raw, 'filename', path, LIMITS.codeFilename, { optional: true })?.replace(BIDI_CONTROLS_RE, '').trim();
    if (filename && !FILENAME_RE.test(filename)) { v.err(`${path}.filename`, 'must be one line without backticks or double quotes'); return undefined; }
    const lineNumbers = flag(v, raw, 'lineNumbers', path);
    const diff = flag(v, raw, 'diff', path);
    const wrap = flag(v, raw, 'wrap', path);
    const collapseAfter = raw.collapseAfter ?? undefined;
    if (collapseAfter !== undefined && !isInt(collapseAfter, LIMITS.codeCollapseMin, LIMITS.codeCollapseMax)) {
      v.err(`${path}.collapseAfter`, `must be an integer from ${LIMITS.codeCollapseMin} to ${LIMITS.codeCollapseMax}`);
      return undefined;
    }
    const rangesRaw = v.str(raw, 'highlightLines', path, 200, { optional: true });
    let highlightLines: string | undefined;
    if (rangesRaw?.trim() && source !== undefined) {
      const ranges = parseLineRanges(rangesRaw);
      const lineCount = displayLines(codeDisplay({ code: source, language, diff: diff === true }).text).length;
      if (!ranges) v.err(`${path}.highlightLines`, 'must list line numbers and ranges such as "2,4-6"');
      else if (ranges.length > LIMITS.codeLineRanges) v.err(`${path}.highlightLines`, `must have at most ${LIMITS.codeLineRanges} ranges`);
      else if (ranges.some(([from, to]) => from < 1 || to < from || to > lineCount)) {
        v.err(`${path}.highlightLines`, `ranges must go upwards within lines 1–${lineCount}`);
      } else highlightLines = rangesRaw.replace(/\s+/g, '');
    }
    if (source === undefined || lineNumbers === null || diff === null || wrap === null) return undefined;
    return {
      id, type: 'code', language, code: source,
      ...(filename ? { filename } : {}),
      ...(lineNumbers ? { lineNumbers } : {}),
      ...(highlightLines ? { highlightLines } : {}),
      ...(diff ? { diff } : {}),
      ...(wrap ? { wrap } : {}),
      ...(collapseAfter !== undefined ? { collapseAfter } : {}),
    };
  },
  markdown: b => fence(b.code, codeInfo(b)),
  searchText: b => (b.filename ? [b.filename, b.code] : [b.code]),
  aiText: b => (b.filename ? `${b.filename}\n${b.code}` : b.code),
  weight: b => b.code.length + (b.filename?.length ?? 0),
  schema: {
    properties: {
      language: { type: 'string', maxLength: 40 },
      code: { type: 'string', maxLength: LIMITS.code },
      filename: { type: 'string', maxLength: LIMITS.codeFilename, description: 'File name or path shown above the code (one line, no backticks or double quotes)' },
      lineNumbers: { type: 'boolean', default: false, description: 'Show a line number gutter (numbers are never copied)' },
      highlightLines: {
        type: 'string', maxLength: 200, pattern: LINE_RANGES_RE.source,
        description: `Lines to emphasise, 1-based, comma-separated numbers and ranges such as "2,4-6" (at most ${LIMITS.codeLineRanges} ranges, within the code's lines)`,
      },
      diff: {
        type: 'boolean', default: false,
        description: 'Each line starts with a marker: + added, - removed, a space for context. The marker is shown in the gutter, not as code; the copy button copies the code after the change (added and context lines, markers removed). language still picks the highlighter',
      },
      wrap: { type: 'boolean', default: false, description: 'Soft-wrap long lines by default instead of scrolling sideways; readers can switch' },
      collapseAfter: {
        type: 'integer', minimum: LIMITS.codeCollapseMin, maximum: LIMITS.codeCollapseMax,
        description: 'Code longer than this many lines starts collapsed to that height (scrollable) with a button to show it all',
      },
    },
    required: ['code'],
    extra: { examples: [CODE_BLOCK_EXAMPLE] },
  },
};

export const divider: BlockDefinition<DividerBlock> = {
  type: 'divider',
  validate: (_v, _raw, { id }) => ({ id, type: 'divider' }),
  markdown: () => '---',
  searchText: () => [],
  aiText: () => '',
  weight: () => 1,
  schema: { properties: {} },
};

export const icon: BlockDefinition<IconBlock> = {
  type: 'icon',
  validate(v, raw, { id, path }) {
    const name = v.iconName(raw, 'name', path, false);
    const size = raw.size === undefined ? 'md' : raw.size;
    if (!isOneOf(ICON_SIZES, size)) { v.err(`${path}.size`, `must be one of ${ICON_SIZES.join(', ')}`); return undefined; }
    const tone = raw.tone === undefined ? 'default' : raw.tone;
    if (!isOneOf(ICON_TONES, tone)) { v.err(`${path}.tone`, `must be one of ${ICON_TONES.join(', ')}`); return undefined; }
    const align = raw.align;
    if (align !== undefined && !isOneOf(ICON_ALIGNS, align)) { v.err(`${path}.align`, `must be one of ${ICON_ALIGNS.join(', ')}`); return undefined; }
    const label = v.str(raw, 'label', path, LIMITS.iconLabel, { optional: true })?.trim();
    if (!name) return undefined;
    return { id, type: 'icon', name, size, tone, ...(label ? { label } : {}), ...(align ? { align } : {}) };
  },
  // Decorative icons have no text equivalent; a labelled icon falls back to its label.
  markdown: b => b.label ?? '',
  searchText: b => [b.label ?? ''],
  aiText: b => b.label ?? '',
  weight: b => 1 + (b.label ? b.label.length : 0),
  schema: {
    properties: {
      name: iconName,
      size: { type: 'string', enum: [...ICON_SIZES], default: 'md', description: `Pixels: ${ICON_SIZES.map(s => `${s} ${ICON_PIXELS[s]}`).join(', ')}` },
      tone: { type: 'string', enum: [...ICON_TONES], default: 'default' },
      label: { type: 'string', maxLength: LIMITS.iconLabel, description: 'Accessible name for an icon that carries meaning (role="img"); omit for a decorative icon (aria-hidden). Also the Markdown/text fallback.' },
      align: { type: 'string', enum: [...ICON_ALIGNS], default: 'start' },
    },
    required: ['name'],
    extra: { examples: [ICON_BLOCK_EXAMPLE] },
  },
};
