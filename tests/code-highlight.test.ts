import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import { createElement } from 'react';
import { serializeProps } from 'astro/runtime/server/serialize.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockRenderer } from '../src/components/blocks/BlockRenderer';
import { MAX_HIGHLIGHT_CHARS, highlightBlocks, highlightCode } from '../src/lib/blocks/code-highlight';
import {
  TOKEN_KINDS, codeRuns, codeSegments, hasHighlightableCode, isValidRuns, normalizeCode, resolveHighlightLanguage,
} from '../src/lib/blocks/code-syntax';
import type { CodeHighlights, HighlightLanguage, TokenRuns } from '../src/lib/blocks/code-syntax';
import { documentToMarkdown } from '../src/lib/blocks/markdown';
import type { ArticleDocument, Block, CodeBlock } from '../src/lib/blocks/schema';

const code = (id: string, language: string, source: string): CodeBlock => ({ id, type: 'code', language, code: source });
const runsOf = (...values: number[]): TokenRuns => Uint32Array.from(values);

/**
 * Highlights as an island receives them: serialised by Astro's server serializer, then revived the way the
 * `astro-island` client script does (`Object.fromEntries` objects, tuple-tagged arrays and typed arrays).
 */
function islandHighlights(highlights: CodeHighlights): { json: string; revived: CodeHighlights } {
  const json = serializeProps({ highlights }, { displayName: 'BlockRenderer', hydrate: 'load', astroStaticSlot: true });
  const reviveTuple = (raw: unknown): unknown => {
    if (!Array.isArray(raw)) return undefined;
    const [type, value]: unknown[] = raw;
    if (type === 0) return typeof value === 'object' && value !== null
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reviveTuple(v)]))
      : value;
    if (type === 1 && Array.isArray(value)) return value.map(reviveTuple);
    if (type === 10 && Array.isArray(value)) return Uint32Array.from(value.filter((n): n is number => typeof n === 'number'));
    return undefined;
  };
  const props: unknown = JSON.parse(json);
  const wrapped = typeof props === 'object' && props !== null && 'highlights' in props ? props.highlights : undefined;
  const revived = reviveTuple(wrapped);
  const out: CodeHighlights = {};
  if (typeof revived === 'object' && revived !== null) {
    for (const [k, v] of Object.entries(revived)) if (v instanceof Uint32Array) Object.defineProperty(out, k, { value: v, enumerable: true });
  }
  return { json, revived: out };
}

function render(doc: ArticleDocument, highlights?: CodeHighlights, liveHighlight = false): string {
  return renderToStaticMarkup(createElement(BlockRenderer, { doc, highlights, liveHighlight, interactive: false }));
}

/**
 * Text a reader copies out of the rendered <code>, as a browser would parse the server HTML: the input stream's
 * CRLF and lone CR become LF first (HTML preprocessing), then tags (incl. React's comment separators) are removed
 * and entities decoded.
 */
function copiedText(markup: string): string {
  const inner = /<code>([\s\S]*)<\/code>/.exec(markup.replace(/\r\n?/g, '\n'))?.[1] ?? '';
  return inner
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
}

/** Text reproduced by slicing the (normalised) source with the runs; null when the runs are rejected. */
const decoded = (source: string, runs: TokenRuns | null): string | null =>
  codeSegments(normalizeCode(source), runs)?.map(s => s.text).join('') ?? null;

const kinds = (source: string, runs: TokenRuns | null): string[] =>
  (codeSegments(normalizeCode(source), runs) ?? []).flatMap(s => (s.kind && s.text.trim() ? [s.kind] : []));

describe('language resolution', () => {
  it('accepts canonical names and the documented aliases, case- and space-insensitively', () => {
    const cases: Array<[string, HighlightLanguage]> = [
      ['ts', 'typescript'], ['js', 'javascript'], ['tsx', 'tsx'], ['jsx', 'jsx'], ['json', 'json'],
      ['bash', 'shellscript'], ['sh', 'shellscript'], ['shell', 'shellscript'], ['zsh', 'shellscript'],
      ['py', 'python'], ['python', 'python'], ['sql', 'sql'], ['html', 'html'], ['css', 'css'],
      ['yml', 'yaml'], ['yaml', 'yaml'], ['md', 'markdown'], ['markdown', 'markdown'], ['diff', 'diff'],
      [' TS ', 'typescript'], ['TypeScript', 'typescript'],
    ];
    for (const [input, expected] of cases) expect(resolveHighlightLanguage(input)).toBe(expected);
  });

  it('returns null for text, unknown labels and prototype keys', () => {
    for (const input of ['', 'text', 'plaintext', 'cobol', 'toString', '__proto__', 'constructor']) {
      expect(resolveHighlightLanguage(input)).toBeNull();
    }
  });
});

