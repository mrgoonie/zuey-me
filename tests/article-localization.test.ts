import { describe, it, expect, beforeEach } from 'bun:test';
import { createTestD1 } from './helpers/d1';
import type { D1DatabaseLike } from '../src/db/store';
import type { ArticleDocument, Block } from '../src/lib/blocks/schema';
import { walkBlocks } from '../src/lib/blocks/schema';
import { createArticle, getArticle, publishArticle, updateArticle } from '../src/lib/blocks/articles';
import { applyLocalization, prepareLocalization } from '../src/lib/blocks/localization-service';
import type { ApplyResult, PrepareResult } from '../src/lib/blocks/localization-service';
import { mermaidLabels, mermaidSkeleton, placeholdersOf, scanWidgetHtml, structuralSkeleton } from '../src/lib/blocks/localization';
import { articlesMcpModule } from '../src/lib/blocks/mcp';
import type { McpContext } from '../src/lib/mcp/types';
import { TOOL_ACCESS } from '../src/lib/oauth/tool-access';
import { AppError } from '../src/lib/http';

const MERMAID = 'flowchart LR\n  A[Bắt đầu] -->|Gửi yêu cầu| B(Máy chủ)\n  B --> C{"Hợp lệ?"}\n  C -->|Có| D[[Xong]]';
const WIDGET_HTML = '<div class="calc"><h4 data-i18n="title">Máy tính chi phí</h4><button id="go" data-i18n="run">Tính</button><span id="out">0</span></div>';
const WIDGET_JS = 'document.getElementById("go").onclick = () => { document.getElementById("out").textContent = "Tổng: " + 42; };';
const WIDGET_CSS = '.calc { color: #333; } /* Màu chữ */';
const COVER = 'https://media.zuey.me/cover-1672x941.webp';

function section(i: number, blocks: Block[]): Block {
  return { id: `sec${i}`, type: 'section', width: 'prose', surface: 'none', blocks };
}

/** Ten sections with nested cards and layouts, Mermaid, a sandboxed widget and a 1672×941 image. */
function sourceDocument(): ArticleDocument {
  const blocks: Block[] = [];
  for (let i = 1; i <= 7; i++) {
    blocks.push(section(i, [
      { id: `h${i}`, type: 'heading', level: 2, text: `Phần ${i}` },
      { id: `p${i}`, type: 'paragraph', text: `Nội dung **phần ${i}** có [liên kết](https://zuey.me/p/${i}) và \`code${i}()\`.` },
    ]));
  }
  blocks.push(section(8, [
    { id: 'lay', type: 'layout', variant: 'grid', cols: { base: 1, md: 2, lg: 2 }, children: [
      { blocks: [{ id: 'card1', type: 'card', title: 'Nhanh', variant: 'soft', footer: '[Xem thêm](https://zuey.me/more)', blocks: [
        { id: 'cl', type: 'list', style: 'bullet', items: ['Một', 'Hai'] },
      ] }] },
      { blocks: [{ id: 'card2', type: 'card', title: 'An toàn', variant: 'outline', image: { url: COVER, alt: 'Ảnh bìa', width: 1672, height: 941 }, blocks: [] }] },
    ] },
    { id: 'img', type: 'image', url: COVER, alt: 'Ảnh minh hoạ', caption: 'Chú thích ảnh', width: 1672, height: 941 },
  ]));
  blocks.push(section(9, [
    { id: 'dia', type: 'diagram', syntax: 'mermaid', source: MERMAID, caption: 'Luồng xử lý' },
    { id: 'tbl', type: 'table', headers: ['Gói', 'Giá'], rows: [['Cơ bản', '$10 mỗi tháng'], ['Pro', '$30 mỗi tháng']] },
  ]));
  blocks.push(section(10, [
    { id: 'wid', type: 'interactive', title: 'Máy tính', html: WIDGET_HTML, css: WIDGET_CSS, js: WIDGET_JS, caption: 'Thử ngay' },
    { id: 'code', type: 'code', language: 'ts', code: 'const nội_dung = "không dịch";' },
  ]));
  return { version: 1, blocks };
}

