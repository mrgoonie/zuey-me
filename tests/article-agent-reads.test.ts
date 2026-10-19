import { describe, it, expect, beforeAll } from 'bun:test';
import type { APIRoute } from 'astro';
import { createTestD1 } from './helpers/d1';
import { articlesMcpModule } from '../src/lib/blocks/mcp';
import { AppError } from '../src/lib/http';
import { articleAlternates, articleUrl } from '../src/lib/blocks/seo';
import { BLOCK_TYPES } from '../src/lib/blocks/schema';
import type { Locale } from '../src/lib/i18n/locales';
import { LOCALE_LABELS } from '../src/lib/i18n/locales';
import type { McpContext } from '../src/lib/mcp/types';
import { verifyPublicArticle } from '../src/lib/blocks/verify-public';
import { GET as getApi, PUT as putApi } from '../src/pages/api/v1/articles/[slug]';
import { GET as verifyApi } from '../src/pages/api/v1/articles/[slug]/verify';
import { createSession } from '../src/db/store';

const d1 = createTestD1();
const ORIGIN = 'https://zuey.test';

function mcpCtx(isAdmin: boolean): McpContext {
  return {
    request: new Request(`${ORIGIN}/api/mcp`),
    env: {},
    d1,
    async requireAdmin() { if (!isAdmin) throw new AppError(401, 'unauthorized', 'Unauthorized'); },
    async isAdmin() { return isAdmin; },
  };
}

const call = (name: string, args: Record<string, unknown>, admin = true) => articlesMcpModule.call(name, args, mcpCtx(admin)) as Promise<Record<string, unknown>>;
const bytes = (value: unknown) => JSON.stringify(value).length;

const WIDGET_HTML = `<div id="app"><h3>Calculator</h3>${'<label>Field <input type="number"></label>'.repeat(40)}<button id="go">Run</button></div>`;
const WIDGET_JS = `const go=document.getElementById('go');go.addEventListener('click',()=>{${'void 0;'.repeat(600)}});`;

/** Ten sections with nested cards, a diagram, an interactive widget and an image: the shape of a real long article. */
function fixtureDocument() {
  const sections = Array.from({ length: 10 }, (_, i) => ({
    type: 'section', id: `sec${i}`, width: 'prose', surface: 'none', anchor: `part-${i}`,
    blocks: [
      { type: 'heading', id: `h${i}`, level: 2, text: `Section ${i} heading` },
      { type: 'paragraph', id: `p${i}`, text: `Paragraph ${i} with **bold** and a [link](https://example.com/${i}). ${'Lorem ipsum dolor sit amet. '.repeat(12)}` },
      { type: 'card', id: `c${i}`, variant: 'soft', title: `Card ${i}`, footer: 'See [docs](https://example.com/docs)', blocks: [
        { type: 'list', id: `l${i}`, style: 'bullet', items: [`Item ${i}.a`, `Item ${i}.b`] },
        { type: 'code', id: `code${i}`, language: 'ts', code: `export const value${i} = ${i};` },
      ] },
    ],
  }));
  return {
    version: 1,
    blocks: [
      ...sections,
      { type: 'image', id: 'cover', url: 'https://media.zuey.me/a/cover.webp', alt: 'Cover alt', caption: 'Cover caption', width: 1672, height: 941 },
      { type: 'diagram', id: 'dia', syntax: 'mermaid', source: 'graph TD; A[Start]-->B[Finish]', caption: 'Flow' },
      { type: 'interactive', id: 'widget', title: 'Calculator', html: WIDGET_HTML, css: 'body{margin:0}', js: WIDGET_JS, height: 300, caption: 'Try it' },
      { type: 'table', id: 'tbl', headers: ['Plan', 'Price'], rows: [['Free', '0'], ['Pro', '9']] },
      { type: 'chart', id: 'chart', kind: 'bar', title: 'Growth', labels: ['Q1', 'Q2'], series: [{ name: 'Users', data: [1, 2] }] },
    ],
  };
}

async function seed(slug: string, access: 'free' | 'knowledges' = 'free', locales: Locale[] = ['vi']): Promise<number> {
  let rev = 1;
  await call('article_create', { slug, title: `Title ${slug}`, access, document: fixtureDocument() });
  for (const locale of locales) {
    if (locale !== 'vi') {
      rev += 1;
      await call('article_update', { slug, locale, title: `Title ${slug} ${locale}`, document: fixtureDocument(), expected_revision: rev - 1, response_mode: 'summary' });
    }
    await call('article_publish', { slug, locale, expected_revision: rev, confirm: true, notify: false, response_mode: 'summary' });
    rev += 1;
  }
  return rev;
}

