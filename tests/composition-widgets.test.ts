import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { BlockRenderer } from '../src/components/blocks/BlockRenderer';
import { documentToMarkdown } from '../src/lib/blocks/markdown';
import {
  articlesOpenApi, blockSchemas, COMPARISON_EXAMPLE, PROGRESS_EXAMPLE, STAT_EXAMPLE, STEPS_EXAMPLE, TABS_EXAMPLE,
} from '../src/lib/blocks/openapi';
import { applyPaywall } from '../src/lib/blocks/paywall';
import { BLOCK_TYPES, walkBlocks } from '../src/lib/blocks/schema';
import type { ArticleDocument, Block } from '../src/lib/blocks/schema';
import { canContain, childContext, ROOT_CONTEXT } from '../src/lib/blocks/nesting';
import { readStoredDocument, validateDocument } from '../src/lib/blocks/validate';
import { documentText as aiDocumentText } from '../src/lib/ai/context';
import { documentText } from '../src/lib/search/text';
import { renderArticleEmail } from '../src/lib/notifications/article-email-render';
import { editorInternals } from '../src/components/studio/ArticleEditor';
import { describeBlockSchema } from '../src/lib/blocks/schema-view';
import { canonicalNumber, localeNumber, progressText } from '../src/lib/blocks/widget-format';
import { buildManifest, mergeTranslations } from '../src/lib/blocks/localization';

// `import.meta.env.SSR` is the live process.env in Bun; render the server path like the article page does.
const previousSsr = process.env.SSR;
beforeAll(() => { process.env.SSR = 'true'; });
afterAll(() => { if (previousSsr === undefined) delete process.env.SSR; else process.env.SSR = previousSsr; });

function valid(input: unknown): ArticleDocument {
  const res = validateDocument(input);
  if (!res.ok) throw new Error(JSON.stringify(res.errors));
  return res.doc;
}

function errorsOf(blocks: unknown[]): string {
  const res = validateDocument({ version: 1, blocks });
  return res.ok ? '' : res.errors.map(e => `${e.path}: ${e.message}`).join('\n');
}

const p = (text: string) => ({ type: 'paragraph', text });
const html = (doc: ArticleDocument, locale?: string) => renderToString(createElement(BlockRenderer, { doc, articleSlug: 'demo', locale }));
const WIDGETS = ['tabs', 'stat', 'steps', 'comparison', 'progress'] as const;
const EXAMPLES = [TABS_EXAMPLE, STAT_EXAMPLE, STEPS_EXAMPLE, COMPARISON_EXAMPLE, PROGRESS_EXAMPLE];

