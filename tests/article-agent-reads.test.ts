import { describe, it, expect, beforeAll } from 'bun:test';
import { createTestD1 } from './helpers/d1';
import { createSession } from '../src/db/store';
import { createArticle, publishArticle, updateArticle } from '../src/lib/blocks/articles';
import { articlesMcpModule } from '../src/lib/blocks/mcp';
import { blockSchemaHash } from '../src/lib/blocks/block-schema-view';
import { collectTranslatables } from '../src/lib/blocks/read-modes';
import type { ArticleDocument, ParagraphBlock } from '../src/lib/blocks/schema';
import { verifyPublic } from '../src/lib/blocks/verify-public';
import { AppError } from '../src/lib/http';
import type { McpContext } from '../src/lib/mcp/types';
import { GET as getApi, PUT as putApi } from '../src/pages/api/v1/articles/[slug]';
import { GET as verifyApi } from '../src/pages/api/v1/articles/[slug]/verify';
import type { APIRoute } from 'astro';

// Token-efficient agent reads: compact block_schema, article_get read modes, write receipts and article_verify_public.

const d1 = createTestD1();
let adminCookie = '';

function mcpCtx(isAdmin: boolean): McpContext {
  return {
    request: new Request('https://zuey.test/api/mcp'),
    env: {},
    d1,
    async requireAdmin() { if (!isAdmin) throw new AppError(401, 'unauthorized', 'Unauthorized'); },
    async isAdmin() { return isAdmin; },
  };
}

async function tool(name: string, args: Record<string, unknown>, isAdmin = false): Promise<Record<string, unknown>> {
  const out = await articlesMcpModule.call(name, args, mcpCtx(isAdmin));
  if (typeof out !== 'object' || out === null) throw new Error('expected an object');
  return { ...out };
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const err = await promise.then(() => null, (e: unknown) => e);
  if (!(err instanceof AppError)) throw new Error('expected an AppError');
  return err;
}

const para = (id: string, text: string): ParagraphBlock => ({ id, type: 'paragraph', text });
const FIXTURE: ArticleDocument = {
  version: 1,
  blocks: [
    { id: 'h1', type: 'heading', level: 2, text: 'Giới thiệu' },
    para('p1', 'Đoạn mở đầu.'),
    {
      id: 's1', type: 'section', width: 'wide', surface: 'soft', anchor: 'cards', blocks: [
        { id: 'c1', type: 'card', title: 'Thẻ một', variant: 'outline', footer: 'Xem [thêm](https://zuey.me)', blocks: [para('p2', 'Trong thẻ.')] },
      ],
    },
    { id: 't1', type: 'table', headers: ['Gói', 'Giá'], rows: [['Free', '0'], ['Pro', '10']] },
    { id: 'd1', type: 'diagram', syntax: 'mermaid', source: 'graph TD; A[Bắt đầu]-->B[Kết thúc]', caption: 'Luồng' },
    { id: 'i1', type: 'interactive', title: 'Demo', html: '<b id="x">Hi</b>', css: 'b{color:red}', js: 'document.title="x"' },
    { id: 'k1', type: 'code', language: 'ts', code: 'const secret = 1;' },
    { id: 'm1', type: 'image', url: 'https://media.zuey.me/a.webp', alt: 'Ảnh bìa', width: 1672, height: 941 },
  ],
};

beforeAll(async () => {
  adminCookie = `zuey_session=${await createSession('admin@zuey.me', d1)}`;
  const rec = await createArticle(d1, { slug: 'agent-reads', title: 'Đọc cho agent', document: FIXTURE });
  const published = await publishArticle(d1, 'agent-reads', rec.revision, true, { notify: false });
  const en = await updateArticle(d1, 'agent-reads', { locale: 'en', title: 'Reads for agents', document: FIXTURE }, published.revision);
  await publishArticle(d1, 'agent-reads', en.revision, true, { locale: 'en', notify: false });
});