describe('highlightCode', () => {
  const samples: Array<[string, string, string]> = [
    ['typescript', 'ts', 'const a: number = 1; // n'],
    ['javascript', 'js', 'export function f(x) { return `v${x}`; }'],
    ['tsx', 'tsx', 'const A = () => <div className="x">{a}</div>;'],
    ['jsx', 'jsx', 'const B = <Button onClick={go}>Go</Button>;'],
    ['json', 'json', '{"a": 1, "b": [true, null]}'],
    ['shell', 'sh', 'echo "$HOME" | grep -v foo # c'],
    ['python', 'py', 'def f(x):\n    return x + 1  # c'],
    ['sql', 'sql', 'SELECT id FROM users WHERE name = \'a\';'],
    ['html', 'html', '<a href="/x">hi</a>'],
    ['css', 'css', '.a { color: #fff; margin: 0 auto; }'],
    ['yaml', 'yml', 'name: zuey\nport: 4321'],
    ['markdown', 'md', '# Title\n\n**bold** and `code`'],
    ['diff', 'diff', '@@ -1 +1 @@\n-old\n+new'],
  ];
  for (const [name, label, source] of samples) {
    it(`colours ${name} and reproduces the source exactly`, () => {
      const runs = highlightCode(source, label);
      expect(runs).not.toBeNull();
      expect(kinds(source, runs).length).toBeGreaterThan(0);
      expect(decoded(source, runs)).toBe(source);
    });
  }

  it('maps TextMate scopes to the expected kinds', () => {
    const ts = 'const s = "x"; // c';
    expect(kinds(ts, highlightCode(ts, 'ts'))).toEqual(expect.arrayContaining(['keyword', 'string', 'comment']));
    const diff = '@@ -1 +1 @@\n-a\n+b';
    expect(kinds(diff, highlightCode(diff, 'diff'))).toEqual(['meta', 'deleted', 'inserted']);
  });

  it('emits compact [length, kindIndex] runs that cover the code exactly', () => {
    const source = 'const a = 1; // one\nconst b = 2;';
    const runs = highlightCode(source, 'ts');
    expect(runs).toBeInstanceOf(Uint32Array);
    const values = Array.from(runs ?? []);
    expect(values.length % 2).toBe(0);
    expect(values.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0)).toBe(source.length);
    expect(values.filter((_, i) => i % 2 === 1).every(k => k <= TOKEN_KINDS.length)).toBe(true);
    // Same-kind neighbours are merged, so no two consecutive runs share a kind.
    expect(values.filter((_, i) => i % 2 === 1).every((k, i, kindsList) => i === 0 || kindsList[i - 1] !== k)).toBe(true);
  });

  it('falls back to plain (null) for unsupported or text languages, empty and oversized code', () => {
    expect(highlightCode('x = 1', 'text')).toBeNull();
    expect(highlightCode('x = 1', 'cobol')).toBeNull();
    expect(highlightCode('x = 1', '')).toBeNull();
    expect(highlightCode('', 'ts')).toBeNull();
    expect(highlightCode('a'.repeat(MAX_HIGHLIGHT_CHARS + 1), 'ts')).toBeNull();
  });

  it('keeps indentation, entities, quotes, Unicode, tabs, blank and trailing lines byte-identical', () => {
    const tricky = [
      'function f() {',
      '\tif (a < b && c > d) return "<&amp;>" + \'quote\' + `tpl`;',
      '    const s = "Tiếng Việt — 漢字 🚀 \\u00e9";',
      '',
      '}',
      '',
    ].join('\n');
    expect(decoded(tricky, highlightCode(tricky, 'ts'))).toBe(tricky);
  });

  it('tokenises CRLF and lone-CR code as LF', () => {
    const crlf = 'a = 1\r\nb = 2\r\n';
    const runs = highlightCode(crlf, 'py');
    expect(runs).not.toBeNull();
    expect(decoded(crlf, runs)).toBe('a = 1\nb = 2\n');
    expect(highlightCode('a = 1\rb = 2', 'py')).toEqual(highlightCode('a = 1\nb = 2', 'py'));
  });

  it('reuses the cached result for an identical block', () => {
    const first = highlightCode('const cached = true;', 'ts');
    expect(highlightCode('const cached = true;', 'typescript')).toBe(first);
  });

  it('keeps a very long line intact (beyond the tokenizer line limit)', () => {
    const long = `const x = "${'y'.repeat(5_000)}"; // end`;
    const runs = highlightCode(long, 'ts');
    expect(runs).not.toBeNull();
    expect(decoded(long, runs)).toBe(long);
  });
});