describe('block_schema', () => {
  it('keeps the no-argument answer complete and adds a stable hash', async () => {
    const full = await call('block_schema', {}, false);
    expect(Object.keys(full)).toEqual(expect.arrayContaining(['version', 'block_types', 'limits', 'rules', 'schemas', 'icons', 'examples', 'schema_hash']));
    expect(full.block_types).toEqual([...BLOCK_TYPES]);
    expect(String(full.schema_hash)).toMatch(/^[0-9a-f]{16}$/);
    expect((await call('block_schema', {}, false)).schema_hash).toBe(full.schema_hash);
  });

  it('narrows to the requested types, parts and compact form', async () => {
    const small = await call('block_schema', { types: ['card', 'image'], compact: true }, false);
    expect(small.block_types).toEqual(['image', 'card']);
    expect(Object.keys(small.schemas as object)).toEqual(['BlockImage', 'BlockCard']);
    expect(small).not.toHaveProperty('icons');
    expect(small).not.toHaveProperty('rules');
    expect(Object.keys(small.examples as object)).toEqual(['card']);
    expect(JSON.stringify(small.schemas)).not.toContain('"description"');

    const icons = await call('block_schema', { types: ['icon'], include: ['icons'], compact: true }, false);
    expect(icons).not.toHaveProperty('schemas');
    expect(Object.keys(icons.icons as object).sort()).toEqual(['aligns', 'names', 'sizes', 'tones']);

    const full = await call('block_schema', {}, false);
    expect(bytes(small)).toBeLessThan(bytes(full) * 0.2);
  });

  it('answers unchanged for a current hash and rejects bad arguments', async () => {
    const { schema_hash } = await call('block_schema', {}, false);
    expect(await call('block_schema', { known_hash: schema_hash }, false)).toEqual({ version: 1, schema_hash, unchanged: true });
    const stale = await call('block_schema', { known_hash: 'old', types: ['image'] }, false);
    expect(stale.unchanged).toBeUndefined();
    for (const bad of [{ types: ['nope'] }, { include: ['nope'] }, { types: 'image' }, { compact: 'yes' }]) {
      const err = await articlesMcpModule.call('block_schema', bad, mcpCtx(false)).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
    }
  });
});