describe('composition widget validation', () => {
  it('registers the five widgets and accepts every published example', () => {
    for (const t of WIDGETS) expect(BLOCK_TYPES).toContain(t);
    const doc = valid({ version: 1, blocks: EXAMPLES });
    expect(doc.blocks.map(b => b.type)).toEqual([...WIDGETS]);
  });

  it('fills defaults and drops default-valued options', () => {
    const doc = valid({ version: 1, blocks: [
      { type: 'tabs', defaultTab: 0, tabs: [{ label: ' A ' }, { label: 'B', blocks: [p('b')] }] },
      { type: 'steps', orientation: 'vertical', connector: 'line', items: [{ title: 'Một' }] },
      { type: 'progress', items: [{ label: 'x', value: 10 }] },
      { type: 'comparison', options: [{ name: 'A' }, { name: 'B' }], features: [] },
    ] });
    const [tabs, steps, progress, comparison] = doc.blocks;
    expect(tabs).toMatchObject({ type: 'tabs', tabs: [{ label: 'A', blocks: [] }, { label: 'B' }] });
    expect(tabs).not.toHaveProperty('defaultTab');
    expect(steps).toMatchObject({ type: 'steps', variant: 'steps', items: [{ title: 'Một', blocks: [] }] });
    expect(steps).not.toHaveProperty('orientation');
    expect(steps).not.toHaveProperty('connector');
    expect(progress).toMatchObject({ type: 'progress', variant: 'bar' });
    expect(comparison).not.toHaveProperty('features');
  });

  it('rejects malformed tabs', () => {
    expect(errorsOf([{ type: 'tabs', tabs: [{ label: 'only' }] }])).toContain('must contain 2–8 tabs');
    expect(errorsOf([{ type: 'tabs', tabs: Array.from({ length: 9 }, (_, i) => ({ label: `t${i}` })) }])).toContain('must contain 2–8 tabs');
    expect(errorsOf([{ type: 'tabs', defaultTab: 2, tabs: [{ label: 'a' }, { label: 'b' }] }])).toContain('defaultTab');
    expect(errorsOf([{ type: 'tabs', tabs: [{ label: '' }, { label: 'b' }] }])).toContain('tabs[0].label');
    expect(errorsOf([{ type: 'tabs', tabs: [{ label: 'a\nb' }, { label: 'b' }] }])).toContain('one line');
    expect(errorsOf([{ type: 'tabs', level: 5, tabs: [{ label: 'a' }, { label: 'b' }] }])).toContain('level');
    expect(errorsOf([{ type: 'tabs', tabs: [{ label: 'a', anchor: 'Bad Anchor' }, { label: 'b' }] }])).toContain('lowercase slug');
    expect(errorsOf([{ type: 'tabs', tabs: [{ label: 'a', anchor: 'main' }, { label: 'b' }] }])).toContain('used by the article page');
  });

  it('shares one anchor namespace between sections and tabs', () => {
    const dup = errorsOf([
      { type: 'section', anchor: 'gia', blocks: [p('x')] },
      { type: 'tabs', tabs: [{ label: 'a', anchor: 'gia' }, { label: 'b' }] },
    ]);
    expect(dup).toContain('tabs[0].anchor');
    expect(errorsOf([{ type: 'tabs', tabs: [{ label: 'a', anchor: 'x' }, { label: 'b', anchor: 'x' }] }])).toContain('tabs[1].anchor');
  });

  it('keeps a stored tabs block and drops only an unusable anchor', () => {
    const stored = readStoredDocument({ version: 1, blocks: [
      { id: 'b_t', type: 'tabs', tabs: [{ label: 'a', anchor: 'Not OK', blocks: [p('kept')] }, { label: 'b', blocks: [] }] },
    ] });
    if (!stored) throw new Error('expected a readable document');
    const tabs = stored.doc.blocks[0];
    expect(tabs?.type).toBe('tabs');
    if (tabs?.type === 'tabs') expect(tabs.tabs[0]).not.toHaveProperty('anchor');
    expect(documentText(stored.doc)).toContain('kept');
  });

  it('rejects malformed stats', () => {
    expect(errorsOf([{ type: 'stat', items: [] }])).toContain('must contain 1–8 items');
    expect(errorsOf([{ type: 'stat', items: [{ label: 'x', value: 'NaN' }] }])).toContain('finite number');
    expect(errorsOf([{ type: 'stat', items: [{ label: 'x', value: 1e16 }] }])).toContain('finite number');
    expect(errorsOf([{ type: 'stat', items: [{ label: 'x', value: 1, decimals: 5 }] }])).toContain('decimals');
    expect(errorsOf([{ type: 'stat', items: [{ label: 'x', value: 1, sparkline: [1] }] }])).toContain('sparkline');
    expect(errorsOf([{ type: 'stat', items: [{ label: 'x', value: 1, trend: 'sideways' }] }])).toContain('trend');
    expect(errorsOf([{ type: 'stat', items: [{ label: 'x', value: 1, delta: { value: Infinity } }] }])).toContain('delta.value');
  });

  it('rejects malformed steps and comparisons', () => {
    expect(errorsOf([{ type: 'steps', items: [] }])).toContain('items');
    expect(errorsOf([{ type: 'steps', variant: 'zigzag', items: [{ title: 'a' }] }])).toContain('variant');
    expect(errorsOf([{ type: 'steps', items: [{ title: 'a', status: 'late' }] }])).toContain('status');
    expect(errorsOf([{ type: 'steps', items: [{ title: 'a', icon: 'not-an-icon' }] }])).toContain('icon');
    expect(errorsOf([{ type: 'comparison', options: [{ name: 'a' }] }])).toContain('must contain 2–4 options');
    expect(errorsOf([{ type: 'comparison', options: Array.from({ length: 5 }, (_, i) => ({ name: `o${i}` })) }])).toContain('must contain 2–4 options');
    expect(errorsOf([{ type: 'comparison', options: [{ name: 'a', highlight: true }, { name: 'b', highlight: true }] }])).toContain('at most one option');
    expect(errorsOf([{ type: 'comparison', options: [{ name: 'a' }, { name: 'b' }], features: [{ label: 'f', values: [true] }] }])).toContain('one value per option');
    expect(errorsOf([{ type: 'comparison', options: [{ name: 'a' }, { name: 'b' }], features: [{ label: 'f', values: [true, 3] }] }])).toContain('values[1]');
  });

  it('rejects progress values outside the scale and bad scale settings', () => {
    const item = [{ label: 'x', value: 50 }];
    expect(errorsOf([{ type: 'progress', items: [{ label: 'x', value: 101 }] }])).toContain('between 0 and 100');
    expect(errorsOf([{ type: 'progress', min: 10, max: 10, items: item }])).toContain('greater than min');
    expect(errorsOf([{ type: 'progress', variant: 'rating', max: 11, items: [{ label: 'x', value: 3 }] }])).toContain('number of stars');
    expect(errorsOf([{ type: 'progress', variant: 'rating', min: 1, items: [{ label: 'x', value: 3 }] }])).toContain('starts at 0');
    expect(errorsOf([{ type: 'progress', variant: 'rating', items: [{ label: 'x', value: 6 }] }])).toContain('between 0 and 5');
    expect(errorsOf([{ type: 'progress', segments: 4, items: item }])).toContain('only applies to the segments variant');
    expect(errorsOf([{ type: 'progress', variant: 'segments', segments: 21, items: item }])).toContain('segments');
    expect(errorsOf([{ type: 'progress', thresholds: [{ at: 50, state: 'positive' }, { at: 50, state: 'warning' }], items: item }])).toContain('ascending');
    expect(errorsOf([{ type: 'progress', thresholds: [{ at: 50 }], items: item }])).toContain('state');
  });
});