describe('token runs validation', () => {
  it('accepts only even-length Uint32Array runs with known kinds that sum to the code length', () => {
    expect(isValidRuns(runsOf(3, 0, 2, 1), 5)).toBe(true);
    expect(isValidRuns(runsOf(5, TOKEN_KINDS.length), 5)).toBe(true);
    const bad: unknown[] = [
      runsOf(), runsOf(3), runsOf(3, 0, 2), runsOf(3, 0, 3, 1), runsOf(5, TOKEN_KINDS.length + 1), runsOf(0, 0, 5, 0),
      [3, 0, 2, 1], Uint16Array.from([3, 0, 2, 1]), 'x', null, { 0: 5, 1: 0, length: 2 },
    ];
    for (const runs of bad) expect(isValidRuns(runs, 5)).toBe(false);
  });

  it('reads only own entries, so prototype member names are never treated as runs', () => {
    const inherited: CodeHighlights = {};
    for (const id of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      expect(codeRuns(inherited, id, 5)).toBeNull();
    }
    expect(codeRuns(undefined, 'a', 5)).toBeNull();
  });
});

describe('highlightBlocks', () => {
  it('covers code nested in layouts and toggles and skips unsupported languages', () => {
    const blocks: Block[] = [
      code('top', 'ts', 'let a = 1;'),
      code('plain', 'text', 'just text'),
      { id: 'lay', type: 'layout', variant: 'columns', cols: { base: 1, md: 2, lg: 2 }, children: [{ blocks: [code('inLayout', 'py', 'x = 1')] }] },
      { id: 'tog', type: 'toggle', summary: 'More', blocks: [code('inToggle', 'sh', 'ls -la')] },
    ];
    expect(hasHighlightableCode(blocks)).toBe(true);
    expect(Object.keys(highlightBlocks(blocks)).sort()).toEqual(['inLayout', 'inToggle', 'top']);
    expect(hasHighlightableCode([code('p', 'text', 'x'), { id: 'para', type: 'paragraph', text: 'hi' }])).toBe(false);
  });

  it('stores ids named after Object.prototype members as own entries and renders them', () => {
    const ids = ['constructor', 'toString', 'valueOf', '__proto__'];
    const blocks = ids.map(id => code(id, 'ts', `const ${id.replace(/_/g, 'p')} = 1;`));
    const highlights = highlightBlocks(blocks);
    expect(Object.getPrototypeOf(highlights)).toBe(Object.prototype);
    for (const id of ids) expect(Object.hasOwn(highlights, id)).toBe(true);
    expect(Object.keys(highlights).sort()).toEqual([...ids].sort());
    // Survives the island props round trip and arrives as flat typed arrays.
    const { json, revived } = islandHighlights(highlights);
    expect(json).toContain('"__proto__":[10,[');
    for (const id of ids) expect(Object.hasOwn(revived, id)).toBe(true);
    for (const id of ids) expect(revived[id]).toEqual(highlights[id] ?? runsOf());
    const html = render({ version: 1, blocks }, revived);
    const codeBlocks = html.split('<pre').slice(1);
    expect(codeBlocks.length).toBe(ids.length);
    for (const part of codeBlocks) expect(part).toContain('zb-tk-keyword');
  });

  it('renders prototype-named blocks plain without crashing when no highlights were computed', () => {
    const blocks = ['constructor', 'toString', '__proto__'].map(id => code(id, 'ts', 'let a = 1;'));
    for (const highlights of [undefined, {}]) {
      const html = render({ version: 1, blocks }, highlights);
      expect(html).not.toContain('zb-tk-');
      expect((html.match(/let a = 1;/g) ?? []).length).toBe(3);
    }
  });
});