function allPlaceholdersKept(entries: PrepareResult['entries']): Record<string, string> {
  return Object.fromEntries(entries.map(e => [e.key, translate(e.source_text)]));
}

/** Fake "translation": prefixes text and keeps links, code spans and tokens, as a real translator would. */
function translate(text: string): string {
  return `EN ${text}`;
}

let d1: D1DatabaseLike;
beforeEach(() => { d1 = createTestD1(); });

async function seed(slug = 'multi'): Promise<void> {
  await createArticle(d1, { slug, title: 'Bài viết gốc', excerpt: 'Tóm tắt gốc', document: sourceDocument() }, { actor: 'test' });
}

async function prepare(slug = 'multi', locales?: string[]): Promise<PrepareResult> {
  return prepareLocalization(d1, slug, locales ? { locales } : {});
}

async function apply(prep: PrepareResult, extra: Record<string, unknown> = {}, locale = 'en', translations?: Record<string, string>, slug = 'multi'): Promise<ApplyResult> {
  return applyLocalization(d1, slug, { locale, source_hash: prep.source_hash, translations: translations ?? allPlaceholdersKept(prep.entries), ...extra }, { actor: 'test' });
}

async function expectError(promise: Promise<unknown>, status: number, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    if (err instanceof AppError) {
      expect(err.status).toBe(status);
      expect(err.code).toBe(code);
      return err;
    }
  }
  throw new Error(`expected ${status} ${code}`);
}

function blockById(doc: ArticleDocument, id: string): Block {
  let found: Block | undefined;
  walkBlocks(doc.blocks, b => { if (b.id === id) found = b; });
  if (!found) throw new Error(`block ${id} not found`);
  return found;
}

describe('manifest extraction', () => {
  it('covers titles, nested card, layout, table, diagram and widget text, and nothing structural', async () => {
    await seed();
    const prep = await prepare();
    const keys = new Set(prep.entries.map(e => e.key));
    for (const key of [
      '$article#title', '$article#excerpt', 'h1#text', 'p7#text', 'card1#title', 'card1#footer', 'cl#items[1]', 'card2#image.alt',
      'img#alt', 'img#caption', 'tbl#headers[0]', 'tbl#rows[1][0]', 'tbl#rows[0][1]', 'dia#caption', 'dia#source.labels[0]', 'wid#title', 'wid#caption', 'wid#html.i18n[run]',
    ]) expect(keys.has(key)).toBe(true);
    // Never part of the manifest: code, URLs, ids, CSS, JS, widget markup.
    for (const e of prep.entries) {
      expect(e.block_id === 'code').toBe(false);
      expect(e.field_path).not.toMatch(/url|css|js|id$/);
    }
    expect(prep.entries.find(e => e.key === 'p3#text')?.constraints?.placeholders).toEqual(['`code3()`', 'https://zuey.me/p/3']);
    expect(prep.stats.entries).toBe(prep.entries.length);
    expect(prep.skipped).toEqual([]);
    expect(prep.locales.map(l => l.locale)).toEqual(['en', 'zh', 'ko', 'ja']);
    expect(prep.locales.every(l => l.state === 'missing')).toBe(true);
  });

  it('extracts Mermaid labels by position and keeps the topology as a skeleton', () => {
    const labels = mermaidLabels(MERMAID).map(l => l.text);
    expect(labels).toEqual(['Bắt đầu', 'Gửi yêu cầu', 'Máy chủ', 'Hợp lệ?', 'Có', 'Xong']);
    expect(mermaidSkeleton(MERMAID)).toBe(mermaidSkeleton(MERMAID.replace('Bắt đầu', 'Start').replace('Gửi yêu cầu', 'Send request')));
    expect(mermaidLabels('sequenceDiagram\n  A->>B: Xin chào')).toEqual([]);
  });

  it('only reads plain-text widget elements marked data-i18n and reports the rest', () => {
    const scan = scanWidgetHtml('<p data-i18n="a">Một</p><p data-i18n="a">Hai</p><p data-i18n="b">X <b>Y</b></p><i data-i18n="c">Ba</i>');
    expect(scan.texts.map(t => [t.key, t.text])).toEqual([['c', 'Ba']]);
    expect(scan.skipped.length).toBe(2);
    expect(placeholdersOf('[a](https://x.y/z) `c` {{n}} **b**')).toEqual(['`c`', 'https://x.y/z', '{{n}}']);
  });

  it('reports widgets without markers and unsupported diagrams as skipped, never guessing', async () => {
    const doc: ArticleDocument = { version: 1, blocks: [
      { id: 'w', type: 'interactive', title: 'Demo', html: '<button id="b">Bấm</button>', css: '', js: 'document.title = "Xin chào";' },
      { id: 'd', type: 'diagram', syntax: 'mermaid', source: 'sequenceDiagram\n  A->>B: Xin chào' },
    ] };
    await createArticle(d1, { slug: 'skip', title: 'T', document: doc });
    const prep = await prepare('skip');
    expect(prep.skipped.map(s => s.block_id).sort()).toEqual(['d', 'w']);
    expect(prep.entries.map(e => e.key)).toEqual(['$article#title', 'w#title']);
  });
});