describe('composition widget nesting', () => {
  const tabsWith = (inner: unknown) => ({ type: 'tabs', tabs: [{ label: 'a', blocks: [inner] }, { label: 'b' }] });

  it('allows ordinary blocks and cards inside items but no item widget in an item widget', () => {
    expect(errorsOf([tabsWith({ type: 'card', title: 'c', blocks: [p('x')] })])).toBe('');
    expect(errorsOf([tabsWith({ type: 'stat', items: [{ label: 's', value: 1 }] })])).toBe('');
    expect(errorsOf([tabsWith({ type: 'layout', variant: 'columns', cols: { base: 1, md: 2, lg: 2 }, children: [{ blocks: [p('x')] }] })])).toBe('');
    expect(errorsOf([tabsWith(TABS_EXAMPLE)])).toContain('may not contain a tabs');
    expect(errorsOf([tabsWith(STEPS_EXAMPLE)])).toContain('may not contain a steps');
    expect(errorsOf([{ type: 'steps', items: [{ title: 'a', blocks: [COMPARISON_EXAMPLE] }] }])).toContain('may not contain a comparison');
    // Also through a layout or card inside the item.
    expect(errorsOf([tabsWith({ type: 'card', title: 'c', blocks: [STEPS_EXAMPLE] })])).toContain('may not contain a steps');
    expect(errorsOf([tabsWith({ type: 'section', blocks: [] })])).toContain('top level');
  });

  it('keeps tabs out of toggles and lets widgets sit in sections, cards and layouts', () => {
    expect(errorsOf([{ type: 'toggle', summary: 's', blocks: [TABS_EXAMPLE] }])).toContain('toggle may not contain a tabs');
    expect(errorsOf([{ type: 'toggle', summary: 's', blocks: [STAT_EXAMPLE, PROGRESS_EXAMPLE] }])).toBe('');
    expect(errorsOf([{ type: 'section', blocks: [TABS_EXAMPLE] }])).toBe('');
    expect(errorsOf([{ type: 'card', title: 'c', blocks: [COMPARISON_EXAMPLE] }])).toBe('');
  });

  it('shares the nesting rules with the Studio block menu and creates valid widgets', () => {
    const root = { layoutDepth: 0, inToggle: false, slug: '' };
    expect(editorInternals.allowedTypes(root)).toEqual(expect.arrayContaining([...WIDGETS]));
    const inItem = { ...root, ...childContext(ROOT_CONTEXT, 'widget') };
    const allowed = editorInternals.allowedTypes(inItem);
    for (const t of ['tabs', 'steps', 'comparison', 'section'] as const) expect(allowed).not.toContain(t);
    for (const t of ['stat', 'progress', 'card', 'paragraph'] as const) expect(allowed).toContain(t);
    expect(canContain(childContext(ROOT_CONTEXT, 'toggle'), 'tabs')).toBe(false);
    for (const t of WIDGETS) {
      const b = editorInternals.newBlock(t);
      expect(b?.type).toBe(t);
      expect(errorsOf([b])).toBe('');
    }
    expect(editorInternals.matchTypes(editorInternals.CREATABLE, 'kpi')).toContain('stat');
    expect(editorInternals.matchTypes(editorInternals.CREATABLE, 'timeline')).toContain('steps');
  });

  it('walks into widget item blocks', () => {
    const doc = valid({ version: 1, blocks: EXAMPLES });
    const types: string[] = [];
    walkBlocks(doc.blocks, b => { types.push(b.type); });
    expect(types.filter(t => t === 'code')).toHaveLength(2);
    expect(types.filter(t => t === 'paragraph')).toHaveLength(2);
  });
});

