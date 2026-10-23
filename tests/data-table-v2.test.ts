import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { documentText as aiDocumentText } from '../src/lib/ai/context';
import { documentToMarkdown } from '../src/lib/blocks/markdown';
import { blockSchemas } from '../src/lib/blocks/openapi';
import { applyPaywall, blockWeight } from '../src/lib/blocks/paywall';
import { documentTranslatables } from '../src/lib/blocks/read-modes';
import { describeBlockSchema } from '../src/lib/blocks/schema-view';
import type { ArticleDocument, Block, TableBlock } from '../src/lib/blocks/schema';
import {
  canonicalCell, csvField, csvFilename, filterChoices, foldText, formatCell, formatNumber, isDataTable, linkCell, tableCsv, visibleRows,
} from '../src/lib/blocks/table-data';
import { readStoredDocument, validateDocument } from '../src/lib/blocks/validate';
import { renderArticleEmail } from '../src/lib/notifications/article-email-render';
import { documentText } from '../src/lib/search/text';

// `import.meta.env.SSR` is the live process.env in Bun: the renderer takes the static (server) data table path only when it is set.
const previousSsr = process.env.SSR;
let BlockRenderer: typeof import('../src/components/blocks/BlockRenderer').BlockRenderer;
beforeAll(async () => {
  process.env.SSR = 'true';
  ({ BlockRenderer } = await import('../src/components/blocks/BlockRenderer'));
});
afterAll(() => {
  if (previousSsr === undefined) delete process.env.SSR;
  else process.env.SSR = previousSsr;
});

const PRICES = {
  type: 'table',
  title: 'Bảng giá',
  caption: 'Giá **đã gồm** VAT.',
  headers: ['Gói', 'Giá', 'Giảm', 'Ra mắt', 'Hỗ trợ', 'Chi tiết', 'Nhãn'],
  columns: [
    { type: 'text' }, { type: 'currency', currency: 'VND', filter: true }, { type: 'percent', decimals: 1 }, { type: 'date', filter: true },
    { type: 'boolean', filter: true }, { type: 'link' }, { type: 'badge', filter: true },
  ],
  rows: [
    ['**Pro**', '490000', '12.5', '2026-01-15', 'true', '[Xem gói](https://zuey.me/pricing)', 'Phổ biến'],
    ['Cơ bản', '190000', '0', '2025-06', 'false', 'https://zuey.me/pricing', 'Mới'],
    ['Hà Nội', '', '5', '2024', 'TRUE', '', ''],
  ],
  sortable: true, search: true, stickyHeader: true, csv: true, mobile: 'cards',
};

function valid(blocks: unknown[]): Block[] {
  const res = validateDocument({ version: 1, blocks });
  if (!res.ok) throw new Error(JSON.stringify(res.errors));
  return res.doc.blocks;
}

function table(extra: Record<string, unknown> = {}): TableBlock {
  const [b] = valid([{ ...PRICES, ...extra }]);
  if (b?.type !== 'table') throw new Error('not a table');
  return b;
}

function errorsOf(extra: Record<string, unknown>): string[] {
  const res = validateDocument({ version: 1, blocks: [{ ...PRICES, ...extra }] });
  return res.ok ? [] : res.errors.map(e => `${e.path}: ${e.message}`);
}

function render(blocks: Block[]): string {
  return renderToStaticMarkup(createElement(BlockRenderer, { doc: { version: 1, blocks }, interactive: false }));
}

const LEGACY: TableBlock = { id: 't1', type: 'table', headers: ['A', 'B'], rows: [['**x**', '=1+1'], ['y', 'z']] };

