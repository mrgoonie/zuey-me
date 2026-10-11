import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { BlockRenderer } from '../src/components/blocks/BlockRenderer';
import { documentToMarkdown } from '../src/lib/blocks/markdown';
import { articlesOpenApi, blockSchemas, CARD_EXAMPLE, SECTION_EXAMPLE } from '../src/lib/blocks/openapi';
import { applyPaywall, blockWeight } from '../src/lib/blocks/paywall';
import { BLOCK_TYPES, documentLanes, walkBlocks } from '../src/lib/blocks/schema';
import type { ArticleDocument, Block } from '../src/lib/blocks/schema';
import { canContain, childContext, ROOT_CONTEXT } from '../src/lib/blocks/nesting';
import { BLOCK_REGISTRY, blockDefinitions } from '../src/lib/blocks/registry';
import { readStoredDocument, validateDocument } from '../src/lib/blocks/validate';
import { documentText as aiDocumentText } from '../src/lib/ai/context';
import { documentText } from '../src/lib/search/text';
import { renderArticleEmail } from '../src/lib/notifications/article-email-render';
import { editorInternals } from '../src/components/studio/ArticleEditor';

// `import.meta.env.SSR` is the live process.env in Bun; render the server path like the article page does.
const previousSsr = process.env.SSR;
beforeAll(() => { process.env.SSR = 'true'; });
afterAll(() => { if (previousSsr === undefined) delete process.env.SSR; else process.env.SSR = previousSsr; });

function valid(input: unknown): ArticleDocument {
  const res = validateDocument(input);
  if (!res.ok) throw new Error(JSON.stringify(res.errors));
  return res.doc;
}

function errorsOf(blocks: unknown[]): string[] {
  const res = validateDocument({ version: 1, blocks });
  return res.ok ? [] : res.errors.map(e => `${e.path}: ${e.message}`);
}

const p = (text: string) => ({ type: 'paragraph', text });

const LANDING = {
  version: 1,
  blocks: [
    { type: 'heading', level: 2, text: 'Mở đầu' },
    p('Đoạn mở đầu ở cột đọc.'),
    {
      type: 'section', width: 'wide', surface: 'soft', anchor: 'tinh-nang', blocks: [
        { type: 'heading', level: 2, text: 'Tính năng' },
        {
          type: 'layout', variant: 'columns', cols: { base: 1, md: 2, lg: 3 }, children: [
            { blocks: [{ type: 'card', title: 'Nhanh', icon: 'rocket', accent: 'sky', blocks: [p('Thẻ **một**.')], footer: 'Chân thẻ' }] },
            { blocks: [{ type: 'card', title: 'Gọn', variant: 'soft', align: 'center', blocks: [p('Thẻ hai.')] }] },
            { blocks: [{ type: 'card', image: { url: 'https://media.zuey.me/a.png', alt: 'Ảnh thẻ', width: 800, height: 450 }, variant: 'elevated' }] },
          ],
        },
      ],
    },
    { type: 'section', width: 'full', surface: 'contrast', padding: 'lg', blocks: [p('Dải toàn chiều rộng.')] },
    p('Kết bài.'),
  ],
};