describe('composition widget server rendering (no JavaScript)', () => {
  const doc = valid({ version: 1, blocks: EXAMPLES });

  it('renders every tab panel under its heading, without a tab list', () => {
    const out = html(doc);
    expect(out).toContain('class="zb-tabs zb-tabs-static"');
    expect(out).toContain('<section class="zb-tab-panel" id="cai-dat-npm"><h3 class="zb-tab-heading">npm</h3>');
    expect(out).toContain('<section class="zb-tab-panel" id="cai-dat-bun"><h3 class="zb-tab-heading">bun</h3>');
    expect(out).toContain('bun add zuey');
    expect(out).not.toContain('role="tablist"');
    expect(out).not.toContain(' hidden=');
    const level = valid({ version: 1, blocks: [{ ...TABS_EXAMPLE, id: 'b_t', level: 2, tabs: [{ label: 'x' }, { label: 'y' }] }] });
    expect(html(level)).toContain('<section class="zb-tab-panel" id="b_t-panel-0"><h2 class="zb-tab-heading">x</h2>');
  });

  it('renders stats with locale-aware numbers, a signed delta and text for the trend and sparkline', () => {
    const vi = html(doc);
    expect(vi).toContain('<dd class="zb-stat-value">$1.250.000</dd>');
    expect(vi).toContain('+12,5%');
    expect(vi).toContain('-0,4 điểm');
    expect(vi).toContain('48.200 người');
    expect(vi).toContain('<span class="zb-sr-only">Tăng: </span>');
    expect(vi).toContain('Xu hướng 4 điểm, thấp nhất 820.000, cao nhất 1.250.000, gần nhất 1.250.000');
    expect(vi).toContain('zb-stat-item zb-state-positive');
    const en = html(doc, 'en');
    expect(en).toContain('<dd class="zb-stat-value">$1,250,000</dd>');
    expect(en).toContain('+12.5%');
    expect(en).toContain('<span class="zb-sr-only">Up: </span>');
  });

  it('renders steps as an ordered list with the current step marked and visible status text', () => {
    const out = html(doc);
    expect(out).toContain('<ol class="zb-steps zb-steps-timeline zb-steps-vertical">');
    expect(out).toContain('aria-current="step"');
    expect(out).toContain('Đang thực hiện');
    expect(out).toContain('Q1 2026');
    expect(html(doc, 'en')).toContain('Upcoming');
  });

  it('renders comparisons with a recommended option and yes/no text in the matrix', () => {
    const out = html(doc);
    expect(out).toContain('zb-compare-option zb-compare-highlight');
    expect(out).toContain('<span class="zb-badge">Phổ biến</span>');
    expect(out).toContain('<span class="zb-sr-only"> (Đề xuất)</span>');
    expect(out).toContain('<th scope="row">Bài viết trả phí</th>');
    expect(out).toContain('<span class="zb-sr-only">Không</span>');
    expect(out).toContain('Ưu tiên');
    expect(html(doc, 'en')).toContain('<span class="zb-sr-only">No</span>');
  });

  it('renders progress as labelled meters with the state in text', () => {
    const out = html(doc);
    expect(out).toContain('role="meter"');
    expect(out).toContain('aria-valuenow="80" aria-valuemin="0" aria-valuemax="100" aria-valuetext="80%, Tốt"');
    expect(out).toContain('aria-valuetext="55%, Cần chú ý"');
    expect(out).toContain('style="width:80.00%"');
    const rating = valid({ version: 1, blocks: [{ id: 'b_r', type: 'progress', variant: 'rating', decimals: 1, items: [{ label: 'Điểm', value: 4.5 }] }] });
    const r = html(rating);
    expect(r).toContain('aria-valuetext="4,5 trên 5 sao"');
    expect((r.match(/class="zb-star"/g) ?? []).length).toBe(5);
    expect(html(rating, 'en')).toContain('aria-valuetext="4.5 out of 5 stars"');
    const gauge = valid({ version: 1, blocks: [{ id: 'b_g', type: 'progress', variant: 'gauge', items: [{ label: 'g', value: 25 }] }] });
    expect(html(gauge)).toContain('stroke-dasharray="25.00 100"');
    const seg = valid({ version: 1, blocks: [{ id: 'b_s', type: 'progress', variant: 'segments', segments: 4, items: [{ label: 's', value: 50 }] }] });
    expect((html(seg).match(/zb-seg zb-seg-on/g) ?? []).length).toBe(2);
  });
});

