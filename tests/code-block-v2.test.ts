import { describe, it, expect, beforeAll } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockRenderer } from '../src/components/blocks/BlockRenderer';
import { highlightBlocks } from '../src/lib/blocks/code-highlight';
import { codeDisplay, copyText, displayLines, hasHighlightableCode, highlightedLines, parseLineRanges } from '../src/lib/blocks/code-syntax';
import { documentToMarkdown } from '../src/lib/blocks/markdown';
import { blockSchemas } from '../src/lib/blocks/openapi';
import { applyPaywall, blockWeight } from '../src/lib/blocks/paywall';
import { describeBlockSchema } from '../src/lib/blocks/schema-view';
import type { ArticleDocument, Block, CodeBlock } from '../src/lib/blocks/schema';
import { readStoredDocument, validateDocument } from '../src/lib/blocks/validate';
import { documentText as aiDocumentText } from '../src/lib/ai/context';
import { documentText } from '../src/lib/search/text';
import { renderArticleEmail } from '../src/lib/notifications/article-email-render';
import { HIGHLIGHTER_WARMUP_TIMEOUT_MS, warmHighlighter } from './helpers/warm-highlighter';

beforeAll(warmHighlighter, HIGHLIGHTER_WARMUP_TIMEOUT_MS);

const DIFF = ' export const config = {\n-  retries: 1,\n+  retries: 3,\n };';

function valid(blocks: unknown[]): Block[] {
  const res = validateDocument({ version: 1, blocks });
  if (!res.ok) throw new Error(JSON.stringify(res.errors));
  return res.doc.blocks;
}

function errorsOf(block: Record<string, unknown>): string[] {
  const res = validateDocument({ version: 1, blocks: [{ type: 'code', code: 'a\nb\nc', ...block }] });
  return res.ok ? [] : res.errors.map(e => `${e.path}: ${e.message}`);
}

function render(blocks: Block[], highlights = highlightBlocks(blocks)): string {
  return renderToStaticMarkup(createElement(BlockRenderer, { doc: { version: 1, blocks }, highlights, interactive: false }));
}

/** Visible text inside <code> as a browser would read it (screen-reader labels and tags removed, entities decoded). */
function codeText(markup: string): string {
  const inner = /<code>([\s\S]*)<\/code>/.exec(markup)?.[1] ?? '';
  return inner.replace(/<span class="zb-sr-only[^"]*">[^<]*<\/span>/g, '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
}

describe('code block options: validation', () => {
  it('accepts every option and normalises false flags and spaced ranges', () => {
    const [block] = valid([{
      id: 'c', type: 'code', language: 'ts', code: 'a\nb\nc\nd', filename: '  src/app.ts ', lineNumbers: true,
      highlightLines: '1, 3-4', diff: false, wrap: true, collapseAfter: 3,
    }]);
    expect<unknown>(block).toEqual({
      id: 'c', type: 'code', language: 'ts', code: 'a\nb\nc\nd', filename: 'src/app.ts', lineNumbers: true, highlightLines: '1,3-4', wrap: true, collapseAfter: 3,
    });
  });

  it('keeps blocks without options exactly as stored before the options existed', () => {
    const legacy = { id: 'l', type: 'code', language: 'js', code: 'let a = 1;' };
    expect<unknown>(valid([legacy])).toEqual([legacy]);
    expect<unknown>(valid([{ ...legacy, lineNumbers: false, wrap: null, filename: '' }])).toEqual([legacy]);
    const stored = readStoredDocument({ version: 1, blocks: [legacy] });
    expect<unknown>(stored?.doc.blocks).toEqual([legacy]);
  });

  it('rejects malformed options with a path', () => {
    expect(errorsOf({ filename: 'a`b' })).toEqual(['$.blocks[0].filename: must be one line without backticks or double quotes']);
    expect(errorsOf({ filename: 'a\nb' })).toHaveLength(1);
    // Bidi controls could make the shown path read differently: they are dropped, never stored.
    expect(valid([{ id: 'b', type: 'code', code: 'x', filename: 'evil‮txt.exe⁦' }])[0]).toMatchObject({ filename: 'eviltxt.exe' });
    expect(valid([{ id: 'b', type: 'code', code: 'x', filename: '‏' }])[0]).not.toHaveProperty('filename');
    expect(errorsOf({ filename: 'x'.repeat(201) })).toHaveLength(1);
    expect(errorsOf({ lineNumbers: 'yes' })).toEqual(['$.blocks[0].lineNumbers: must be a boolean']);
    expect(errorsOf({ diff: 1 })).toHaveLength(1);
    expect(errorsOf({ collapseAfter: 2 })).toHaveLength(1);
    expect(errorsOf({ collapseAfter: 501 })).toHaveLength(1);
    expect(errorsOf({ collapseAfter: 4.5 })).toHaveLength(1);
    expect(errorsOf({ highlightLines: 'two' })[0]).toContain('highlightLines');
    expect(errorsOf({ highlightLines: '3-2' })[0]).toContain('within lines 1–3');
    expect(errorsOf({ highlightLines: '4' })[0]).toContain('within lines 1–3');
    expect(errorsOf({ highlightLines: '0' })).toHaveLength(1);
    expect(errorsOf({ highlightLines: Array.from({ length: 51 }, () => '1').join(',') })[0]).toContain('at most 50 ranges');
    expect(errorsOf({ highlightLines: '1-3' })).toEqual([]);
  });

  it('counts lines as displayed: a final line break does not add a line', () => {
    expect(errorsOf({ code: 'a\nb\n', highlightLines: '2' })).toEqual([]);
    expect(errorsOf({ code: 'a\nb\n', highlightLines: '3' })).toHaveLength(1);
  });
});