describe('apply', () => {
  it('merges translations server-side and preserves ids, nesting, URLs, widget script, CSS, topology and the image', async () => {
    await seed();
    const prep = await prepare();
    const res = await apply(prep);
    expect(res.valid).toBe(true);
    expect(res.committed).toBe(true);
    expect(res.report?.coverage).toEqual({ entries: prep.entries.length, translated: prep.entries.length, percent: 100 });
    expect(res.errors).toEqual([]);
    const src = await getArticle(d1, 'multi');
    const en = await getArticle(d1, 'multi', { locale: 'en' });
    expect(en?.locale).toBe('en');
    expect(en?.title).toBe('EN Bài viết gốc');
    expect(en?.status).toBe('draft');
    expect(structuralSkeleton(en?.draft ?? { version: 1 as const, blocks: [] })).toBe(structuralSkeleton(src?.draft ?? { version: 1 as const, blocks: [] }));
    const wid = blockById(en?.draft ?? { version: 1 as const, blocks: [] }, 'wid');
    if (wid.type !== 'interactive') throw new Error('widget expected');
    expect(wid.js).toBe(WIDGET_JS);
    expect(wid.css).toBe(WIDGET_CSS);
    expect(wid.html).toContain('<h4 data-i18n="title">EN Máy tính chi phí</h4>');
    expect(wid.html).toContain('<span id="out">0</span>');
    const dia = blockById(en?.draft ?? { version: 1 as const, blocks: [] }, 'dia');
    if (dia.type !== 'diagram') throw new Error('diagram expected');
    expect(mermaidSkeleton(dia.source)).toBe(mermaidSkeleton(MERMAID));
    expect(dia.source).toContain('A[EN Bắt đầu] -->|EN Gửi yêu cầu| B(EN Máy chủ)');
    const img = blockById(en?.draft ?? { version: 1 as const, blocks: [] }, 'img');
    expect(img.type === 'image' && img.url === COVER && img.width === 1672 && img.height === 941).toBe(true);
    const code = blockById(en?.draft ?? { version: 1 as const, blocks: [] }, 'code');
    expect(code.type === 'code' && code.code === 'const nội_dung = "không dịch";').toBe(true);
    // The source edition is untouched.
    expect(src?.title).toBe('Bài viết gốc');
  });

  it('writes nothing for missing, unknown, empty or non-string entries and names each key', async () => {
    await seed();
    const prep = await prepare();
    const translations = allPlaceholdersKept(prep.entries);
    delete translations['p1#text'];
    translations['ghost#text'] = 'x';
    translations['h2#text'] = '  ';
    const before = await getArticle(d1, 'multi');
    const res = await apply(prep, {}, 'en', translations);
    expect(res.valid).toBe(false);
    expect(res.committed).toBe(false);
    const codes = Object.fromEntries(res.errors.map(e => [e.key, e.code]));
    expect(codes['p1#text']).toBe('missing_translation');
    expect(codes['ghost#text']).toBe('unknown_key');
    expect(codes['h2#text']).toBe('empty_translation');
    const after = await getArticle(d1, 'multi');
    expect(after?.revision).toBe(before?.revision);
    expect(after?.editions.map(e => e.locale)).toEqual(['vi']);
  });

  it('rejects changed links, code spans, diagram labels with markup and widget text with tags', async () => {
    await seed();
    const prep = await prepare();
    const translations = allPlaceholdersKept(prep.entries);
    translations['p1#text'] = 'Nội dung [link](https://evil.example/x) và `other()`';
    translations['dia#source.labels[1]'] = 'Server [x]';
    translations['dia#source.labels[0]'] = 'Start (now)';
    translations['wid#html.i18n[run]'] = 'Run <script>alert(1)</script>';
    translations['wid#html.i18n[title]'] = 'Cost & price';
    const res = await apply(prep, { dry_run: true }, 'en', translations);
    expect(res.valid).toBe(false);
    const codes = Object.fromEntries(res.errors.map(e => [e.key, e.code]));
    expect(codes['p1#text']).toBe('placeholder_mismatch');
    expect(codes['dia#source.labels[1]']).toBe('diagram_label_invalid');
    expect(codes['dia#source.labels[0]']).toBe('diagram_label_invalid');
    expect(codes['wid#html.i18n[run]']).toBe('widget_text_invalid');
    expect(codes['wid#html.i18n[title]']).toBe('widget_text_invalid');
  });

  it('allows parentheses in a label whose source label is quoted', async () => {
    await seed();
    const prep = await prepare();
    const translations = allPlaceholdersKept(prep.entries);
    translations['dia#source.labels[3]'] = 'Valid (yes/no)?';
    const res = await apply(prep, { dry_run: true }, 'en', translations);
    expect(res.errors).toEqual([]);
  });

  it('reports document validation paths when a translation exceeds a field limit', async () => {
    await seed();
    const prep = await prepare();
    const translations = allPlaceholdersKept(prep.entries);
    translations['h1#text'] = 'x'.repeat(600);
    const res = await apply(prep, {}, 'en', translations);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.code === 'invalid_document' && e.path?.includes('text'))).toBe(true);
  });

  it('dry_run validates and reports without writing', async () => {
    await seed();
    const prep = await prepare();
    const before = await getArticle(d1, 'multi');
    const res = await apply(prep, { dry_run: true });
    expect(res.valid).toBe(true);
    expect(res.committed).toBe(false);
    expect((await getArticle(d1, 'multi'))?.revision).toBe(before?.revision);
  });

  it('rejects a stale source hash and names the changed keys when per-key hashes are sent', async () => {
    await seed();
    const prep = await prepare();
    const hashes = Object.fromEntries(prep.entries.map(e => [e.key, e.source_hash]));
    const current = await getArticle(d1, 'multi');
    const edited = structuredClone(current?.draft ?? { version: 1 as const, blocks: [] });
    const p1 = blockById(edited, 'p1');
    if (p1.type === 'paragraph') p1.text = 'Đã sửa';
    await updateArticle(d1, 'multi', { document: edited }, current?.revision, { actor: 'test' });
    const err = await expectError(apply(prep, { source_hashes: hashes }), 409, 'stale_source');
    expect(err.extra.changed_keys).toEqual(['p1#text']);
  });

  it('refuses to replace a hand-written or hand-edited translation unless overwrite is set', async () => {
    await seed();
    const rec = await getArticle(d1, 'multi');
    await updateArticle(d1, 'multi', { locale: 'en', title: 'Hand written', document: sourceDocument() }, rec?.revision, { actor: 'person' });
    let prep = await prepare();
    expect(prep.locales.find(l => l.locale === 'en')?.state).toBe('unmanaged');
    await expectError(apply(prep), 409, 'translation_exists');
    expect((await apply(prep, { overwrite: true })).committed).toBe(true);

    prep = await prepare();
    expect(prep.locales.find(l => l.locale === 'en')).toMatchObject({ state: 'current', edited_since_apply: false });
    const afterApply = await getArticle(d1, 'multi', { locale: 'en' });
    const fixed = structuredClone(afterApply?.draft ?? { version: 1 as const, blocks: [] });
    const h1 = blockById(fixed, 'h1');
    if (h1.type === 'heading') h1.text = 'Corrected by a person';
    await updateArticle(d1, 'multi', { locale: 'en', document: fixed }, afterApply?.revision, { actor: 'person' });
    prep = await prepare();
    expect(prep.locales.find(l => l.locale === 'en')?.edited_since_apply).toBe(true);
    await expectError(apply(prep), 409, 'translation_edited');
    const kept = await getArticle(d1, 'multi', { locale: 'en' });
    expect(blockById(kept?.draft ?? { version: 1 as const, blocks: [] }, 'h1')).toMatchObject({ text: 'Corrected by a person' });
  });

  it('flags a translation stale once the source changes', async () => {
    await seed();
    await apply(await prepare());
    const rec = await getArticle(d1, 'multi');
    await updateArticle(d1, 'multi', { title: 'Tiêu đề mới' }, rec?.revision, { actor: 'test' });
    const prep = await prepare();
    expect(prep.locales.find(l => l.locale === 'en')).toMatchObject({ state: 'stale', edited_since_apply: false });
  });

  it('applies all four other locales one after another without the caller tracking revisions', async () => {
    await seed();
    for (const locale of ['en', 'zh', 'ko', 'ja']) {
      const prep = await prepare('multi', [locale]);
      expect((await apply(prep, {}, locale)).committed).toBe(true);
    }
    const rec = await getArticle(d1, 'multi');
    expect(rec?.editions.map(e => e.locale).sort()).toEqual(['en', 'ja', 'ko', 'vi', 'zh']);
    const prep = await prepare();
    expect(prep.locales.every(l => l.state === 'current')).toBe(true);
  });

  it('keeps a published primary edition public and untouched while a translation draft is written', async () => {
    await seed();
    const rec = await getArticle(d1, 'multi');
    await publishArticle(d1, 'multi', rec?.revision, true, { actor: 'test', notify: false });
    const published = await getArticle(d1, 'multi', { publishedOnly: true });
    await apply(await prepare());
    const after = await getArticle(d1, 'multi', { publishedOnly: true });
    expect(after?.locale).toBe('vi');
    expect(JSON.stringify(after?.published)).toBe(JSON.stringify(published?.published));
    expect((await getArticle(d1, 'multi', { locale: 'en' }))?.status).toBe('draft');
  });

  it('refuses a stale expected_revision with 409 and writes nothing (concurrent edit)', async () => {
    await seed();
    const prep = await prepare();
    await expectError(apply(prep, { expected_revision: 99 }), 409, 'revision_conflict');
    expect((await getArticle(d1, 'multi'))?.editions.map(e => e.locale)).toEqual(['vi']);
  });

  it('retrying after a lost response is safe: the second apply replaces the first with identical content', async () => {
    await seed();
    const prep = await prepare();
    const first = await apply(prep);
    const second = await apply(prep);
    expect(first.committed && second.committed).toBe(true);
    const en = await getArticle(d1, 'multi', { locale: 'en' });
    expect(en?.title).toBe('EN Bài viết gốc');
  });

  it('refuses unsupported and source locales, and a source with a recovered draft', async () => {
    await seed();
    const prep = await prepare();
    await expectError(apply(prep, {}, 'fr'), 400, 'invalid_field');
    await expectError(apply(prep, {}, 'vi'), 400, 'invalid_field');
    await expectError(prepareLocalization(d1, 'multi', { locales: ['vi'] }), 400, 'invalid_field');
    await expectError(prepareLocalization(d1, 'missing', {}), 404, 'not_found');
    await expectError(prepareLocalization(d1, 'multi', { source_locale: 'ja' }), 404, 'source_edition_missing');
    await expectError(prepareLocalization(d1, 'multi', { source_revision: 99 }), 409, 'revision_conflict');
    const raw = createTestD1();
    d1 = raw;
    await seed('broken');
    raw.raw.run("UPDATE article_editions SET draft_json = ? WHERE locale = 'vi'", [JSON.stringify({ version: 1, blocks: [{ id: 'x', type: 'bogus' }, ...sourceDocument().blocks] })]);
    await expectError(prepareLocalization(d1, 'broken', {}), 409, 'source_document_recovered');
  });
});