describe('composition widget export', () => {
  const doc = valid({ version: 1, blocks: EXAMPLES });

  it('formats numbers deterministically', () => {
    expect(canonicalNumber(-0.0001, 2)).toBe('0.00');
    expect(localeNumber(1234567.891, 2, 'vi')).toBe('1.234.567,89');
    expect(localeNumber(1234567.891, 2, 'en')).toBe('1,234,567.89');
    expect(localeNumber(-1234, 0, 'vi')).toBe('-1.234');
    const bar = { id: 'x', type: 'progress', variant: 'bar', items: [] } as const;
    expect(progressText({ ...bar, items: [] }, { label: 'a', value: 72 }, canonicalNumber)).toBe('72%');
    expect(progressText({ ...bar, max: 200, suffix: ' pts', items: [] }, { label: 'a', value: 72 }, canonicalNumber)).toBe('72 pts / 200 pts');
  });

  it('writes Markdown with every tab, the stats, steps, a comparison table and progress values', () => {
    const md = documentToMarkdown(doc, { articleUrl: 'https://zuey.me/articles/demo' });
    expect(md).toContain('### npm\n\n```bash\nnpm install zuey\n```\n\n### bun');
    expect(md).toContain('- **Doanh thu: $1250000 (+12.5% so với quý 2, up)** · trend 820000 → 940000 → 1100000 → 1250000');
    expect(md).toContain('**1. Thiết kế** · Q1 2026 · ✓ done');
    expect(md).toContain('### Knowledges · Phổ biến (recommended)');
    expect(md).toContain('- ✓ Đọc toàn bộ');
    expect(md).toMatch(/\| Bài viết trả phí \| No \| Yes \|/);
    expect(md).toContain('- **Frontend:** 55% — Còn trang thanh toán');
  });

  it('indexes search and AI text from labels and canonical values', () => {
    const text = documentText(doc);
    for (const s of ['npm', 'bun add zuey', 'Doanh thu', '1250000', '$1250000', 'Thiết kế', 'Q2 2026', 'Knowledges', 'Hỏi Zuey AI', 'Ưu tiên', 'Backend', '80%']) {
      expect(text).toContain(s);
    }
    const ai = aiDocumentText(doc);
    for (const s of ['Tabs: npm | bun', 'Doanh thu: $1250000 (+12.5% so với quý 2, up), range 820000–1250000', 'Timeline: 1. Thiết kế (Q1 2026) [done]',
      'Knowledges (recommended) [Phổ biến]', 'Bài viết trả phí: Miễn phí No, Knowledges Yes', 'Tiến độ dự án (bar on 0–100): Backend 80%']) {
      expect(ai).toContain(s);
    }
  });

  it('renders the widgets in the article email', () => {
    const email = renderArticleEmail({
      locale: 'vi', title: 'Demo', excerpt: 'Tóm tắt', access: 'free', coverUrl: null, document: doc,
      articleUrl: 'https://zuey.me/articles/demo', pricingUrl: 'https://zuey.me/pricing', siteUrl: 'https://zuey.me', mode: 'full',
    });
    for (const s of ['npm', 'bun add zuey', '$1.250.000', '+12,5%', 'Thiết kế', 'Đang thực hiện', 'Knowledges', 'Bài viết trả phí', '80%']) {
      expect(email.html).toContain(s);
    }
    for (const s of ['npm', 'Doanh thu', 'Thiết kế', 'Knowledges', 'Backend']) expect(email.text).toContain(s);
  });

  it('keeps a fractional value exact in every output when decimals is not set', () => {
    expect(canonicalNumber(4.5)).toBe('4.5');
    expect(canonicalNumber(2)).toBe('2');
    expect(canonicalNumber(1.23456)).toBe('1.2346');
    expect(canonicalNumber(-0.00001)).toBe('0');
    expect(localeNumber(1250.5, undefined, 'vi')).toBe('1.250,5');
    const rated = valid({ version: 1, blocks: [{ id: 'b_r', type: 'progress', variant: 'rating', items: [{ label: 'Điểm', value: 4.5 }] }] });
    const page = html(rated);
    expect(page).toContain('aria-valuetext="4,5 trên 5 sao"');
    expect(page).toContain('<span class="zb-progress-value">4,5 / 5</span>');
    expect(html(rated, 'en')).toContain('aria-valuetext="4.5 out of 5 stars"');
    expect(documentToMarkdown(rated, { articleUrl: 'https://zuey.me/articles/demo' })).toContain('- **Điểm:** 4.5 / 5 ★');
    expect(documentText(rated)).toContain('4.5 / 5');
    expect(aiDocumentText(rated)).toContain('Điểm 4.5 / 5');
    const email = renderArticleEmail({
      locale: 'vi', title: 'Demo', excerpt: 'Tóm tắt', access: 'free', coverUrl: null, document: rated,
      articleUrl: 'https://zuey.me/articles/demo', pricingUrl: 'https://zuey.me/pricing', siteUrl: 'https://zuey.me', mode: 'full',
    });
    expect(email.html).toContain('<strong>4,5 / 5</strong>');
    // A partial star cannot be clipped in email, so it shows empty instead of rounding the rating up.
    expect(email.html).toContain('★★★★☆<');
    expect(email.text).toContain('Điểm: 4,5 / 5');
    // A stat without decimals keeps its own precision too.
    const stat = valid({ version: 1, blocks: [{ id: 'b_s', type: 'stat', items: [{ label: 'Churn', value: 2.15, suffix: '%' }] }] });
    expect(html(stat, 'en')).toContain('2.15%');
    expect(aiDocumentText(stat)).toContain('Churn: 2.15%');
  });

  it('publishes the schemas in OpenAPI and the MCP block schema', async () => {
    for (const t of WIDGETS) {
      const name = `Block${t[0].toUpperCase()}${t.slice(1)}`;
      expect(blockSchemas).toHaveProperty(name);
    }
    expect(JSON.stringify(articlesOpenApi)).toContain('BlockComparison');
    const view = await describeBlockSchema({ types: [...WIDGETS], include: ['schemas', 'examples', 'rules'] });
    const json = JSON.stringify(view);
    for (const t of WIDGETS) expect(json).toContain(`"${t}"`);
    expect(json).toContain('Composition widgets');
  });
});