describe('data table validation', () => {
  it('accepts typed columns and options and normalises boolean case', () => {
    const b = table();
    expect(b.columns?.[1]).toEqual({ type: 'currency', currency: 'VND', filter: true });
    expect(b.rows[2]?.[4]).toBe('true');
    expect(b.sortable).toBe(true);
    expect(b.mobile).toBe('cards');
    expect(isDataTable(b)).toBe(true);
  });

  it('keeps legacy tables unchanged and not data tables', () => {
    const [b] = valid([LEGACY]);
    expect(b).toEqual(LEGACY);
    if (b?.type !== 'table') throw new Error('not a table');
    expect(isDataTable(b)).toBe(false);
  });

  it('drops columns when every column is plain text', () => {
    const [b] = valid([{ ...LEGACY, columns: [{ type: 'text' }, {}] }]);
    expect(b).toEqual(LEGACY);
  });

  it('rejects bad typed cells with their path', () => {
    const errs = errorsOf({ rows: [['a', '12abc', '1', '2026-13-01', 'yes', 'javascript:alert(1)', 'x']] });
    expect(errs.some(e => e.includes('rows[0][1]'))).toBe(true);
    expect(errs.some(e => e.includes('rows[0][3]'))).toBe(true);
    expect(errs.some(e => e.includes('rows[0][4]'))).toBe(true);
    expect(errs.some(e => e.includes('rows[0][5]'))).toBe(true);
  });

  it('rejects invalid column definitions and options', () => {
    expect(errorsOf({ columns: [{ type: 'text' }] }).some(e => e.includes('.columns'))).toBe(true);
    expect(errorsOf({ columns: PRICES.columns.map((c, i) => (i === 1 ? { type: 'currency' } : c)) }).some(e => e.includes('columns[1]'))).toBe(true);
    expect(errorsOf({ columns: PRICES.columns.map((c, i) => (i === 0 ? { type: 'text', decimals: 2 } : c)) }).some(e => e.includes('columns[0]'))).toBe(true);
    expect(errorsOf({ columns: PRICES.columns.map((c, i) => (i === 0 ? { type: 'emoji' } : c)) }).some(e => e.includes('columns[0]'))).toBe(true);
    expect(errorsOf({ mobile: 'grid' }).some(e => e.includes('mobile'))).toBe(true);
    expect(errorsOf({ sortable: 'yes' }).some(e => e.includes('sortable'))).toBe(true);
  });

  it('caps cell length on data tables only', () => {
    const long = 'x'.repeat(1001);
    expect(errorsOf({ rows: [[long, '', '', '', '', '', '']] }).some(e => e.includes('rows[0][0]'))).toBe(true);
    expect(valid([{ ...LEGACY, rows: [[long, 'b']] }])).toHaveLength(1);
  });

  it('lenient stored reads drop an invalid data table and keep the rest', () => {
    const read = readStoredDocument({ version: 1, blocks: [{ ...PRICES, id: 'bad', rows: [['a', 'NaN', '', '', '', '', '']] }, LEGACY] });
    expect(read?.dropped).toBe(1);
    expect(read?.doc.blocks.map(b => b.id)).toEqual(['t1']);
  });
});