describe('article_get read modes', () => {
  beforeAll(async () => { await seed('modes', 'free', ['vi', 'en']); });

  it('summary leaves the document out but reports its size and hash', async () => {
    const full = await call('article_get', { slug: 'modes' }, false);
    const summary = await call('article_get', { slug: 'modes', mode: 'summary' }, false);
    expect(summary).not.toHaveProperty('document');
    expect(summary).toMatchObject({ slug: 'modes', locale: 'vi', mode: 'summary' });
    expect(summary.document_blocks).toBe(10 * 6 + 5);
    expect(summary.content_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(bytes(summary)).toBeLessThan(bytes(full) * 0.15);
    expect((await call('article_get', { slug: 'modes', mode: 'summary' }, false)).content_hash).toBe(summary.content_hash);
  });

  it('outline lists every block id with depth and labels', async () => {
    const out = await call('article_get', { slug: 'modes', mode: 'outline' }, false);
    const outline = out.outline as Array<{ id: string; type: string; depth: number; label?: string }>;
    expect(outline[0]).toEqual({ id: 'sec0', type: 'section', depth: 0, label: 'part-0' });
    expect(outline[1]).toEqual({ id: 'h0', type: 'heading', depth: 1, label: 'Section 0 heading' });
    expect(outline.find(b => b.id === 'code0')).toEqual({ id: 'code0', type: 'code', depth: 2 });
    expect(outline.find(b => b.id === 'widget')).toMatchObject({ type: 'interactive', label: 'Calculator' });
    expect(outline).toHaveLength(out.document_blocks as number);
  });

  it('section returns one block with its children, or 404', async () => {
    const out = await call('article_get', { slug: 'modes', mode: 'section', block_id: 'c3' }, false);
    expect(out.block).toMatchObject({ id: 'c3', type: 'card', blocks: [{ id: 'l3' }, { id: 'code3' }] });
    expect(out).not.toHaveProperty('document');
    const missing = await articlesMcpModule.call('article_get', { slug: 'modes', mode: 'section', block_id: 'zzz' }, mcpCtx(false)).then(() => null, (e: unknown) => e);
    expect(missing).toMatchObject({ status: 404, code: 'block_not_found' });
    const noId = await articlesMcpModule.call('article_get', { slug: 'modes', mode: 'section' }, mcpCtx(false)).then(() => null, (e: unknown) => e);
    expect(noId).toMatchObject({ status: 400 });
  });

  it('translatables lists visible prose only, keyed by block id and field path, with paging', async () => {
    const first = await call('article_get', { slug: 'modes', mode: 'translatables', limit: 7 }, false);
    const items = first.translatables as Array<{ block_id: string; field_path: string; source_text: string; source_hash: string }>;
    expect(items).toHaveLength(7);
    expect(first.next_cursor).toBe('o7');
    expect(items[0]).toMatchObject({ block_id: 'h0', field_path: 'text', source_text: 'Section 0 heading' });
    expect(items[0].source_hash).toMatch(/^[0-9a-f]{16}$/);

    const all: typeof items = [];
    let cursor: string | undefined;
    do {
      const page = await call('article_get', { slug: 'modes', mode: 'translatables', limit: 40, ...(cursor ? { cursor } : {}) }, false);
      all.push(...(page.translatables as typeof items));
      cursor = (page.next_cursor as string | null) ?? undefined;
    } while (cursor);
    expect(all).toHaveLength(first.translatables_total as number);

    const paths = new Set(all.map(i => `${i.block_id}:${i.field_path}`));
    expect(paths.has('c0:title')).toBe(true);
    expect(paths.has('c0:footer')).toBe(true);
    expect(paths.has('l0:items.1')).toBe(true);
    expect(paths.has('tbl:rows.1.0')).toBe(true);
    expect(paths.has('chart:series.0.name')).toBe(true);
    expect(paths.has('cover:alt')).toBe(true);
    expect(paths.has('widget:title')).toBe(true);
    // Code, Mermaid source, widget HTML/CSS/JS and URLs are never offered for translation.
    expect(all.some(i => i.block_id === 'code0' || i.block_id === 'dia' && i.field_path === 'source')).toBe(false);
    expect(all.some(i => ['html', 'css', 'js', 'url', 'code', 'source'].includes(i.field_path))).toBe(false);
    expect(all.some(i => i.source_text.includes('graph TD'))).toBe(false);

    const bad = await articlesMcpModule.call('article_get', { slug: 'modes', mode: 'translatables', cursor: 'o99999' }, mcpCtx(false)).then(() => null, (e: unknown) => e);
    expect(bad).toMatchObject({ status: 400 });
  });

  it('rejects an unknown mode and keeps full and markdown unchanged', async () => {
    const bad = await articlesMcpModule.call('article_get', { slug: 'modes', mode: 'tiny' }, mcpCtx(false)).then(() => null, (e: unknown) => e);
    expect(bad).toMatchObject({ status: 400 });
    const full = await call('article_get', { slug: 'modes', mode: 'full' }, false);
    expect(full).toHaveProperty('document');
    expect(full).not.toHaveProperty('mode');
    expect(await call('article_get', { slug: 'modes', format: 'markdown' }, false)).toHaveProperty('markdown');
  });

  it('never reveals paid text in any mode to a reader without the entitlement', async () => {
    await seed('paid-modes', 'knowledges');
    const secret = 'Paragraph 9 with';
    const full = JSON.stringify(await call('article_get', { slug: 'paid-modes' }, false));
    expect(full).not.toContain(secret);
    for (const mode of ['summary', 'outline', 'translatables']) {
      const body = JSON.stringify(await call('article_get', { slug: 'paid-modes', mode, limit: 500 }, false));
      expect(body).not.toContain(secret);
    }
    const hidden = await articlesMcpModule.call('article_get', { slug: 'paid-modes', mode: 'section', block_id: 'sec9' }, mcpCtx(false)).then(() => null, (e: unknown) => e);
    expect(hidden).toMatchObject({ status: 404, code: 'block_not_found' });
    // The admin keeps the same modes on the draft.
    const draft = await call('article_get', { slug: 'paid-modes', draft: true, mode: 'section', block_id: 'sec9' }, true);
    expect(JSON.stringify(draft)).toContain(secret);
  });
});

describe('response_mode summary on writes', () => {
  it('answers with a receipt and the same hash a later summary read reports', async () => {
    const created = await call('article_create', { slug: 'receipt', title: 'Receipt', document: fixtureDocument(), response_mode: 'summary' });
    expect(created).not.toHaveProperty('document');
    expect(created.document_blocks).toBe(10 * 6 + 5);
    const updated = await call('article_update', { slug: 'receipt', title: 'Receipt 2', document: fixtureDocument(), expected_revision: 1, response_mode: 'summary' });
    expect(updated).not.toHaveProperty('document');
    expect(updated).toMatchObject({ revision: 2, status: 'draft' });
    const draft = await call('article_get', { slug: 'receipt', draft: true, mode: 'summary' }, true);
    expect(draft.content_hash).toBe(updated.content_hash);
    const full = await call('article_update', { slug: 'receipt', title: 'Receipt 3', expected_revision: 2 });
    expect(full).toHaveProperty('document');
  });

  it('rejects an unknown response_mode before writing anything', async () => {
    const err = await articlesMcpModule.call('article_update', { slug: 'receipt', title: 'Nope', expected_revision: 3, response_mode: 'tiny' }, mcpCtx(true)).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ status: 400 });
    expect((await call('article_get', { slug: 'receipt', draft: true, mode: 'summary' }, true)).revision).toBe(3);
  });
});

