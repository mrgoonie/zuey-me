import { describe, it, expect } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { serializeProps } from 'astro/runtime/server/serialize.js';
import { BlockRenderer } from '../src/components/blocks/BlockRenderer';
import { documentToMarkdown } from '../src/lib/blocks/markdown';
import { hasMath, mathMarkup, mathNumbers } from '../src/lib/blocks/math';
import type { MathRenders } from '../src/lib/blocks/math';
import { MAX_DOCUMENT_MATH_CHARS, renderMathBlocks, renderTex } from '../src/lib/blocks/math-render';
import { BLOCK_SCHEMA_NOTES, MATH_EXAMPLE, blockSchemas } from '../src/lib/blocks/openapi';
import { applyPaywall, blockWeight } from '../src/lib/blocks/paywall';
import type { ArticleDocument, Block, MathBlock } from '../src/lib/blocks/schema';
import { readStoredDocument, validateDocument } from '../src/lib/blocks/validate';
import { documentText as aiDocumentText } from '../src/lib/ai/context';
import { documentText } from '../src/lib/search/text';

const math = (id: string, tex: string, extra: Partial<MathBlock> = {}): MathBlock => ({ id, type: 'math', tex, ...extra });

function valid(blocks: unknown[]): ArticleDocument {
  const res = validateDocument({ version: 1, blocks });
  if (!res.ok) throw new Error(JSON.stringify(res.errors));
  return res.doc;
}

function errorsOf(blocks: unknown[]): string[] {
  const res = validateDocument({ version: 1, blocks });
  return res.ok ? [] : res.errors.map(e => `${e.path}: ${e.message}`);
}

function render(doc: ArticleDocument, renders?: MathRenders): string {
  return renderToStaticMarkup(createElement(BlockRenderer, { doc, math: renders, interactive: false }));
}

describe('math block validation', () => {
  it('keeps v1 math unchanged and stores modes and numbering only when they differ from the defaults', () => {
    expect(valid([{ id: 'm', type: 'math', tex: 'E = mc^2', caption: 'Einstein' }]).blocks[0]).toEqual(math('m', 'E = mc^2', { caption: 'Einstein' }));
    expect(valid([{ id: 'm', type: 'math', tex: 'x', mode: 'display', numbered: false }]).blocks[0]).toEqual(math('m', 'x'));
    expect(valid([{ id: 'm', type: 'math', tex: 'x', mode: null, numbered: null }]).blocks[0]).toEqual(math('m', 'x'));
    expect(valid([{ id: 'm', type: 'math', tex: 'x', numbered: true }]).blocks[0]).toEqual(math('m', 'x', { numbered: true }));
    expect(valid([{ id: 'm', type: 'math', tex: 'x', mode: 'inline' }]).blocks[0]).toEqual(math('m', 'x', { mode: 'inline' }));
  });

  it('rejects bad modes, non-boolean numbering, numbered inline math and empty TeX', () => {
    expect(errorsOf([{ id: 'm', type: 'math', tex: 'x', mode: 'block' }])).toEqual(['$.blocks[0].mode: must be one of display, inline']);
    expect(errorsOf([{ id: 'm', type: 'math', tex: 'x', numbered: 'yes' }])).toEqual(['$.blocks[0].numbered: must be a boolean']);
    expect(errorsOf([{ id: 'm', type: 'math', tex: 'x', mode: 'inline', numbered: true }])[0]).toContain('applies only to display math');
    expect(errorsOf([{ id: 'm', type: 'math', tex: '  ' }])).toEqual(['$.blocks[0].tex: must not be empty']);
    expect(errorsOf([{ id: 'm', type: 'math', tex: 'x'.repeat(10_001) }])[0]).toContain('at most 10000');
  });

  it('accepts malformed TeX: it is shown as source instead of being rejected', () => {
    expect(errorsOf([{ type: 'math', tex: '\\frac{1}{' }])).toEqual([]);
  });

  it('a lenient stored read drops numbering from inline math instead of losing the block', () => {
    const read = readStoredDocument({ version: 1, blocks: [{ id: 'm', type: 'math', tex: 'x', mode: 'inline', numbered: true }] });
    expect(read?.doc.blocks).toEqual([math('m', 'x', { mode: 'inline' })]);
    expect(read?.degraded).toBe(1);
  });
});