describe('table data helpers', () => {
  it('formats numbers, currency, percent, dates, booleans and links', () => {
    expect(formatNumber('1234567.5')).toBe('1.234.567,5');
    expect(formatNumber('-0.04', 1)).toBe('0,0');
    expect(formatCell({ type: 'currency', currency: 'VND' }, '490000')).toBe('490.000 ₫');
    expect(formatCell({ type: 'currency', currency: 'USD', decimals: 2 }, '-12.5')).toBe('-$12,50');
    expect(formatCell({ type: 'currency', currency: 'CHF' }, '10')).toBe('10 CHF');
    expect(formatCell({ type: 'percent', decimals: 1 }, '12.5')).toBe('12,5%');
    expect(formatCell({ type: 'date' }, '2026-01-15')).toBe('15/01/2026');
    expect(formatCell({ type: 'date' }, '2025-06')).toBe('06/2025');
    expect(formatCell({ type: 'boolean' }, 'false')).toBe('Không');
    expect(formatCell({ type: 'link' }, '[Xem](https://zuey.me)')).toBe('Xem');
    expect(formatCell({ type: 'text' }, '**Pro**')).toBe('Pro');
  });

  it('canonicalises and rejects typed values', () => {
    expect(canonicalCell('boolean', 'FALSE')).toBe('false');
    expect(canonicalCell('number', '1e5')).toBeNull();
    expect(canonicalCell('date', '2026-02-30')).toBeNull();
    expect(canonicalCell('number', '')).toBe('');
    expect(linkCell('http://insecure.example')).toBeNull();
    expect(linkCell('https://zuey.me')).toEqual({ href: 'https://zuey.me', label: 'zuey.me' });
  });

  it('searches without diacritics and requires every word', () => {
    const b = table();
    expect(foldText('Hà Nội Đà')).toBe('ha noi da');
    expect(visibleRows(b, { query: 'ha noi', filters: {}, sort: null })).toEqual([2]);
    expect(visibleRows(b, { query: 'pro 490.000', filters: {}, sort: null })).toEqual([0]);
    expect(visibleRows(b, { query: 'pro moi', filters: {}, sort: null })).toEqual([]);
  });

  it('sorts numbers and dates by value with empty cells last in both directions', () => {
    const b = table();
    expect(visibleRows(b, { query: '', filters: {}, sort: { column: 1, dir: 'asc' } })).toEqual([1, 0, 2]);
    expect(visibleRows(b, { query: '', filters: {}, sort: { column: 1, dir: 'desc' } })).toEqual([0, 1, 2]);
    expect(visibleRows(b, { query: '', filters: {}, sort: { column: 3, dir: 'asc' } })).toEqual([2, 1, 0]);
    expect(visibleRows(b, { query: '', filters: {}, sort: { column: 0, dir: 'asc' } })).toEqual([1, 2, 0]);
  });

  it('filters by value, range and partial date', () => {
    const b = table();
    expect(visibleRows(b, { query: '', filters: { 4: { kind: 'value', value: 'true' } }, sort: null })).toEqual([0, 2]);
    expect(visibleRows(b, { query: '', filters: { 1: { kind: 'range', min: '200000', max: '' } }, sort: null })).toEqual([0]);
    expect(visibleRows(b, { query: '', filters: { 3: { kind: 'range', min: '2025-01-01', max: '2025-12-31' } }, sort: null })).toEqual([1]);
    expect(filterChoices(b, 6)).toEqual(['Mới', 'Phổ biến']);
  });

  it('escapes CSV fields and neutralises formulas', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    for (const f of ['=SUM(A1)', '+1', '-2+3', '@cmd', '\tx', '\rx']) expect(csvField(f).replace(/^"/, '').startsWith("'")).toBe(true);
    expect(csvField('-12.5', true)).toBe('-12.5');
    expect(csvField('-12.5')).toBe("'-12.5");
  });

  it('exports the visible rows with headers, raw values and link URLs', () => {
    const b = table();
    const csv = tableCsv(b, [1, 0]);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('Gói,Giá,Giảm,Ra mắt,Hỗ trợ,Chi tiết,Nhãn');
    expect(lines[1]).toBe('Cơ bản,190000,0,2025-06,false,https://zuey.me/pricing,Mới');
    expect(lines[2]).toBe('Pro,490000,12.5,2026-01-15,true,https://zuey.me/pricing,Phổ biến');
    expect(csvFilename(b)).toBe('bang-gia.csv');
    expect(csvFilename(table({ title: undefined }))).toMatch(/^table-.+\.csv$/);
  });
});

describe('data table rendering', () => {
  it('renders the legacy table markup unchanged', () => {
    const html = render(valid([LEGACY]));
    expect(html).toBe('<div class="zb-doc"><div class="zb-scroll"><table class="zb-table"><thead><tr><th scope="col">A</th><th scope="col">B</th></tr></thead><tbody><tr><td><span><strong>x</strong></span></td><td><span>=1+1</span></td></tr><tr><td><span>y</span></td><td><span>z</span></td></tr></tbody></table></div></div>');
  });

  it('server-renders every row with formatted values and no interactive controls', () => {
    const html = render([table()]);
    for (const text of ['490.000 ₫', '12,5%', '15/01/2026', '06/2025', 'Xem gói', 'Phổ biến', 'Hà Nội', '<strong>Pro</strong>']) expect(html).toContain(text);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('aria-sort');
    expect(html).toContain('aria-labelledby="zb-dt-');
    expect(html).toContain('role="region"');
    expect(html).toContain('zb-dt-sticky');
    expect(html).toContain('data-label="Giá"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('<time dateTime="2026-01-15">');
  });

  it('escapes cell content', () => {
    const html = render([table({ rows: [['<script>x</script>', '', '', '', '', '', '<b>']] })]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;b&gt;');
  });
});

describe('data table text surfaces', () => {
  const doc: ArticleDocument = { version: 1, blocks: [table()] };

  it('writes Markdown with the title, unit-labelled headers, formatted cells and caption', () => {
    const md = documentToMarkdown(doc);
    expect(md).toContain('**Bảng giá**');
    expect(md).toContain('Giá (VND)');
    expect(md).toContain('Giảm (%)');
    expect(md).toContain('Giá **đã gồm** VAT.');
  });

  it('keeps legacy Markdown unchanged', () => {
    expect(documentToMarkdown({ version: 1, blocks: valid([LEGACY]) })).toBe('| A | B |\n| --- | --- |\n| **x** | =1+1 |\n| y | z |');
  });

  it('feeds search, AI context and paywall weight', () => {
    expect(documentText(doc)).toContain('Bảng giá');
    expect(documentText(doc)).toContain('Giá đã gồm VAT.');
    expect(aiDocumentText(doc)).toContain('Giá (VND)');
    const b = table();
    const legacyWeight = blockWeight({ ...b, title: undefined, caption: undefined });
    expect(blockWeight(b)).toBe(legacyWeight + 'Bảng giá'.length + 'Giá đã gồm VAT.'.length);
  });

  it('truncates data tables behind the paywall at top level and inside containers', () => {
    const big = (id: string): TableBlock => ({ ...table(), id, title: `T ${id}`, rows: [['x'.repeat(300), '1', '1', '2026', 'true', '', '']] });
    const top = applyPaywall({ version: 1, blocks: [big('a'), big('b'), big('c')] }, 'knowledges', { isAdmin: false, entitlements: [] });
    expect(top.truncated).toBe(true);
    expect(top.doc.blocks.map(b => b.id)).toEqual(['a']);
    const nested = applyPaywall({ version: 1, blocks: [{ id: 's', type: 'section', width: 'wide', surface: 'none', blocks: [big('a'), { id: 'k', type: 'card', variant: 'outline', blocks: [big('b'), big('c')] }] }] }, 'knowledges', { isAdmin: false, entitlements: [] });
    expect(nested.truncated).toBe(true);
    expect(JSON.stringify(nested.doc)).not.toContain('"T b"');
  });

  it('renders emails with the title, formatted cells and caption', () => {
    const html = renderArticleEmail({
      locale: 'vi', title: 'Demo', excerpt: '', access: 'free', coverUrl: null, document: doc,
      articleUrl: 'https://zuey.me/articles/demo', pricingUrl: 'https://zuey.me/pricing', siteUrl: 'https://zuey.me', mode: 'full',
    });
    const all = JSON.stringify(html);
    for (const text of ['Bảng giá', '490.000 ₫', 'https://zuey.me/pricing', 'VAT.']) expect(all).toContain(text);
  });

  it('offers only prose cells, the title and caption for translation', async () => {
    const entries = await documentTranslatables(doc);
    const texts = entries.map(e => e.source_text);
    expect(texts).toContain('Bảng giá');
    expect(texts).toContain('Phổ biến');
    expect(texts).toContain('**Pro**');
    expect(texts).not.toContain('490000');
    expect(texts).not.toContain('2026-01-15');
  });
});

describe('data table schema', () => {
  it('documents every new field in the OpenAPI schema', () => {
    const schema = JSON.stringify(blockSchemas.BlockTable);
    for (const key of ['columns', 'title', 'caption', 'sortable', 'search', 'stickyHeader', 'csv', 'mobile', 'currency', 'decimals', 'filter']) expect(schema).toContain(`"${key}"`);
  });

  it('ships a valid data_table example in the MCP block schema', async () => {
    const answer = await describeBlockSchema({ types: ['table'] });
    const examples = answer.examples;
    const example = examples && typeof examples === 'object' && 'data_table' in examples ? examples.data_table : null;
    expect(example).not.toBeNull();
    expect(validateDocument({ version: 1, blocks: [example] }).ok).toBe(true);
  });
});