describe('localization report', () => {
  it('flags unchanged text, changed figures and legal wording, and checks the glossary', async () => {
    await seed();
    const prep = await prepare();
    const translations = allPlaceholdersKept(prep.entries);
    translations['tbl#rows[0][1]'] = '$12 per month';
    translations['tbl#rows[1][0]'] = 'Pro';
    translations['h3#text'] = 'Phần 3';
    const res = await apply(prep, { dry_run: true, glossary: { 'Máy tính': 'Calculator' } }, 'en', translations);
    const report = res.report;
    expect(report?.quality).toBe('not_assessed');
    expect(report?.high_risk.find(r => r.key === 'tbl#rows[0][1]')).toMatchObject({ kind: 'price', status: 'changed' });
    expect(report?.high_risk.find(r => r.key === 'tbl#rows[1][1]')).toMatchObject({ kind: 'price', status: 'preserved' });
    expect(report?.unchanged).toEqual(expect.arrayContaining(['tbl#rows[1][0]', 'h3#text']));
    expect(report?.warnings.map(w => w.code)).toEqual(expect.arrayContaining(['figures_changed', 'glossary_term_missing']));
    expect(report?.glossary).toEqual([expect.objectContaining({ term: 'Máy tính', applied: false })]);
    expect(report?.placeholders.preserved).toBe(report?.placeholders.total);
  });
});