describe('section and card validation', () => {
  it('fills defaults and keeps optional fields', () => {
    const doc = valid({ version: 1, blocks: [{ type: 'section', blocks: [{ type: 'card', title: 'T' }] }] });
    const section = doc.blocks[0];
    expect(section).toMatchObject({ type: 'section', width: 'prose', surface: 'none' });
    if (section.type !== 'section') throw new Error('expected a section');
    expect(section.padding).toBeUndefined();
    expect(section.blocks[0]).toMatchObject({ type: 'card', title: 'T', variant: 'outline', blocks: [] });
    expect(section.id).toMatch(/^b_/);
  });

  it('accepts the landing-style document and the published examples', () => {
    expect(valid(LANDING).blocks).toHaveLength(5);
    expect(errorsOf([SECTION_EXAMPLE])).toEqual([]);
    expect(errorsOf([CARD_EXAMPLE])).toEqual([]);
  });

  it('rejects bad enums, anchors and empty cards', () => {
    expect(errorsOf([{ type: 'section', width: 'huge', blocks: [] }])[0]).toContain('$.blocks[0].width');
    expect(errorsOf([{ type: 'section', surface: 'neon', blocks: [] }])[0]).toContain('surface');
    expect(errorsOf([{ type: 'section', padding: 'xl', blocks: [] }])[0]).toContain('padding');
    expect(errorsOf([{ type: 'section', anchor: 'Bad Anchor', blocks: [] }])[0]).toContain('lowercase slug');
    expect(errorsOf([{ type: 'card', variant: 'glass', title: 'x' }])[0]).toContain('variant');
    expect(errorsOf([{ type: 'card', accent: 'pink', title: 'x' }])[0]).toContain('accent');
    expect(errorsOf([{ type: 'card', align: 'end', title: 'x' }])[0]).toContain('align');
    expect(errorsOf([{ type: 'card' }])[0]).toContain('a card needs a title, an image or at least one block');
    expect(errorsOf([{ type: 'card', image: 'https://x.test/a.png' }])[0]).toContain('must be an object');
    expect(errorsOf([{ type: 'card', image: { url: 'http://x.test/a.png', alt: '' } }]).length).toBeGreaterThan(0);
  });

  it('rejects duplicate section anchors', () => {
    const errors = errorsOf([
      { type: 'section', anchor: 'gia', blocks: [] },
      { type: 'section', anchor: 'gia', blocks: [] },
    ]);
    expect(errors.join('\n')).toContain('duplicate section anchor "gia"');
    expect(errorsOf([{ type: 'section', anchor: 'locked-title', blocks: [] }]).join()).toContain('used by the article page');
  });

  it('keeps a stored section and drops only an unusable anchor', () => {
    const stored = readStoredDocument({ version: 1, blocks: [
      { id: 'b_a', type: 'section', width: 'prose', surface: 'none', anchor: 'gia', blocks: [{ id: 'b_1', type: 'paragraph', text: 'một' }] },
      { id: 'b_b', type: 'section', width: 'prose', surface: 'none', anchor: 'gia', blocks: [{ id: 'b_2', type: 'paragraph', text: 'hai' }] },
      { id: 'b_c', type: 'section', width: 'prose', surface: 'none', anchor: 'related-videos', blocks: [{ id: 'b_3', type: 'paragraph', text: 'ba' }] },
    ] });
    if (!stored) throw new Error('expected a readable document');
    expect(stored.dropped).toBe(0);
    expect(stored.degraded).toBe(2);
    expect(stored.doc.blocks.map(b => (b.type === 'section' ? b.anchor ?? null : 'x'))).toEqual(['gia', null, null]);
  });

  it('enforces nesting: top-level sections, no card in card, nothing heavy in toggles', () => {
    expect(errorsOf([{ type: 'section', blocks: [{ type: 'section', blocks: [] }] }]).join()).toContain('top level');
    expect(errorsOf([{ type: 'toggle', summary: 's', blocks: [{ type: 'section', blocks: [] }] }]).join()).toContain('toggle may not contain a section');
    expect(errorsOf([{
      type: 'layout', variant: 'columns', cols: { base: 1, md: 1, lg: 1 }, children: [{ blocks: [{ type: 'section', blocks: [] }] }],
    }]).join()).toContain('top level');
    expect(errorsOf([{ type: 'card', title: 'a', blocks: [{ type: 'card', title: 'b' }] }]).join()).toContain('a card may not contain a card');
    // A card inside a layout inside a card is still a card in a card.
    expect(errorsOf([{
      type: 'card', title: 'a', blocks: [{
        type: 'layout', variant: 'columns', cols: { base: 1, md: 1, lg: 1 }, children: [{ blocks: [{ type: 'card', title: 'b' }] }],
      }],
    }]).join()).toContain('a card may not contain a card');
    // Cards may sit in toggles, sections and layouts.
    expect(errorsOf([{ type: 'toggle', summary: 's', blocks: [{ type: 'card', title: 'c' }] }])).toEqual([]);
  });

  it('shares the nesting rules with the Studio block menu', () => {
    const root = { layoutDepth: 0, inToggle: false, slug: '' };
    expect(editorInternals.allowedTypes(root)).toEqual(expect.arrayContaining(['section', 'card', 'layout', 'toggle']));
    const inSection = { ...root, ...childContext(ROOT_CONTEXT, 'section') };
    expect(editorInternals.allowedTypes(inSection)).not.toContain('section');
    expect(editorInternals.allowedTypes(inSection)).toContain('card');
    const inCard = { ...root, ...childContext(ROOT_CONTEXT, 'card') };
    expect(editorInternals.allowedTypes(inCard)).not.toContain('card');
    const inToggle = { ...root, ...childContext(ROOT_CONTEXT, 'toggle') };
    expect(editorInternals.allowedTypes(inToggle)).not.toContain('toggle');
    expect(editorInternals.allowedTypes(inToggle)).not.toContain('layout');
    expect(editorInternals.allowedTypes(inToggle)).not.toContain('section');
    expect(canContain(childContext(childContext(ROOT_CONTEXT, 'layout'), 'layout'), 'layout')).toBe(false);
    for (const t of ['section', 'card'] as const) {
      const b = editorInternals.newBlock(t);
      // The Studio's new block must validate where it can be inserted (a card needs its title).
      expect(errorsOf([b])).toEqual([]);
    }
  });

  it('degrades a broken card inside a stored section without losing the rest', () => {
    const stored = readStoredDocument({ version: 1, blocks: [
      { id: 'b_s1', type: 'section', width: 'wide', surface: 'none', blocks: [
        { id: 'b_e1', type: 'embed', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', provider: 'vimeo' },
        { id: 'b_p1', type: 'paragraph', text: 'kept' },
      ] },
    ] });
    if (!stored) throw new Error('expected a readable document');
    const section = stored.doc.blocks[0];
    expect(section?.type).toBe('section');
    expect(documentText(stored.doc)).toContain('kept');
    // The mismatched embed is recovered (degraded to a link) rather than dropping the section.
    expect(stored.dropped).toBe(0);
    if (section?.type === 'section') expect(section.blocks).toHaveLength(2);
  });
});

describe('section and card surfaces', () => {
  const doc = valid(LANDING);

  it('renders sections into lanes and cards with heading, icon, image and footer', () => {
    const html = renderToString(createElement(BlockRenderer, { doc, articleSlug: 'demo' }));
    expect(html).toContain('data-lanes="wide full"');
    expect(html).toContain('<section id="tinh-nang" class="zb-section zb-lane-wide zb-surface-soft zb-pad-md">');
    expect(html).toContain('class="zb-section zb-lane-full zb-surface-contrast zb-pad-lg"');
    expect(html).toContain('class="zb-card zb-card-outline zb-card-align-start zb-accent-sky"');
    expect(html).toContain('<h3 class="zb-card-title"><span>Nhanh</span></h3>');
    // An image-only card has no empty body.
    expect(html).not.toContain('<div class="zb-card-body"></div>');
    expect(html).toContain('<strong>một</strong>');
    expect(html).toContain('class="zb-card-icon" aria-hidden="true"');
    expect(html).toContain('<div class="zb-card-footer"><span>Chân thẻ</span></div>');
    expect(html).toContain('alt="Ảnh thẻ"');
    expect(html).toContain('width="800"');
    expect(html).toContain('zb-card-align-center');
  });

  it('marks lanes only when a wide or full section exists', () => {
    expect(documentLanes(doc)).toEqual(['wide', 'full']);
    const prose = valid({ version: 1, blocks: [{ type: 'section', blocks: [p('a')] }, p('b')] });
    expect(documentLanes(prose)).toEqual([]);
    expect(renderToString(createElement(BlockRenderer, { doc: prose }))).not.toContain('data-lanes');
    const plain = valid({ version: 1, blocks: [p('only prose')] });
    expect(renderToString(createElement(BlockRenderer, { doc: plain }))).toContain('<div class="zb-doc">');
  });

  it('serializes to Markdown, search text and AI text', () => {
    const md = documentToMarkdown(doc, { articleUrl: 'https://zuey.me/articles/demo' });
    expect(md).toContain('## Tính năng');
    expect(md).toContain('### Nhanh\n\nThẻ **một**.\n\nChân thẻ');
    expect(md).toContain('![Ảnh thẻ](https://media.zuey.me/a.png)');
    expect(md).toContain('Dải toàn chiều rộng.');
    expect(md).not.toContain('section');
    const text = documentText(doc);
    for (const s of ['Tính năng', 'Nhanh', 'Thẻ một', 'Chân thẻ', 'Ảnh thẻ', 'Dải toàn chiều rộng.']) expect(text).toContain(s);
    const ai = aiDocumentText(doc);
    for (const s of ['Tính năng', 'Nhanh', 'Thẻ một', 'Chân thẻ', 'Dải toàn chiều rộng.']) expect(ai).toContain(s);
  });

  it('walks into section and card children', () => {
    const types: string[] = [];
    walkBlocks(doc.blocks, b => { types.push(b.type); });
    expect(types.filter(t => t === 'card')).toHaveLength(3);
    expect(types.filter(t => t === 'paragraph')).toHaveLength(5);
  });

  it('weighs containers by their content', () => {
    const card: Block = { id: 'b_c', type: 'card', title: 'Tiêu đề', variant: 'outline', footer: 'Chân', blocks: [{ id: 'b_p', type: 'paragraph', text: 'abcdefghij' }] };
    expect(blockWeight(card)).toBe('Tiêu đề'.length + 'Chân'.length + 10);
    const section: Block = { id: 'b_s', type: 'section', width: 'wide', surface: 'none', blocks: [card] };
    expect(blockWeight(section)).toBe(blockWeight(card));
    expect(blockWeight({ id: 'b_e', type: 'section', width: 'prose', surface: 'none', blocks: [] })).toBe(1);
  });

  it('renders sections and cards in the article email', () => {
    const email = renderArticleEmail({
      locale: 'vi', title: 'Demo', excerpt: 'Tóm tắt', access: 'free', coverUrl: null, document: doc,
      articleUrl: 'https://zuey.me/articles/demo', pricingUrl: 'https://zuey.me/pricing', siteUrl: 'https://zuey.me', mode: 'full',
    });
    expect(email.html).toContain('Nhanh');
    expect(email.html).toContain('Chân thẻ');
    expect(email.html).toContain('Dải toàn chiều rộng.');
    expect(email.text).toContain('Nhanh');
    expect(email.text).toContain('Dải toàn chiều rộng.');
    expect(email.html).toContain('width="486"');
  });

  it('lets the email body budget stop inside a section', () => {
    const big = valid({ version: 1, blocks: [{ type: 'section', blocks: Array.from({ length: 80 }, (_, i) => p(`đoạn ${i} ${'x'.repeat(1500)}`)) }] });
    const email = renderArticleEmail({
      locale: 'vi', title: 'Demo', excerpt: 'Tóm tắt', access: 'free', coverUrl: null, document: big,
      articleUrl: 'https://zuey.me/articles/demo', pricingUrl: 'https://zuey.me/pricing', siteUrl: 'https://zuey.me', mode: 'full',
    });
    expect(email.html).toContain('đoạn 0');
    expect(email.html).not.toContain('đoạn 79');
  });
});

describe('paywall with sections', () => {
  const viewer = { isAdmin: false, entitlements: [] };
  const long = (n: number) => 'x'.repeat(n);

  it('splits a section that holds the whole article instead of leaking it', () => {
    const doc = valid({ version: 1, blocks: [{
      type: 'section', width: 'wide', surface: 'soft', anchor: 'body', blocks: [
        { type: 'heading', level: 2, text: 'Một' }, p(long(200)), { type: 'heading', level: 2, text: 'Hai' }, p(long(200)), p(long(200)),
      ],
    }] });
    const res = applyPaywall(doc, 'knowledges', viewer);
    expect(res.truncated).toBe(true);
    expect(res.doc.blocks).toHaveLength(1);
    const kept = res.doc.blocks[0];
    if (kept.type !== 'section') throw new Error('expected the kept part of the section');
    expect(kept).toMatchObject({ width: 'wide', surface: 'soft', anchor: 'body' });
    expect(kept.blocks.length).toBeGreaterThan(0);
    expect(kept.blocks.length).toBeLessThan(5);
    expect(res.outline?.headings.map(h => h.text)).toContain('Hai');
    expect(JSON.stringify(res.doc)).not.toContain(long(600));
  });

  it('splits a section whose only child is a layout of cards', () => {
    const secret = (n: number) => `bimat${n} `.repeat(40);
    const doc = valid({ version: 1, blocks: [{
      type: 'section', width: 'wide', surface: 'none', blocks: [{
        type: 'layout', variant: 'columns', cols: { base: 1, md: 3, lg: 3 }, children: [1, 2, 3].map(n => ({
          blocks: [{ type: 'card', title: `Thẻ ${n}`, footer: `Chân ${n}`, blocks: [p(secret(n)), p(secret(n + 10))] }],
        })),
      }],
    }] });
    const res = applyPaywall(doc, 'knowledges', viewer);
    expect(res.truncated).toBe(true);
    const kept = documentText(res.doc);
    expect(kept).toContain('bimat1');
    expect(kept).not.toContain('bimat3');
    expect(kept).not.toContain('bimat13');
    // The rebuilt document is still valid and keeps the containers' settings.
    expect(validateDocument(res.doc).ok).toBe(true);
    const section = res.doc.blocks[0];
    if (section?.type !== 'section') throw new Error('expected the kept section');
    const layout = section.blocks[0];
    if (layout?.type !== 'layout') throw new Error('expected the kept layout');
    expect(layout.cols).toEqual({ base: 1, md: 3, lg: 3 });
    expect(layout.children.length).toBeLessThan(3);
    // A partly kept card loses its footer with the rest of its body.
    const lastCard = layout.children.at(-1)?.blocks[0];
    if (lastCard?.type === 'card' && lastCard.blocks.length < 2) expect(lastCard.footer).toBeUndefined();
  });

  it('keeps documents without sections on the original cut', () => {
    const doc = valid({ version: 1, blocks: [p(long(100)), p(long(100)), p(long(100)), p(long(100))] });
    const res = applyPaywall(doc, 'knowledges', viewer);
    expect(res.doc.blocks.map(b => b.id)).toEqual(doc.blocks.slice(0, 2).map(b => b.id));
    expect(res.outline?.blocks).toBe(2);
  });
});

describe('block registry', () => {
  it('defines every block type exactly once, in order', () => {
    for (const t of BLOCK_TYPES) expect(BLOCK_REGISTRY[t].type).toBe(t);
    expect(blockDefinitions().map(d => d.type)).toEqual([...BLOCK_TYPES]);
  });

  it('publishes OpenAPI schemas for section and card', () => {
    expect(Object.keys(blockSchemas)).toEqual(expect.arrayContaining(['BlockSection', 'BlockCard']));
    const block = JSON.stringify(articlesOpenApi.schemas?.Block);
    expect(block).toContain('#/components/schemas/BlockSection');
    expect(block).toContain('#/components/schemas/BlockCard');
    expect(JSON.stringify(blockSchemas.BlockSection)).toContain('"anchor"');
    expect(JSON.stringify(blockSchemas.BlockCard)).toContain('"footer"');
  });
});