describe('REST parity', () => {
  let cookie = '';
  beforeAll(async () => { cookie = `zuey_session=${await createSession('admin@zuey.me', d1)}`; });

  async function rest(handler: APIRoute, init: { query?: string; slug: string; method?: string; body?: unknown; admin?: boolean }) {
    const headers = new Headers(init.admin ? { cookie } : {});
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    const request = new Request(`${ORIGIN}/api/v1/articles/${init.slug}${init.query ?? ''}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    const ctx = { request, params: { slug: init.slug }, url: new URL(request.url), locals: { runtime: { env: { DB: d1 } } } };
    // The handlers only read request/params/locals; a full APIContext is not constructible in tests.
    return handler(ctx as unknown as Parameters<APIRoute>[0]);
  }

  it('serves the same modes on GET and the receipt on PUT', async () => {
    const outline = await (await rest(getApi, { slug: 'modes', query: '?mode=outline' })).json() as { data: { outline: unknown[]; mode: string } };
    expect(outline.data.mode).toBe('outline');
    expect(outline.data.outline.length).toBeGreaterThan(50);
    const tr = await (await rest(getApi, { slug: 'modes', query: '?mode=translatables&limit=5' })).json() as { data: { translatables: unknown[]; next_cursor: string } };
    expect(tr.data.translatables).toHaveLength(5);
    expect(tr.data.next_cursor).toBe('o5');
    expect((await rest(getApi, { slug: 'modes', query: '?mode=section' })).status).toBe(400);
    expect((await rest(getApi, { slug: 'modes', query: '?mode=translatables&limit=0' })).status).toBe(400);
    const put = await rest(putApi, { slug: 'receipt', method: 'PUT', admin: true, body: { title: 'R4', expected_revision: 3, response_mode: 'summary' } });
    expect(put.status).toBe(200);
    expect((await put.json() as { data: Record<string, unknown> }).data).not.toHaveProperty('document');
  });

  it('keeps the verify route admin only', async () => {
    expect((await rest(verifyApi, { slug: 'modes' })).status).toBe(401);
  });
});

/** Page HTML as the site renders it, for the fetcher stub. */
function pageHtml(slug: string, locale: Locale, published: Locale[], overrides: { canonical?: string; cover?: string } = {}) {
  const url = articleUrl(ORIGIN, slug, locale);
  const alts = articleAlternates(ORIGIN, slug, published).map(a => `<link rel="alternate" hreflang="${a.hreflang}" href="${a.href}">`).join('');
  const cover = overrides.cover ?? 'https://media.zuey.me/a/cover.webp';
  return `<!doctype html><html lang="${LOCALE_LABELS[locale].htmlLang}"><head><title>Title ${slug}${locale === 'vi' ? '' : ` ${locale}`} | Zuey</title>
<link rel="canonical" href="${overrides.canonical ?? url}">${alts}
<meta property="og:image" content="${ORIGIN}/og/${slug}-${locale}.png"><meta name="twitter:image" content="${ORIGIN}/og/${slug}-${locale}.png">
<script type="application/ld+json">${JSON.stringify({ '@type': 'Article', image: [cover] })}</script></head><body></body></html>`;
}

describe('article_verify_public', () => {
  const published: Locale[] = ['vi', 'en'];
  beforeAll(async () => {
    await seed('verify-me', 'free', published);
    await call('article_create', { slug: 'verify-draft-only', title: 'Draft only', document: fixtureDocument() });
  });

  function fetcherFor(opts: { status?: Partial<Record<string, number>>; overrides?: Partial<Record<Locale, { canonical?: string; cover?: string }>> } = {}) {
    const seen: Array<{ url: string; method: string; headers: Headers }> = [];
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, method: init?.method ?? 'GET', headers });
      if (url.startsWith(`${ORIGIN}/articles/`)) {
        const locale = new URL(url).searchParams.get('lang') as Locale;
        const status = opts.status?.[locale] ?? 200;
        return new Response(status === 200 ? pageHtml('verify-me', locale, published, opts.overrides?.[locale]) : 'x', { status, headers: { 'content-type': 'text/html' } });
      }
      const status = opts.status?.[url] ?? 200;
      return new Response(null, { status, headers: { 'content-type': status === 200 ? 'image/webp' : 'text/plain' } });
    }) as typeof fetch;
    return { fn, seen };
  }

  it('passes when every published locale matches its stored edition', async () => {
    const { fn, seen } = fetcherFor();
    const result = await verifyPublicArticle(d1, 'verify-me', { origin: ORIGIN, fetcher: fn });
    expect(result.ok).toBe(true);
    expect(Object.keys(result.locales).sort()).toEqual(['en', 'vi']);
    const vi = result.locales.vi;
    expect(vi).toMatchObject({ ok: true, http_status: 200, problems: [], translation_provenance: null, cover_url: 'https://media.zuey.me/a/cover.webp' });
    expect(vi?.content_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(vi?.images.map(i => i.role)).toEqual(['cover', 'og:image', 'twitter:image'].filter((_, i) => i !== 2));
    expect(result.locales.en?.content_hash).toBe(vi?.content_hash);
    expect(result.pending_side_effects.email_notification?.status ?? 'skipped').toBeDefined();
    // The check reads like an anonymous visitor: no cookies, no authorization.
    expect(seen.every(r => !r.headers.has('cookie') && !r.headers.has('authorization'))).toBe(true);
  });

  it('reports a wrong canonical, an unreachable cover and a failing page per locale', async () => {
    const { fn } = fetcherFor({
      status: { en: 500, 'https://media.zuey.me/a/cover.webp': 404 },
      overrides: { vi: { canonical: `${ORIGIN}/articles/verify-me` } },
    });
    const result = await verifyPublicArticle(d1, 'verify-me', { origin: ORIGIN, fetcher: fn });
    expect(result.ok).toBe(false);
    expect(result.locales.vi?.problems.some(p => p.startsWith('canonical is'))).toBe(true);
    expect(result.locales.vi?.problems.some(p => p.startsWith('cover image is not reachable'))).toBe(true);
    expect(result.locales.en?.problems).toEqual(['page answered HTTP 500']);
  });

  it('flags a cover that is not the one JSON-LD advertises', async () => {
    const { fn } = fetcherFor({ overrides: { en: { cover: 'https://media.zuey.me/other.webp' } } });
    const result = await verifyPublicArticle(d1, 'verify-me', { origin: ORIGIN, fetcher: fn, locales: ['en'] });
    expect(Object.keys(result.locales)).toEqual(['en']);
    expect(result.locales.en?.problems).toEqual(['JSON-LD image is not the edition cover']);
  });

  it('never requests images on hosts off the allowlist and can skip images', async () => {
    const outsider = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(`${ORIGIN}/articles/`)) {
        return new Response(pageHtml('verify-me', 'vi', published).replace(`${ORIGIN}/og/verify-me-vi.png`, 'https://evil.example/x.png'), { status: 200 });
      }
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const result = await verifyPublicArticle(d1, 'verify-me', { origin: ORIGIN, fetcher: outsider, locales: ['vi'] });
    expect(result.locales.vi?.images.find(i => i.url === 'https://evil.example/x.png')).toMatchObject({ ok: false, skipped: 'host_not_allowed' });
    const noImages = await verifyPublicArticle(d1, 'verify-me', { origin: ORIGIN, fetcher: fetcherFor().fn, locales: ['vi'], checkImages: false });
    expect(noImages.ok).toBe(true);
    expect(noImages.locales.vi?.images).toEqual([]);
  });

  it('lists draft-only editions without fetching them and rejects unknown input', async () => {
    const { fn, seen } = fetcherFor();
    const result = await verifyPublicArticle(d1, 'verify-me', { origin: ORIGIN, fetcher: fn });
    expect(result.unpublished_locales).toEqual([]);
    const err = await verifyPublicArticle(d1, 'verify-draft-only', { origin: ORIGIN, fetcher: fn, locales: ['vi'] }).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ status: 400 });
    expect(await verifyPublicArticle(d1, 'missing-slug', { origin: ORIGIN, fetcher: fn }).then(() => null, (e: unknown) => e)).toMatchObject({ status: 404 });
    expect(seen.some(r => r.url.includes('verify-draft-only'))).toBe(false);
  });

  it('is an admin tool', async () => {
    const err = await articlesMcpModule.call('article_verify_public', { slug: 'verify-me' }, mcpCtx(false)).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ status: 401 });
  });

  it('requires the members-only notice on the anonymous page of a paid edition', async () => {
    await seed('verify-paid', 'knowledges');
    const paidFetcher = (body: string) => (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(`${ORIGIN}/articles/`)) return new Response(pageHtml('verify-paid', 'vi', ['vi']).replace('<body></body>', `<body>${body}</body>`), { status: 200 });
      return new Response(null, { status: 200, headers: { 'content-type': 'image/webp' } });
    }) as typeof fetch;
    const locked = await verifyPublicArticle(d1, 'verify-paid', { origin: ORIGIN, fetcher: paidFetcher('<div class="zb-lock-outline zb-paywalled"></div>') });
    expect(locked.locales.vi).toMatchObject({ ok: true, paywall: { expected: true, present: true } });
    // The JSON-LD hasPart selector names the class too; only the rendered notice counts.
    const leaked = await verifyPublicArticle(d1, 'verify-paid', { origin: ORIGIN, fetcher: paidFetcher('<script type="application/ld+json">{"cssSelector":".zb-paywalled"}</script><p>whole paid text</p>') });
    expect(leaked.locales.vi?.paywall).toEqual({ expected: true, present: false });
    expect(leaked.locales.vi?.problems).toContain('members-only notice is missing on a paid edition (the paid part may be public)');
    const free = await verifyPublicArticle(d1, 'verify-me', { origin: ORIGIN, fetcher: fetcherFor().fn, locales: ['vi'] });
    expect(free.locales.vi?.paywall).toEqual({ expected: false, present: false });
  });
});

describe('measured payload sizes for a translation round', () => {
  it('shrinks what an agent reads and gets back per round', async () => {
    await seed('bench', 'free');
    // Legacy round: learn the schema, read the whole article, save a translated edition and get the document echoed back.
    const legacy = {
      schema: bytes(await call('block_schema', {}, false)),
      read: bytes(await call('article_get', { slug: 'bench' }, false)),
      write: bytes(await call('article_update', { slug: 'bench', locale: 'en', title: 'Bench en', document: fixtureDocument(), expected_revision: 2 })),
    };
    // Current round: only the blocks it needs, the translatable strings and a receipt.
    const slim = {
      schema: bytes(await call('block_schema', { types: ['paragraph', 'heading', 'card'], compact: true }, false)),
      read: bytes(await call('article_get', { slug: 'bench', mode: 'translatables', limit: 500 }, false)),
      write: bytes(await call('article_update', { slug: 'bench', locale: 'en', title: 'Bench en', document: fixtureDocument(), expected_revision: 3, response_mode: 'summary' })),
    };
    const total = (o: Record<string, number>) => o.schema + o.read + o.write;
    const saved = 1 - total(slim) / total(legacy);
    // JSON characters / 4 is a rough token estimate; this measures response payloads only, not model round trips or cost.
    console.log(`payload per round (JSON chars): legacy ${JSON.stringify(legacy)} = ${total(legacy)} (~${Math.round(total(legacy) / 4)} tokens); slim ${JSON.stringify(slim)} = ${total(slim)} (~${Math.round(total(slim) / 4)} tokens); saved ${(saved * 100).toFixed(1)}%`);
    expect(slim.schema).toBeLessThan(legacy.schema * 0.2);
    expect(slim.read).toBeLessThan(legacy.read);
    expect(slim.write).toBeLessThan(legacy.write * 0.1);
    expect(saved).toBeGreaterThan(0.6);
  });
});