describe('block_schema', () => {
  it('keeps the complete legacy payload when called without arguments', async () => {
    const out = await tool('block_schema', {});
    expect(Object.keys(out).sort()).toEqual(['block_types', 'examples', 'icons', 'limits', 'rules', 'schema_hash', 'schemas', 'version']);
    expect(out.schema_hash).toBe(await blockSchemaHash());
  });

  it('narrows to the requested block types and their examples', async () => {
    const out = await tool('block_schema', { types: ['card', 'paragraph'] });
    expect(out.block_types).toEqual(['paragraph', 'card']);
    expect(Object.keys(out.schemas as object)).toEqual(['BlockParagraph', 'BlockCard']);
    expect(Object.keys(out.examples as object)).toEqual(['card']);
    expect('icons' in out).toBe(false);
  });

  it('compact lines list required fields and types, and are deterministic', async () => {
    const a = await tool('block_schema', { types: ['table', 'chart'], compact: true });
    const b = await tool('block_schema', { compact: true, types: ['chart', 'table'] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const table = (a.schemas as Record<string, { required: string[]; fields: Record<string, string> }>).table;
    expect(table.required).toEqual(['headers', 'rows']);
    expect(table.fields.headers).toContain('array');
    expect('id' in table.fields).toBe(false);
  });

  it('selects sections, returns icon names only when compact, and rejects unknown input with the valid values', async () => {
    const icons = await tool('block_schema', { include: ['icons'], compact: true });
    expect(Object.keys(icons).sort()).toEqual(['compact', 'icons', 'schema_hash', 'version']);
    expect(Object.keys(icons.icons as object).sort()).toEqual(['aliases', 'names']);
    const badType = await rejection(articlesMcpModule.call('block_schema', { types: ['nope'] }, mcpCtx(false)));
    expect(badType.code).toBe('invalid_field');
    expect(badType.message).toContain('paragraph');
    expect((await rejection(articlesMcpModule.call('block_schema', { include: ['x'] }, mcpCtx(false)))).code).toBe('invalid_field');
  });

  it('is much smaller than the full payload for a typical writing task', async () => {
    const full = JSON.stringify(await tool('block_schema', {})).length;
    const small = JSON.stringify(await tool('block_schema', { types: ['section', 'card', 'paragraph', 'heading', 'image'], compact: true })).length;
    expect(small).toBeLessThan(full * 0.25);
  });
});

describe('article_get read modes', () => {
  it('summary returns metadata, block count and hash without the document', async () => {
    const out = await tool('article_get', { slug: 'agent-reads', mode: 'summary' });
    expect('document' in out).toBe(false);
    expect(out.document_blocks).toBe(10);
    expect(out.content_hash).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(out.read_mode).toBe('summary');
    const again = await tool('article_get', { slug: 'agent-reads', mode: 'summary' });
    expect(again.content_hash).toBe(out.content_hash);
  });

  it('outline lists ids, types and labels with nesting', async () => {
    const out = await tool('article_get', { slug: 'agent-reads', mode: 'outline' });
    const outline = out.outline as Array<{ id: string; type: string; label?: string; children?: Array<{ id: string; children?: Array<{ id: string }> }> }>;
    expect(outline.map(n => n.id)).toEqual(['h1', 'p1', 's1', 't1', 'd1', 'i1', 'k1', 'm1']);
    expect(outline[0].label).toBe('Giới thiệu');
    expect(outline[2].children?.[0].children?.[0].id).toBe('p2');
  });

  it('section returns one block by id with its ancestors, nested blocks included', async () => {
    const top = await tool('article_get', { slug: 'agent-reads', mode: 'section', section_id: 's1' });
    expect((top.section as { id: string }).id).toBe('s1');
    expect(top.section_path).toEqual([]);
    const nested = await tool('article_get', { slug: 'agent-reads', mode: 'section', section_id: 'p2' });
    expect(nested.section_path).toEqual(['s1', 'c1']);
    expect((await rejection(articlesMcpModule.call('article_get', { slug: 'agent-reads', mode: 'section', section_id: 'zzz' }, mcpCtx(false)))).code).toBe('section_not_found');
    expect((await rejection(articlesMcpModule.call('article_get', { slug: 'agent-reads', mode: 'section' }, mcpCtx(false)))).code).toBe('invalid_field');
  });

  it('translatables lists prose fields only and pages with a cursor', async () => {
    const all = await tool('article_get', { slug: 'agent-reads', mode: 'translatables' });
    const items = all.translatables as Array<{ block_id: string; field_path: string; text: string; source_hash: string }>;
    const keys = items.map(i => `${i.block_id}.${i.field_path}`);
    expect(keys).toContain('t1.rows[1][1]');
    expect(keys).toContain('c1.footer');
    expect(keys).toContain('d1.caption');
    expect(keys).toContain('i1.title');
    expect(keys).toContain('m1.alt');
    const text = JSON.stringify(items);
    for (const immutable of ['const secret', 'graph TD', 'document.title', 'b{color:red}', 'media.zuey.me', 'cards']) expect(text).not.toContain(immutable);
    expect(all.total).toBe(items.length);
    expect(all.next_cursor).toBeNull();

    const first = await tool('article_get', { slug: 'agent-reads', mode: 'translatables', limit: 4 });
    expect((first.translatables as unknown[]).length).toBe(4);
    expect(first.next_cursor).toBe('4');
    const second = await tool('article_get', { slug: 'agent-reads', mode: 'translatables', limit: 4, cursor: first.next_cursor });
    expect((second.translatables as Array<{ block_id: string }>)[0]).toEqual(items[4]);
    expect((await rejection(articlesMcpModule.call('article_get', { slug: 'agent-reads', mode: 'translatables', cursor: 'abc' }, mcpCtx(false)))).code).toBe('invalid_field');
  });

  it('keeps full as the default and rejects unknown modes', async () => {
    const out = await tool('article_get', { slug: 'agent-reads' });
    expect((out.document as ArticleDocument).blocks.length).toBe(8);
    expect('read_mode' in out).toBe(false);
    expect((await rejection(articlesMcpModule.call('article_get', { slug: 'agent-reads', mode: 'tiny' }, mcpCtx(false)))).code).toBe('invalid_field');
  });

  it('never exposes more than full does to a reader without the paid entitlement', async () => {
    const secret = 'PAID_ONLY_SECRET_TEXT';
    const blocks = [para('a', 'Mở bài miễn phí đủ dài để qua cổng.'), ...Array.from({ length: 12 }, (_, i) => para(`b${i}`, `${secret} ${i} đoạn trả phí khá dài để vượt ngưỡng xem trước.`))];
    const rec = await createArticle(d1, { slug: 'agent-paid', title: 'Paid', access: 'knowledges', document: { version: 1, blocks } });
    await publishArticle(d1, 'agent-paid', rec.revision, true, { notify: false });
    const full = JSON.stringify(await tool('article_get', { slug: 'agent-paid' }));
    expect(full).not.toContain(`${secret} 11`);
    for (const mode of ['summary', 'outline', 'translatables']) {
      expect(JSON.stringify(await tool('article_get', { slug: 'agent-paid', mode }))).not.toContain(`${secret} 11`);
    }
    const adminDraft = await tool('article_get', { slug: 'agent-paid', draft: true, mode: 'translatables' }, true);
    expect(JSON.stringify(adminDraft)).toContain(`${secret} 11`);
  });

  it('is served over REST with the same modes', async () => {
    const request = new Request('https://zuey.test/api/v1/articles/agent-reads?mode=outline');
    const res = await getApi({ request, params: { slug: 'agent-reads' }, url: new URL(request.url), locals: { runtime: { env: { DB: d1 } } } } as unknown as Parameters<APIRoute>[0]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { outline: unknown[]; read_mode: string } };
    expect(body.data.read_mode).toBe('outline');
    expect(body.data.outline.length).toBe(8);
    const bad = new Request('https://zuey.test/api/v1/articles/agent-reads?mode=nope');
    const badRes = await getApi({ request: bad, params: { slug: 'agent-reads' }, url: new URL(bad.url), locals: { runtime: { env: { DB: d1 } } } } as unknown as Parameters<APIRoute>[0]);
    expect(badRes.status).toBe(400);
  });
});

describe('response_mode summary', () => {
  it('returns a receipt instead of the saved document on update and still commits the write', async () => {
    const before = await tool('article_get', { slug: 'agent-reads', mode: 'summary' });
    const out = await tool('article_update', { slug: 'agent-reads', expected_revision: before.revision, document: FIXTURE, response_mode: 'summary' }, true);
    expect('document' in out).toBe(false);
    expect(out.document_blocks).toBe(10);
    expect(out.content_hash).toMatch(/^sha256:/);
    expect(out.revision).toBe(Number(before.revision) + 1);
  });

  it('rejects an invalid response_mode before anything is written', async () => {
    const before = await tool('article_get', { slug: 'agent-reads', mode: 'summary', draft: true }, true);
    const err = await rejection(articlesMcpModule.call('article_update', { slug: 'agent-reads', expected_revision: before.revision, document: FIXTURE, response_mode: 'tiny' }, mcpCtx(true)));
    expect(err.code).toBe('invalid_field');
    const after = await tool('article_get', { slug: 'agent-reads', mode: 'summary', draft: true }, true);
    expect(after.revision).toBe(before.revision);
  });

  it('applies to create and REST update, and keeps the default echo', async () => {
    const created = await tool('article_create', { slug: 'agent-receipt', title: 'R', document: FIXTURE, response_mode: 'summary' }, true);
    expect(created.document_blocks).toBe(10);
    expect('document' in created).toBe(false);
    const echoed = await tool('article_create', { slug: 'agent-echo', title: 'E', document: FIXTURE }, true);
    expect((echoed.document as ArticleDocument).blocks.length).toBe(8);
    const request = new Request('https://zuey.test/api/v1/articles/agent-receipt', {
      method: 'PUT', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: created.revision, document: FIXTURE, response_mode: 'summary' }),
    });
    const res = await putApi({ request, params: { slug: 'agent-receipt' }, url: new URL(request.url), locals: { runtime: { env: { DB: d1 } } } } as unknown as Parameters<APIRoute>[0]);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect('document' in body.data).toBe(false);
    expect(body.data.document_blocks).toBe(10);
  });
});