describe('math typesetting (KaTeX)', () => {
  it('renders display and inline math with MathML and the TeX annotation', () => {
    const display = renderTex('\\frac{a}{b}');
    const inline = renderTex('\\frac{a}{b}', 'inline');
    if (!display.ok || !inline.ok) throw new Error('expected typeset math');
    expect(display.html).toContain('katex-display');
    expect(display.html).toContain('<math');
    expect(display.html).toContain('<annotation encoding="application/x-tex">\\frac{a}{b}</annotation>');
    expect(inline.html).not.toContain('katex-display');
  });

  it('never trusts links, html commands or images', () => {
    const attacks = [
      '\\href{javascript:alert(1)}{x}', '\\href{data:text/html,<script>alert(1)</script>}{x}', '\\url{javascript:alert(1)}', '\\url{https://evil.example}',
      '\\htmlClass{x}{y}', '\\htmlStyle{color:red}{y}', '\\htmlId{pwn}{y}', '\\htmlData{onclick=alert(1)}{y}',
      '\\includegraphics{https://evil.example/a.png}', '\\text{<img src=x onerror=alert(1)>}', '<script>alert(1)</script>',
    ];
    for (const tex of attacks) {
      const res = renderTex(tex);
      const html = res.ok ? res.html : '';
      expect(html).not.toContain('href=');
      expect(html).not.toContain('<img');
      expect(html).not.toContain('<script');
      // The source may appear as escaped text (the MathML annotation), never inside an attribute.
      expect(html).not.toMatch(/="[^"]*(javascript|data):/);
      expect(html).not.toContain('class="x"');
      expect(html).not.toContain('id="pwn"');
      expect(html).not.toContain('data-onclick');
      expect(html).not.toContain('style="color:red');
      // Whatever KaTeX made of it, the full page render escapes the source too.
      const page = render(valid([math('m', tex)]), renderMathBlocks([math('m', tex)]));
      expect(page).not.toMatch(/<script|<img|href=|="[^"]*javascript:/);
    }
  });

  it('caps sizes and macro expansion and reports malformed TeX instead of throwing', () => {
    const rule = renderTex('\\rule{500em}{500em}');
    expect(rule.ok && rule.html).toContain('border-right-width:20em');
    const loop = renderTex('\\def\\a{\\a}\\a');
    expect(loop.ok).toBe(false);
    const broken = renderTex('\\frac{1}{');
    expect(broken).toMatchObject({ ok: false });
    expect(broken.ok ? '' : broken.error).toContain('KaTeX parse error');
    expect(renderTex('{'.repeat(20_000) + '}'.repeat(20_000)).ok).toBe(false);
  });

  it('does not leak \\gdef definitions between formulas', () => {
    expect(renderTex('\\gdef\\zueyfoo{1}\\zueyfoo').ok).toBe(true);
    expect(renderTex('\\zueyfoo').ok).toBe(false);
  });

  it('typesets nested math, skips failures and stays within the document budget', () => {
    const big = 'x'.repeat(9_000);
    const blocks: Block[] = [
      math('__proto__', 'a^2'),
      { id: 's', type: 'section', width: 'prose', surface: 'none', blocks: [math('in-section', 'b')] },
      { id: 't', type: 'toggle', summary: 'More', blocks: [math('in-toggle', 'c')] },
      { id: 'l', type: 'layout', variant: 'columns', cols: { base: 1, md: 2, lg: 2 }, children: [{ blocks: [math('in-layout', 'd')] }] },
      math('broken', '\\frac{'),
      ...Array.from({ length: Math.ceil(MAX_DOCUMENT_MATH_CHARS / big.length) + 1 }, (_, i) => math(`big${i}`, big)),
    ];
    const renders = renderMathBlocks(blocks);
    expect(Object.hasOwn(renders, '__proto__')).toBe(true);
    expect(mathMarkup(renders, '__proto__')).toContain('katex');
    for (const id of ['in-section', 'in-toggle', 'in-layout']) expect(mathMarkup(renders, id)).toContain('katex');
    expect(mathMarkup(renders, 'broken')).toBeNull();
    expect(mathMarkup(renders, 'constructor')).toBeNull();
    const typesetBig = Object.keys(renders).filter(k => k.startsWith('big')).length;
    expect(typesetBig).toBe(Math.floor((MAX_DOCUMENT_MATH_CHARS - 6) / big.length));
    expect(hasMath(blocks)).toBe(true);
    expect(hasMath([{ id: 'p', type: 'paragraph', text: 'no math' }])).toBe(false);
  });
});