describe('paywall with composition widgets', () => {
  const long = (n: number) => 'chữ '.repeat(n).trim();
  const anon = { isAdmin: false, entitlements: [] };

  it('splits tabs item by item instead of leaking every panel', () => {
    const doc = valid({ version: 1, blocks: [{
      type: 'tabs', defaultTab: 2, tabs: [
        { label: 'Một', blocks: [p(long(200))] },
        { label: 'Hai', blocks: [p(long(200))] },
        { label: 'Ba', blocks: [p(long(200))] },
      ],
    }] });
    const res = applyPaywall(doc, 'knowledges', anon);
    expect(res.truncated).toBe(true);
    const tabs = res.doc.blocks[0];
    expect(tabs?.type).toBe('tabs');
    if (tabs?.type !== 'tabs') return;
    expect(tabs.tabs.map(t => t.label)).toEqual(['Một']);
    // The withheld default tab is not referenced by index.
    expect(tabs).not.toHaveProperty('defaultTab');
    expect(validateDocument(res.doc).ok).toBe(false); // one tab is below the minimum; the reader renders stored documents leniently
  });

  it('keeps the comparison matrix to the kept options and keeps empty items as shells', () => {
    const doc = valid({ version: 1, blocks: [{
      type: 'comparison', features: [{ label: 'f', values: ['A1', 'B1', 'C1'] }], options: [
        { name: 'A', pros: ['nhanh'] },
        { name: 'B', blocks: [p(long(300))] },
        { name: 'C', blocks: [p(long(300))] },
      ],
    }] });
    const res = applyPaywall(doc, 'knowledges', anon);
    expect(res.truncated).toBe(true);
    const cmp = res.doc.blocks[0];
    if (cmp?.type !== 'comparison') throw new Error('expected a comparison');
    expect(cmp.options.map(o => o.name)).toEqual(['A', 'B']);
    expect(cmp.options[0].pros).toEqual(['nhanh']);
    expect(cmp.features?.[0].values).toEqual(['A1', 'B1']);
    expect(JSON.stringify(res.doc)).not.toContain('C1');
  });

  it('treats stat and progress as single units and shows everything to members', () => {
    const doc = valid({ version: 1, blocks: [STAT_EXAMPLE, p(long(300)), PROGRESS_EXAMPLE] });
    const res = applyPaywall(doc, 'knowledges', anon);
    expect(res.doc.blocks.map(b => b.type)).toEqual(['stat', 'paragraph']);
    expect(applyPaywall(doc, 'knowledges', { isAdmin: false, entitlements: ['read_full'] }).truncated).toBe(false);
  });

  it('cuts inside a step body and keeps the step title', () => {
    const doc = valid({ version: 1, blocks: [{
      type: 'steps', items: [
        { title: 'Bước đầu', blocks: [p(long(150)), p(long(150)), p(long(150))] },
        { title: 'Bước sau', blocks: [p(long(150))] },
      ],
    }] });
    const res = applyPaywall(doc, 'knowledges', anon);
    const steps = res.doc.blocks[0];
    if (steps?.type !== 'steps') throw new Error('expected steps');
    expect(steps.items.map(i => i.title)).toEqual(['Bước đầu']);
    expect(steps.items[0].blocks.length).toBeLessThan(3);
    expect(res.outline?.blocks).toBeGreaterThan(0);
  });
});