describe('code block options: shared helpers', () => {
  it('strips diff markers for display and copies the code after the change', () => {
    const view = codeDisplay({ code: DIFF, language: 'ts', diff: true });
    expect(view.text).toBe('export const config = {\n  retries: 1,\n  retries: 3,\n};');
    expect(view.marks).toEqual(['ctx', 'del', 'add', 'ctx']);
    expect(copyText({ code: DIFF, language: 'ts', diff: true })).toBe('export const config = {\n  retries: 3,\n};');
    // Lines without a marker are context and keep their first character.
    expect(copyText({ code: '+a\nb', language: '', diff: true })).toBe('a\nb');
  });

  it('keeps pasted git diff headers whole and out of the copied code', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 3b18e51..a2c4f0d 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@ export const config',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
    ].join('\n');
    const view = codeDisplay({ code: patch, language: 'ts', diff: true });
    expect(view.marks).toEqual(['head', 'head', 'head', 'head', 'head', 'ctx', 'del', 'add']);
    expect(view.text.split('\n').slice(0, 5)).toEqual(patch.split('\n').slice(0, 5));
    expect(copyText({ code: patch, language: 'ts', diff: true })).toBe('const a = 1;\nconst b = 3;');
  });

  it('reads ---/+++ as a header only as the file pair, so removed and added code that looks like one stays code', () => {
    // A removed SQL comment and an added `++ i` line are code, not a file header.
    const view = codeDisplay({ code: '--- note\n ok\n+++ i', language: 'sql', diff: true });
    expect(view.marks).toEqual(['del', 'ctx', 'add']);
    expect(view.text).toBe('-- note\nok\n++ i');
    // A hunk line needs its ranges.
    expect(codeDisplay({ code: '@@ not a hunk', language: '', diff: true }).marks).toEqual(['ctx']);
  });

  it('copies nothing from an all-removed diff', () => {
    expect(copyText({ code: '-a\n-b\n', language: 'ts', diff: true })).toBe('');
    expect(copyText({ code: '--- a/x\n+++ b/x\n@@ -1 +0,0 @@\n-a', language: '', diff: true })).toBe('');
  });

  it('copies plain code as written, with line endings normalised', () => {
    expect(copyText({ code: '+a\r\n-b', language: 'diff' })).toBe('+a\n-b');
  });

  it('parses ranges and bounds them to the code', () => {
    expect(parseLineRanges('2, 4-6')).toEqual([[2, 2], [4, 6]]);
    expect(parseLineRanges('2,')).toBeNull();
    expect([...highlightedLines('2,4-6', 5)]).toEqual([2, 4, 5]);
    expect(highlightedLines('1-999999', 3).size).toBe(3);
    expect(highlightedLines(undefined, 3).size).toBe(0);
    expect(displayLines('a\n')).toEqual(['a']);
    expect(displayLines('')).toEqual(['']);
  });

  it('highlights diff blocks in their language over the code without markers', () => {
    const block: CodeBlock = { id: 'd', type: 'code', language: 'ts', code: DIFF, diff: true };
    const runs = highlightBlocks([block]).d;
    expect(runs).toBeDefined();
    expect(Array.from(runs ?? []).filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0)).toBe(codeDisplay(block).text.length);
    // A diff block labelled `diff` shows its own colours instead of the diff grammar.
    expect(hasHighlightableCode([{ ...block, language: 'diff' }])).toBe(false);
    expect(hasHighlightableCode([{ ...block, language: 'diff', diff: undefined }])).toBe(true);
  });
});