describe('math rendering', () => {
  const doc = valid([
    math('m1', 'a^2 + b^2 = c^2', { numbered: true, caption: 'Pythagoras' }),
    { id: 's', type: 'section', width: 'prose', surface: 'none', blocks: [math('m2', 'x', { mode: 'inline' }), math('m3', 'e^{i\\pi} = -1', { numbered: true })] },
    math('m4', '\\frac{', { numbered: true }),
  ]);

  it('numbers numbered display formulas in document order', () => {
    expect([...mathNumbers(doc.blocks)]).toEqual([['m1', 1], ['m3', 2], ['m4', 3]]);
  });

  it('server markup: typeset formula, equation number, no-JS TeX source and caption', () => {
    const html = render(doc, renderMathBlocks(doc.blocks));
    expect(html).toContain('<figure class="zb-frame zb-math zb-math-display">');
    expect(html).toContain('<span class="zb-math-number">(1)</span>');
    expect(html).toContain('<span class="zb-math-number">(2)</span>');
    expect(html).toContain('<details class="zb-math-tex"><summary>Mã TeX</summary><pre><code>a^2 + b^2 = c^2</code></pre></details>');
    expect(html).toContain('<figcaption>Pythagoras</figcaption>');
    expect(html).toContain('zb-math zb-math-inline');
    // The malformed formula gets an error note and keeps its source (and number), readable as math by assistive technology.
    expect(html).toContain('<figure class="zb-frame zb-math zb-math-display zb-math-raw"><div class="zb-frame-body"><p class="zb-frame-error" role="status">Không hiển thị được công thức này; đây là mã TeX gốc.</p><div class="zb-math-row"><code class="zb-math-source" role="math" aria-label="\\frac{">\\frac{</code><span class="zb-math-number">(3)</span>');
    // The copy-TeX toolbar appears only after hydration.
    expect(html).not.toContain('Chép TeX');
  });

  it('without server markup (feeds, email) every formula shows its TeX source and no error note', () => {
    const html = render(doc);
    expect(html).not.toContain('katex');
    expect(html).not.toContain('zb-frame-error');
    expect(html).toContain('<code class="zb-math-source" role="math" aria-label="a^2 + b^2 = c^2">a^2 + b^2 = c^2</code>');
  });

  it('server markup survives Astro island prop serialisation', () => {
    const renders = renderMathBlocks(doc.blocks);
    const json = serializeProps({ math: renders }, { displayName: 'BlockRenderer', hydrate: 'load', astroStaticSlot: true });
    const parsed: unknown = JSON.parse(json);
    const wrapped = typeof parsed === 'object' && parsed !== null && 'math' in parsed ? parsed.math : null;
    const inner = Array.isArray(wrapped) ? wrapped[1] : null;
    const m1 = typeof inner === 'object' && inner !== null && 'm1' in inner ? inner.m1 : null;
    expect(Array.isArray(m1) ? m1[1] : null).toBe(renders.m1);
  });
});

describe('stored math documents from before typesetting', () => {
  it('a v1 stored math block reads unchanged and renders typeset with its source fallback', () => {
    const stored = { version: 1, blocks: [{ id: 'old', type: 'math', tex: 'E = mc^2', caption: 'Einstein' }, { id: 'p', type: 'paragraph', text: 'After' }] };
    const read = readStoredDocument(stored);
    if (!read) throw new Error('expected a readable document');
    expect(read.degraded).toBe(0);
    expect(read.doc.blocks[0]).toEqual(math('old', 'E = mc^2', { caption: 'Einstein' }));
    const html = render(read.doc, renderMathBlocks(read.doc.blocks));
    expect(html).toContain('zb-math zb-math-display');
    expect(html).toContain('class="katex-display"');
    expect(html).not.toContain('zb-math-number');
    expect(documentToMarkdown(read.doc)).toBe('$$\nE = mc^2\n$$\n\n*Einstein*\n\nAfter');
  });
});