describe('article_verify_public', () => {
  const origin = 'https://zuey.test';

  function pageFor(locale: string, overrides: { title?: string; canonical?: string; ogImage?: string } = {}): string {
    const title = overrides.title ?? (locale === 'en' ? 'Reads for agents' : 'Đọc cho agent');
    const hreflang = ['vi', 'en'].map(l => `<link rel="alternate" hreflang="${l}" href="${origin}/articles/agent-reads?lang=${l}">`).join('')
      + `<link rel="alternate" hreflang="x-default" href="${origin}/articles/agent-reads">`;
    return `<!doctype html><html lang="${locale}"><head><title>${title} | Zuey</title>`
      + `<link rel="canonical" href="${overrides.canonical ?? `${origin}/articles/agent-reads?lang=${locale}`}">${hreflang}`
      + `<meta property="og:image" content="${overrides.ogImage ?? `${origin}/og/agent-reads.png`}"><meta name="twitter:image" content="${origin}/og/agent-reads.png">`
      + `<script type="application/ld+json">${JSON.stringify({ image: ['https://media.zuey.me/a.webp'] })}</script></head><body></body></html>`;
  }

  function fakeFetch(opts: { page?: (locale: string) => string; imageStatus?: number } = {}): { fetcher: typeof fetch; requested: string[] } {
    const requested: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      requested.push(`${init?.method ?? 'GET'} ${url.toString()}`);
      expect(new Headers(init?.headers).has('cookie')).toBe(false);
      if (url.pathname.startsWith('/articles/')) return new Response((opts.page ?? pageFor)(url.searchParams.get('lang') ?? 'vi'), { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response(null, { status: opts.imageStatus ?? 200, headers: { 'content-type': 'image/webp' } });
    }) as typeof fetch;
    return { fetcher, requested };
  }

  it('passes for correctly published editions and probes only the site and the media host', async () => {
    const { fetcher, requested } = fakeFetch();
    const out = await verifyPublic(d1, 'agent-reads', { origin, fetcher });
    expect(out.ok).toBe(true);
    expect(out.locales.map(l => l.locale).sort()).toEqual(['en', 'vi']);
    for (const l of out.locales) {
      expect(l.failed_checks).toEqual([]);
      expect(l.canonical).toBe(`${origin}/articles/agent-reads?lang=${l.locale}`);
      expect(l.document_hash).toMatch(/^sha256:/);
      expect(l.cover_image?.reachable).toBe(true);
    }
    expect(requested.every(r => r.includes('zuey.test') || r.includes('media.zuey.me'))).toBe(true);
    expect(out.not_tracked).toContain('translation_provenance');
  });

  it('names the failing checks per locale', async () => {
    const bad = fakeFetch({ page: l => pageFor(l, { canonical: 'https://zuey.test/articles/other', title: 'Sai tiêu đề' }), imageStatus: 404 });
    const out = await verifyPublic(d1, 'agent-reads', { origin, fetcher: bad.fetcher, locales: ['en'] });
    expect(out.ok).toBe(false);
    expect(out.locales[0].failed_checks).toEqual(expect.arrayContaining(['canonical_matches', 'title_matches', 'og_image_reachable', 'cover_reachable']));
  });

  it('refuses to probe a share image on a foreign host', async () => {
    const { fetcher, requested } = fakeFetch({ page: l => pageFor(l, { ogImage: 'https://evil.example/x.png' }) });
    const out = await verifyPublic(d1, 'agent-reads', { origin, fetcher, locales: ['vi'] });
    expect(out.locales[0].og_image).toMatchObject({ checked: false, reason: 'host_not_allowed' });
    expect(out.locales[0].failed_checks).toContain('og_image_reachable');
    expect(requested.some(r => r.includes('evil.example'))).toBe(false);
  });

  it('reports an unpublished locale and an unknown article', async () => {
    const { fetcher } = fakeFetch();
    const out = await verifyPublic(d1, 'agent-reads', { origin, fetcher, locales: ['ja'] });
    expect(out.locales[0].failed_checks).toEqual(['edition_not_published']);
    expect((await rejection(verifyPublic(d1, 'no-such-article', { origin, fetcher }))).code).toBe('not_found');
  });

  it('is admin only over MCP and REST', async () => {
    expect((await rejection(articlesMcpModule.call('article_verify_public', { slug: 'agent-reads' }, mcpCtx(false)))).code).toBe('unauthorized');
    const request = new Request('https://zuey.test/api/v1/articles/agent-reads/verify');
    const res = await verifyApi({ request, params: { slug: 'agent-reads' }, url: new URL(request.url), locals: { runtime: { env: { DB: d1 } } } } as unknown as Parameters<APIRoute>[0]);
    expect(res.status).toBe(401);
  });
});

describe('payload benchmark (bytes, not tokens)', () => {
  it('measures the legacy versus targeted agent calls for translating one article', async () => {
    const bytes = (v: unknown) => JSON.stringify(v).length;
    const legacy = bytes(await tool('block_schema', {})) + bytes(await tool('article_get', { slug: 'agent-reads' }));
    const targeted = bytes(await tool('block_schema', { types: ['section', 'card', 'paragraph', 'heading', 'table', 'image'], compact: true }))
      + bytes(await tool('article_get', { slug: 'agent-reads', mode: 'translatables' }));
    const items = collectTranslatables(FIXTURE).length;
    console.info(`[benchmark] legacy ${legacy} B, targeted ${targeted} B (${Math.round((1 - targeted / legacy) * 100)}% smaller), ${items} translatable fields`);
    expect(targeted).toBeLessThan(legacy);
  });
});