describe('widget styles', () => {
  const css = readFileSync(new URL('../src/styles/blocks.css', import.meta.url), 'utf8');
  const start = css.indexOf('/* Composition widgets');

  it('animates only inside prefers-reduced-motion: no-preference', () => {
    expect(start).toBeGreaterThan(0);
    const widgets = css.slice(start);
    const media = widgets.indexOf('@media (prefers-reduced-motion: no-preference)');
    expect(media).toBeGreaterThan(0);
    const outside = widgets.slice(0, media);
    expect(outside).not.toMatch(/\b(animation|transition)\s*:/);
    const inside = widgets.slice(media, widgets.indexOf('@keyframes'));
    expect(inside).toMatch(/animation\s*:/);
  });

  it('keeps hidden tab panels hidden and stacks horizontal steps on phones', () => {
    expect(css).toContain('.zb-tab-panel[hidden] { display: none; }');
    expect(css).toMatch(/@media \(min-width: 768px\) \{\s*\.zb-steps-horizontal \{ flex-direction: row/);
  });
});

describe('localization covers widget text', () => {
  it('lists widget strings for translation and merges them back', async () => {
    const doc = valid({ version: 1, blocks: EXAMPLES });
    const src = { title: 'T', excerpt: 'E', document: doc };
    const { entries } = await buildManifest(src);
    const fields = entries.map(e => e.field_path);
    for (const path of ['tabs[0].label', 'items[0].label', 'items[0].delta.label', 'items[1].note', 'items[0].title', 'items[0].date', 'options[1].badge', 'options[1].pros[1]', 'features[2].values[0]']) {
      expect(fields).toContain(path);
    }
    // Booleans in the matrix are not text.
    expect(fields).not.toContain('features[0].values[0]');
    const tabLabel = entries.find(e => e.field_path === 'tabs[0].label');
    if (!tabLabel) throw new Error('missing tab label entry');
    const merged = mergeTranslations(src, entries, { [tabLabel.key]: 'npm (EN)' });
    const first: Block | undefined = merged.document.blocks[0];
    expect(first?.type === 'tabs' ? first.tabs[0].label : '').toBe('npm (EN)');
  });
});