describe('math in Markdown, search, AI, schema and paywall', () => {
  it('exports display, inline and captioned math', () => {
    const doc = valid([math('a', 'a^2', { caption: 'Square' }), math('b', 'x +\n  y', { mode: 'inline' })]);
    expect(documentToMarkdown(doc)).toBe('$$\na^2\n$$\n\n*Square*\n\n$x + y$');
  });

  it('feeds the TeX and caption to search and AI text', () => {
    const doc = valid([math('a', '\\sqrt{2}', { caption: 'Căn hai' })]);
    expect(documentText(doc)).toContain('\\sqrt{2}');
    expect(documentText(doc)).toContain('Căn hai');
    expect(aiDocumentText(doc)).toContain('\\sqrt{2}');
  });

  it('documents mode and numbering in the block schema with a valid example', () => {
    const schema = JSON.stringify(blockSchemas.BlockMath);
    expect(schema).toContain('"mode"');
    expect(schema).toContain('"numbered"');
    expect(errorsOf([MATH_EXAMPLE])).toEqual([]);
    expect(BLOCK_SCHEMA_NOTES.some(n => n.startsWith('Math blocks'))).toBe(true);
  });

  const reader = { isAdmin: false, entitlements: [] };

  it('a top-level math block is one paywall unit', () => {
    const doc = valid([
      { id: 'p1', type: 'paragraph', text: 'intro '.repeat(20) },
      math('m1', 'a'.repeat(100)),
      { id: 'p2', type: 'paragraph', text: 'secret '.repeat(40) },
    ]);
    expect(blockWeight(doc.blocks[1])).toBe(100);
    const res = applyPaywall(doc, 'knowledges', reader);
    expect(res.truncated).toBe(true);
    expect(res.doc.blocks.map(b => b.id)).toEqual(['p1', 'm1']);
  });

  it('math nested in a toggle or layout is split out as its own unit and keeps its numbering', () => {
    const doc = valid([
      { id: 't', type: 'toggle', summary: 'Proof', blocks: [math('m1', 'a'.repeat(400), { numbered: true }), math('m2', 'b'.repeat(60), { numbered: true })] },
      { id: 'l', type: 'layout', variant: 'columns', cols: { base: 1, md: 2, lg: 2 }, children: [{ blocks: [math('m3', 'c'.repeat(400))] }] },
    ]);
    const res = applyPaywall(doc, 'knowledges', reader);
    expect(res.truncated).toBe(true);
    const kept = res.doc.blocks;
    expect(kept.map(b => b.id)).toEqual(['t']);
    const toggle = kept[0];
    expect(toggle.type === 'toggle' ? toggle.blocks.map(b => b.id) : []).toEqual(['m1']);
    expect([...mathNumbers(kept)]).toEqual([['m1', 1]]);
    expect(render(res.doc, renderMathBlocks(kept))).not.toContain('bbbb');
  });

  it('math inside a section or card is cut unit by unit, and the withheld formula is never typeset', () => {
    const doc = valid([
      { id: 's', type: 'section', width: 'wide', surface: 'card', blocks: [math('m1', 'a'.repeat(300), { numbered: true }), math('m2', 'b'.repeat(300), { numbered: true })] },
      { id: 'c', type: 'card', title: 'Proof', blocks: [math('m3', 'c'.repeat(300))] },
    ]);
    const res = applyPaywall(doc, 'knowledges', reader);
    expect(res.truncated).toBe(true);
    expect(res.doc.blocks.map(b => b.id)).toEqual(['s']);
    const section = res.doc.blocks[0];
    expect(section.type === 'section' ? section.blocks.map(b => b.id) : []).toEqual(['m1']);
    const renders = renderMathBlocks(res.doc.blocks);
    expect(Object.keys(renders)).toEqual(['m1']);
    const html = render(res.doc, renders);
    expect(html).toContain('<span class="zb-math-number">(1)</span>');
    expect(html).not.toContain('bbbb');
    expect(html).not.toContain('cccc');
  });

  it('a reader with the entitlement gets every formula', () => {
    const doc = valid([math('m1', 'a'.repeat(300)), { id: 'c', type: 'card', title: 'Proof', blocks: [math('m2', 'b'.repeat(300))] }]);
    const res = applyPaywall(doc, 'knowledges', { isAdmin: true, entitlements: [] });
    expect(res.truncated).toBe(false);
    expect(Object.keys(renderMathBlocks(res.doc.blocks)).sort()).toEqual(['m1', 'm2']);
  });
});