describe('code block rendering', () => {
  it('renders server tokens as escaped spans and blocks markup injection from code', () => {
    const source = '</code><script>alert("x")</script>\n<img src=x onerror="alert(1)"> & \'q\'';
    const block = code('xss', 'html', source);
    const highlights = highlightBlocks([block]);
    expect(highlights.xss).toBeDefined();
    const html = render({ version: 1, blocks: [block] }, highlights);
    expect(html).toContain('class="zb-tk-');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;/code&gt;');
    expect(copiedText(html)).toBe(source);
  });

  it('renders CRLF code with single line breaks once the browser parses the server HTML', () => {
    const source = 'const a = 1; // x\r\nconst b = 2;\r\n\r\nexport { a, b };\r\n';
    const block = code('crlf', 'ts', source);
    for (const highlights of [highlightBlocks([block]), undefined]) {
      const html = render({ version: 1, blocks: [block] }, highlights);
      expect(html).not.toContain('\r');
      expect(copiedText(html)).toBe(normalizeCode(source));
    }
  });

  it('renders unsupported languages and missing tokens as plain code without crashing', () => {
    for (const [block, highlights] of [
      [code('a', 'text', 'plain <b>text</b> & more'), undefined],
      [code('b', 'cobol', 'MOVE A TO B.'), {}],
      [code('c', 'ts', 'const x = 1;'), undefined],
    ] as const) {
      const html = render({ version: 1, blocks: [block] }, highlights);
      expect(html).not.toContain('zb-tk-');
      expect(copiedText(html)).toBe(block.code);
    }
  });

  it('ignores runs that do not cover the code, out-of-range kinds and malformed data', () => {
    const block = code('f', 'ts', 'const a = 1;');
    const doc: ArticleDocument = { version: 1, blocks: [block] };
    const forged: unknown[] = [
      runsOf(5, 1),
      runsOf(5, 1, 20, 0),
      runsOf(12, TOKEN_KINDS.length + 1),
      [12, 1],
      [['const a = 1;', 'keyword']],
      'x" onmouseover="alert(1)',
      { length: 2, 0: 12, 1: 1 },
    ];
    for (const runs of forged) {
      // Deliberately ill-typed: the renderer must survive whatever arrives in island props.
      const highlights = JSON.parse('{}') as CodeHighlights;
      Object.defineProperty(highlights, 'f', { value: runs, enumerable: true });
      const html = render(doc, highlights);
      expect(html).not.toContain('zb-tk-');
      expect(html).not.toContain('onmouseover');
      expect(copiedText(html)).toBe('const a = 1;');
    }
    // Well-formed but arbitrary runs can only recolour the block's own text.
    const recoloured = render(doc, { f: runsOf(6, 2, 6, 0) });
    expect(recoloured).toContain('<span class="zb-tk-keyword">const </span>');
    expect(copiedText(recoloured)).toBe('const a = 1;');
  });

  it('server-renders live-highlight previews as plain code until the client highlighter loads', () => {
    const html = render({ version: 1, blocks: [code('l', 'ts', 'const a = 1;')] }, undefined, true);
    expect(html).not.toContain('zb-tk-');
    expect(copiedText(html)).toBe('const a = 1;');
  });

  it('leaves the stored document and its Markdown export unchanged', () => {
    const block = code('m', 'ts', 'const a = "<&>";\r\n');
    const doc: ArticleDocument = { version: 1, blocks: [block] };
    const before = JSON.stringify(doc);
    const markdown = documentToMarkdown(doc);
    render(doc, highlightBlocks(doc.blocks));
    expect(JSON.stringify(doc)).toBe(before);
    expect(documentToMarkdown(doc)).toBe(markdown);
  });
});

describe('token palette', () => {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    const [r = 0, g = 0, b = 0] = channels.map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
  };

  it('gives every token kind a colour with at least 7:1 contrast on the code background', () => {
    const css = fs.readFileSync(new URL('../src/styles/blocks.css', import.meta.url), 'utf8');
    const palette = new Map([...css.matchAll(/--zb-tk-([a-z]+):\s*(#[0-9a-f]{6})/gi)].map(m => [m[1] ?? '', m[2] ?? '']));
    for (const kind of TOKEN_KINDS) {
      const color = palette.get(kind);
      expect(color).toBeDefined();
      expect(contrast(color ?? '#000000', '#1c1917')).toBeGreaterThanOrEqual(7);
    }
  });
});