describe('MCP tools', () => {
  function ctx(isAdmin: boolean): McpContext {
    return {
      request: new Request('https://zuey.test/api/mcp'), env: {}, d1,
      async requireAdmin() { if (!isAdmin) throw new AppError(401, 'unauthorized', 'Unauthorized'); },
      async isAdmin() { return isAdmin; },
    };
  }

  it('is admin only and registered with matching access policy and schemas', async () => {
    await seed();
    for (const name of ['article_localization_prepare', 'article_localization_apply']) {
      expect(TOOL_ACCESS[name]).toEqual({ kind: 'admin' });
      expect(articlesMcpModule.tools.some(t => t.name === name)).toBe(true);
    }
    await expectError(articlesMcpModule.call('article_localization_prepare', { slug: 'multi' }, ctx(false)), 401, 'unauthorized');
    await expectError(articlesMcpModule.call('article_localization_apply', { slug: 'multi', locale: 'en', source_hash: 'x', translations: {} }, ctx(false)), 401, 'unauthorized');
    const prep = await articlesMcpModule.call('article_localization_prepare', { slug: 'multi', locales: ['en'] }, ctx(true));
    expect(prep).toMatchObject({ slug: 'multi', source_locale: 'vi' });
  });

  it('round-trips through the tool with a compact payload', async () => {
    await seed();
    const prep = await articlesMcpModule.call('article_localization_prepare', { slug: 'multi', locales: ['en'] }, ctx(true)) as PrepareResult;
    const res = await articlesMcpModule.call('article_localization_apply', {
      slug: 'multi', locale: 'en', source_hash: prep.source_hash, translations: allPlaceholdersKept(prep.entries),
    }, ctx(true)) as ApplyResult;
    expect(res.committed).toBe(true);
    expect(JSON.stringify(res).length).toBeLessThan(JSON.stringify(sourceDocument()).length);
  });
});