describe('code block options: rendering', () => {
  it('server-renders plain code blocks with the markup stored articles always had', () => {
    const html = render(valid([{ id: 'p', type: 'code', language: 'ts', code: 'let a = 1;' }]));
    expect(html).toStartWith('<div class="zb-doc"><pre class="zb-code"><span class="zb-code-lang">ts</span><code>');
    expect(html).not.toContain('zb-codeblock');
    expect(html).not.toContain('<button');
  });

  it('renders file caption, numbered and emphasised lines, without copyable numbers', () => {
    const blocks = valid([{ id: 'n', type: 'code', language: 'ts', filename: 'src/a.ts', lineNumbers: true, highlightLines: '2', code: 'const a = 1;\nconst b = 2;\n' }]);
    const html = render(blocks);
    expect(html).toContain('<figure class="zb-codeblock"><figcaption class="zb-code-head"><span class="zb-code-file">src/a.ts</span><span class="zb-code-lang">ts</span></figcaption>');
    expect(html).toContain('class="zb-code zb-code-lines zb-code-numbered"');
    expect(html).toContain('--zb-gutter:1ch');
    expect((html.match(/class="zb-line"/g) ?? []).length).toBe(1);
    expect((html.match(/class="zb-line zb-line-hl"/g) ?? []).length).toBe(1);
    expect(html).toContain('zb-tk-keyword');
    // Text of <code> is the code itself: no gutter numbers, the final line break kept, no extra empty line.
    expect(codeText(html)).toBe('const a = 1;\nconst b = 2;\n');
    // The toolbar needs script: never in the server HTML.
    expect(html).not.toContain('<button');
  });

  it('renders diff lines as ins/del with the markers out of the text', () => {
    const html = render(valid([{ id: 'd', type: 'code', language: 'ts', diff: true, code: DIFF }]));
    expect(html).toContain('<del class="zb-line zb-line-del">');
    expect(html).toContain('<ins class="zb-line zb-line-add">');
    expect(html).toContain('zb-code-top');
    expect(codeText(html)).toBe(codeDisplay({ code: DIFF, language: 'ts', diff: true }).text);
    expect(html).toContain('zb-tk-');
    // Changed lines carry a spoken label; context lines do not.
    expect(html).toContain('<del class="zb-line zb-line-del"><span class="zb-sr-only zb-diff-sr">Đã xoá: </span>');
    expect(html).toContain('<ins class="zb-line zb-line-add"><span class="zb-sr-only zb-diff-sr">Đã thêm: </span>');
    expect((html.match(/zb-diff-sr/g) ?? []).length).toBe(2);
  });

  it('renders patch headers as unmarked header lines', () => {
    const html = render(valid([{ id: 'h', type: 'code', language: '', diff: true, code: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b' }]));
    expect((html.match(/<span class="zb-line zb-line-head">/g) ?? []).length).toBe(3);
    expect(codeText(html)).toBe('--- a/x\n+++ b/x\n@@ -1 +1 @@\na\nb');
  });

  it('starts long code collapsed to the requested height and wraps when asked', () => {
    const code = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    const html = render(valid([{ id: 'w', type: 'code', language: '', code, wrap: true, collapseAfter: 5 }]));
    expect(html).toContain('class="zb-code zb-code-top zb-code-wrap zb-code-collapsed"');
    expect(html).toContain('--zb-code-rows:5');
    expect(html).toContain('tabindex="0"');
    expect(codeText(html)).toBe(code);
    // Short code never collapses.
    expect(render(valid([{ id: 's', type: 'code', language: '', code: 'a\nb', collapseAfter: 5 }]))).not.toContain('zb-code-collapsed');
  });

  it('reserves a first line clear of the toolbar on plain blocks without a language label', async () => {
    // happy-dom has no layout, so this checks the stylesheet's arithmetic: the toolbar box ends above the code.
    const css = await Bun.file(new URL('../src/styles/blocks.css', import.meta.url)).text();
    const rem = (re: RegExp) => Number(re.exec(css)?.[1] ?? Number.NaN);
    const toolbarBottom = rem(/\.zb-code-tools \{[^}]*\btop: ([\d.]+)rem/) + rem(/\.zb-code-tools button \{[^}]*\bheight: ([\d.]+)rem/);
    const reserved = rem(/\.zb-code:not\(:has\(> \.zb-code-lang\)\):not\(\.zb-code-head \+ \.zb-code\) \{ padding-top: ([\d.]+)rem; \}/);
    expect(toolbarBottom).toBeCloseTo(2.35);
    expect(reserved).toBeGreaterThan(toolbarBottom);
    // The rule matches the plain server markup itself, so hydration does not move the code.
    expect(render(valid([{ id: 'p', type: 'code', language: '', code: 'echo hi' }]))).toStartWith('<div class="zb-doc"><pre class="zb-code"><code>');
  });

  it('escapes file names and code', () => {
    const html = render(valid([{ id: 'x', type: 'code', language: 'html', filename: '<img src=x onerror=alert(1)>', code: '</code><script>x</script>', lineNumbers: true }]));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(codeText(html)).toBe('</code><script>x</script>');
  });
});

describe('code block options: Markdown, search, AI, email, schema and paywall', () => {
  const block: CodeBlock = {
    id: 'm', type: 'code', language: 'ts', code: DIFF, filename: 'src/config.ts', highlightLines: '2', lineNumbers: true, diff: true, wrap: true, collapseAfter: 3,
  };
  const doc: ArticleDocument = { version: 1, blocks: [block] };

  it('writes the options into the fence info string and keeps the code verbatim', () => {
    expect(documentToMarkdown(doc)).toBe(`\`\`\`diff lang="ts" title="src/config.ts" {2} showLineNumbers\n${DIFF}\n\`\`\``);
    expect(documentToMarkdown({ version: 1, blocks: [{ id: 'f', type: 'code', language: '', code: 'x', filename: 'a.txt' }] })).toBe('```title="a.txt"\nx\n```');
    expect(documentToMarkdown({ version: 1, blocks: [{ id: 'f', type: 'code', language: 'sh', code: 'ls' }] })).toBe('```sh\nls\n```');
  });

  it('indexes and grounds the file name with the code', () => {
    expect(documentText(doc)).toContain('src/config.ts');
    expect(documentText(doc)).toContain('retries: 3');
    expect(aiDocumentText(doc)).toContain('src/config.ts');
    expect(blockWeight(block)).toBe(DIFF.length + 'src/config.ts'.length);
  });

  it('shows the file name in emails', () => {
    const html = renderArticleEmail({
      locale: 'vi', title: 'Demo', excerpt: '', access: 'free', coverUrl: null, document: doc,
      articleUrl: 'https://zuey.me/articles/demo', pricingUrl: 'https://zuey.me/pricing', siteUrl: 'https://zuey.me', mode: 'full',
    });
    expect(JSON.stringify(html)).toContain('src/config.ts');
  });

  it('publishes the options in the OpenAPI/MCP schema with a valid example', async () => {
    const schema = blockSchemas.BlockCode;
    expect(JSON.stringify(schema)).toContain('"highlightLines"');
    for (const key of ['filename', 'lineNumbers', 'diff', 'wrap', 'collapseAfter']) expect(JSON.stringify(schema)).toContain(`"${key}"`);
    const answer = await describeBlockSchema({ types: ['code'] });
    const examples = answer.examples;
    expect(examples && typeof examples === 'object' && 'code_diff' in examples).toBe(true);
    const example = examples && typeof examples === 'object' && 'code_diff' in examples ? examples.code_diff : null;
    expect(validateDocument({ version: 1, blocks: [example] }).ok).toBe(true);
  });

  it('counts code blocks with options as paywall units, top level and nested', () => {
    const code = (id: string): CodeBlock => ({ id, type: 'code', language: 'ts', code: 'x'.repeat(300), filename: `${id}.ts`, lineNumbers: true });
    const top = applyPaywall({ version: 1, blocks: [code('a'), code('b'), code('c')] }, 'knowledges', { isAdmin: false, entitlements: [] });
    expect(top.truncated).toBe(true);
    expect(top.doc.blocks.map(b => b.id)).toEqual(['a']);
    expect(top.outline?.blocks).toBe(2);
    const nested = applyPaywall({ version: 1, blocks: [{ id: 's', type: 'section', width: 'wide', surface: 'none', blocks: [code('a'), { id: 'k', type: 'card', variant: 'outline', blocks: [code('b'), code('c')] }] }] }, 'knowledges', { isAdmin: false, entitlements: [] });
    expect(nested.truncated).toBe(true);
    expect(JSON.stringify(nested.doc)).not.toContain('"b.ts"');
    expect(JSON.stringify(nested.doc)).toContain('"a.ts"');
  });
});
