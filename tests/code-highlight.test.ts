import { describe, it, expect } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockRenderer } from '../src/components/blocks/BlockRenderer';
import { MAX_HIGHLIGHT_CHARS, highlightBlocks, highlightCode } from '../src/lib/blocks/code-highlight';
import { hasHighlightableCode, highlightedText, resolveHighlightLanguage } from '../src/lib/blocks/code-syntax';
import type { CodeHighlights, HighlightLanguage, HighlightLine } from '../src/lib/blocks/code-syntax';
import { documentToMarkdown } from '../src/lib/blocks/markdown';
import type { ArticleDocument, Block, CodeBlock } from '../src/lib/blocks/schema';

const code = (id: string, language: string, source: string): CodeBlock => ({ id, type: 'code', language, code: source });

function render(doc: ArticleDocument, highlights?: CodeHighlights, liveHighlight = false): string {
  return renderToStaticMarkup(createElement(BlockRenderer, { doc, highlights, liveHighlight, interactive: false }));
}

/** Text a reader copies out of the rendered <code>: tags (incl. React's comment separators) removed, entities decoded. */
function copiedText(markup: string): string {
  const inner = /<code>([\s\S]*)<\/code>/.exec(markup)?.[1] ?? '';
  return inner
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
}

const kinds = (lines: HighlightLine[] | null): string[] => (lines ?? []).flat().flatMap(t => (t[1] ? [t[1]] : []));

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
      const lines = highlightCode(source, label);
      expect(lines).not.toBeNull();
      expect(kinds(lines).length).toBeGreaterThan(0);
      expect(highlightedText(lines ?? [])).toBe(source);
    });
  }

  it('maps TextMate scopes to the expected kinds', () => {
    const k = kinds(highlightCode('const s = "x"; // c', 'ts'));
    expect(k).toEqual(expect.arrayContaining(['keyword', 'string', 'comment']));
    expect(kinds(highlightCode('@@ -1 +1 @@\n-a\n+b', 'diff'))).toEqual(['meta', 'deleted', 'inserted']);
  });

  it('falls back to plain (null) for unsupported or text languages, empty and oversized code', () => {
    expect(highlightCode('x = 1', 'text')).toBeNull();
    expect(highlightCode('x = 1', 'cobol')).toBeNull();
    expect(highlightCode('x = 1', '')).toBeNull();
    expect(highlightCode('', 'ts')).toBeNull();
    expect(highlightCode('a'.repeat(MAX_HIGHLIGHT_CHARS + 1), 'ts')).toBeNull();
  });

  it('keeps indentation, entities, quotes, Unicode, tabs, CRLF, blank and trailing lines byte-identical', () => {
    const tricky = [
      'function f() {',
      '\tif (a < b && c > d) return "<&amp;>" + \'quote\' + `tpl`;',
      '    const s = "Tiếng Việt — 漢字 🚀 \\u00e9";',
      '',
      '}',
      '',
    ].join('\n');
    expect(highlightedText(highlightCode(tricky, 'ts') ?? [])).toBe(tricky);
    const crlf = 'a = 1\r\nb = 2\r\n';
    expect(highlightedText(highlightCode(crlf, 'py') ?? [])).toBe(crlf);
  });

  it('reuses the cached result for an identical block', () => {
    const first = highlightCode('const cached = true;', 'ts');
    expect(highlightCode('const cached = true;', 'typescript')).toBe(first);
  });

  it('keeps a very long line intact (beyond the tokenizer line limit)', () => {
    const long = `const x = "${'y'.repeat(5_000)}"; // end`;
    const lines = highlightCode(long, 'ts');
    expect(lines).not.toBeNull();
    expect(highlightedText(lines ?? [])).toBe(long);
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

  it('ignores tokens that do not reproduce the source, and unknown token kinds', () => {
    const block = code('f', 'ts', 'const a = 1;');
    const forged: CodeHighlights = { f: [[['const b = 2;', 'keyword']]] };
    const forgedHtml = render({ version: 1, blocks: [block] }, forged);
    expect(forgedHtml).not.toContain('zb-tk-');
    expect(copiedText(forgedHtml)).toBe('const a = 1;');

    const badKind = JSON.parse('{"f":[[["const a = 1;","x\\" onmouseover=\\"alert(1)"]]]}') as CodeHighlights;
    const badHtml = render({ version: 1, blocks: [block] }, badKind);
    expect(badHtml).not.toContain('onmouseover');
    expect(copiedText(badHtml)).toBe('const a = 1;');
  });

  it('server-renders live-highlight previews as plain code until the client highlighter loads', () => {
    const html = render({ version: 1, blocks: [code('l', 'ts', 'const a = 1;')] }, undefined, true);
    expect(html).not.toContain('zb-tk-');
    expect(copiedText(html)).toBe('const a = 1;');
  });

  it('leaves the stored document and its Markdown export unchanged', () => {
    const block = code('m', 'ts', 'const a = "<&>";\n');
    const doc: ArticleDocument = { version: 1, blocks: [block] };
    const before = JSON.stringify(doc);
    const markdown = documentToMarkdown(doc);
    highlightBlocks(doc.blocks);
    render(doc, highlightBlocks(doc.blocks));
    expect(JSON.stringify(doc)).toBe(before);
    expect(documentToMarkdown(doc)).toBe(markdown);
    expect(markdown).toContain('```ts\nconst a = "<&>";\n');
  });
});
