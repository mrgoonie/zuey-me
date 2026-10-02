import { describe, it, expect, beforeAll } from 'bun:test';
import type { APIRoute } from 'astro';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTestD1 } from './helpers/d1';
import { createSession } from '../src/db/store';
import type { RuntimeEnv, WorkersAiLike } from '../src/env';
import { BlockRenderer } from '../src/components/blocks/BlockRenderer';
import { getArticleView, resolveViewer } from '../src/lib/blocks/articles';
import { embedFrame, recognizeEmbed } from '../src/lib/blocks/embed';
import type { EmbedRecognition } from '../src/lib/blocks/embed';
import { documentToMarkdown } from '../src/lib/blocks/markdown';
import { articlesMcpModule } from '../src/lib/blocks/mcp';
import { articlesOpenApi } from '../src/lib/blocks/openapi';
import { BLOCK_TYPES } from '../src/lib/blocks/schema';
import type { BlockType } from '../src/lib/blocks/schema';
import { articleAlternates, articleJsonLd, linkHeader } from '../src/lib/blocks/seo';
import { validateDocument } from '../src/lib/blocks/validate';
import type { McpContext } from '../src/lib/mcp/types';
import { MCP_FEATURE_MODULES } from '../src/lib/mcp/registry';
import { OPENAPI_FRAGMENTS } from '../src/lib/openapi/registry';
import { createUserKey } from '../src/lib/members/api-keys';
import { requireCan, resolvePrincipal } from '../src/lib/members/policy';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import { allowedTiers, searchKnowledge } from '../src/lib/search';
import { parseAiSuggestion } from '../src/lib/taxonomy/audit';
import { taxonomyMcpModule } from '../src/lib/taxonomy/mcp';
import { taxonomyOpenApi } from '../src/lib/taxonomy/openapi';
import { GET as listApi, POST as createApi } from '../src/pages/api/v1/articles/index';
import { GET as getApi, PUT as putApi } from '../src/pages/api/v1/articles/[slug]';
import { POST as publishApi } from '../src/pages/api/v1/articles/[slug]/publish';
import { DELETE as deleteEditionApi } from '../src/pages/api/v1/articles/[slug]/editions';
import { GET as revisionsApi } from '../src/pages/api/v1/articles/[slug]/revisions';
import { PUT as articleTagsApi } from '../src/pages/api/v1/articles/[slug]/tags';
import { GET as labelsGetApi, PUT as labelsPutApi } from '../src/pages/api/v1/articles/[slug]/labels';
import { POST as labelsRevertApi } from '../src/pages/api/v1/articles/[slug]/labels/revert';
import { GET as searchApi } from '../src/pages/api/v1/search';
import { GET as facetsApi } from '../src/pages/api/v1/taxonomy/index';
import { POST as createTagApi } from '../src/pages/api/v1/taxonomy/tags/index';
import { PUT as updateTagApi } from '../src/pages/api/v1/taxonomy/tags/[id]';
import { GET as proposalsApi, POST as createProposalApi } from '../src/pages/api/v1/taxonomy/proposals/index';
import { GET as proposalApi } from '../src/pages/api/v1/taxonomy/proposals/[id]';
import { POST as decisionApi } from '../src/pages/api/v1/taxonomy/proposals/[id]/decision';
import { POST as createJobApi } from '../src/pages/api/v1/taxonomy/audit-jobs/index';
import { POST as runJobApi } from '../src/pages/api/v1/taxonomy/audit-jobs/[id]/run';
import { GET as mdApi } from '../src/pages/articles/[slug].md';
import { GET as sitemapApi } from '../src/pages/sitemap.xml';

// ---------- Harness: real SQLite with every migration, real routes ----------

const d1 = createTestD1();
let adminCookie = '';
let readerKey = ''; // Knowledges plan (read_full) via a scoped member API key
let freeKey = ''; // member without a plan

type Headers = Record<string, string>;

interface CallInit {
  method?: string;
  body?: unknown;
  params?: Record<string, string>;
  headers?: Headers;
  query?: string;
  path?: string;
  env?: Record<string, unknown>;
}

async function call(handler: APIRoute, init: CallInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  const request = new Request(`https://zuey.test${init.path ?? '/api'}${init.query ?? ''}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const context = {
    request,
    params: init.params ?? {},
    url: new URL(request.url),
    locals: { runtime: { env: { DB: d1, ...(init.env ?? {}) } } },
  };
  // The handlers only read request/params/url/locals; a full APIContext is not constructible in tests.
  return handler(context as unknown as Parameters<APIRoute>[0]);
}

function rec(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`expected an object, got ${JSON.stringify(v)}`);
  return Object.fromEntries(Object.entries(v));
}

function arr(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Error(`expected an array, got ${JSON.stringify(v)}`);
  return v;
}

async function payload(res: Response): Promise<{ status: number; data: unknown; code: string | null; error: Record<string, unknown> }> {
  const body = rec(await res.json());
  const error = body.error === undefined ? {} : rec(body.error);
  return { status: res.status, data: body.data, code: typeof error.code === 'string' ? error.code : null, error };
}

const admin = (): Headers => ({ cookie: adminCookie });
const bearer = (key: string): Headers => ({ authorization: `Bearer ${key}` });

function mcpCtx(headers: Headers, extra: RuntimeEnv = {}): McpContext {
  const request = new Request('https://zuey.test/api/mcp', { headers });
  const env: RuntimeEnv = { ...extra, DB: d1 };
  const principal = () => resolvePrincipal(request, env);
  return {
    request, env, d1, principal,
    async isAdmin() { return (await principal()).kind === 'admin'; },
    async requireAdmin() { requireCan(await principal(), 'admin'); },
  };
}

const para = (text: string, id?: string) => ({ type: 'paragraph', text, ...(id ? { id } : {}) });

async function revisionOf(slug: string): Promise<number> {
  const res = await payload(await call(getApi, { params: { slug }, query: '?draft=1', headers: admin() }));
  expect(res.status).toBe(200);
  const rev = rec(res.data).revision;
  if (typeof rev !== 'number') throw new Error('missing revision');
  return rev;
}

async function create(body: Record<string, unknown>): Promise<void> {
  const res = await payload(await call(createApi, { method: 'POST', headers: admin(), body }));
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.error)}`);
}

async function publish(slug: string, locale?: string): Promise<void> {
  const res = await payload(await call(publishApi, {
    method: 'POST', headers: admin(), params: { slug }, body: { expected_revision: await revisionOf(slug), confirm: true, ...(locale ? { locale } : {}) },
  }));
  if (res.status !== 200) throw new Error(`publish failed: ${res.status} ${JSON.stringify(res.error)}`);
}

// Paid fixture: the first third (two paragraphs) is the public preview; the four tokens live only in the paid remainder.
const FREE_TOKEN = 'lighthousefree';
const PAID_TOKENS = ['quokkasecret', 'narwhalvault', 'axolotlhidden', 'pangolinprivate'];
const PAID_BLOCKS = [
  para(`Opening ${FREE_TOKEN} paragraph one with enough words to count toward the preview length.`),
  para(`Opening ${FREE_TOKEN} paragraph two with enough words to count toward the preview length.`),
  ...PAID_TOKENS.map(t => para(`Members only ${t} paragraph with enough words to count toward the length.`)),
];

beforeAll(async () => {
  adminCookie = `zuey_session=${await createSession('admin@zuey.me', d1)}`;
  const now = new Date().toISOString();
  const reader = (await findOrCreateVerifiedUser(d1, { email: 'reader@example.com' })).user;
  await d1.prepare('INSERT INTO subscriptions (id, user_id, plan, status, current_period_end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('sub_reader', reader.id, 'knowledges', 'active', '2099-01-01T00:00:00.000Z', now, now).run();
  readerKey = (await createUserKey(d1, reader.id, { name: 'reader', scopes: ['articles:read'], expires_in_days: 30 })).secret;
  const free = (await findOrCreateVerifiedUser(d1, { email: 'free@example.com' })).user;
  freeKey = (await createUserKey(d1, free.id, { name: 'free', scopes: ['articles:read'], expires_in_days: 30 })).secret;

  await create({ slug: 'kb-paid', title: 'Paid knowledge', excerpt: 'Public excerpt', access: 'knowledges', document: { version: 1, blocks: PAID_BLOCKS } });
  await publish('kb-paid');
});

// ---------- Paywall leakage matrix ----------

describe('paywall leakage matrix (HTML loader, .md, REST, MCP, search)', () => {
  const readers: Array<{ name: string; headers: () => Headers; full: boolean }> = [
    { name: 'anonymous', headers: () => ({}), full: false },
    { name: 'member without plan', headers: () => bearer(freeKey), full: false },
    { name: 'Knowledges member', headers: () => bearer(readerKey), full: true },
    { name: 'admin', headers: admin, full: true },
  ];

  const expectLeak = (text: string, full: boolean) => {
    for (const t of PAID_TOKENS) {
      if (full) expect(text).toContain(t);
      else expect(text).not.toContain(t);
    }
  };

  for (const r of readers) {
    it(`${r.name}: ${r.full ? 'reads everything' : 'never receives paid text'}`, async () => {
      // HTML: the page loader (resolveViewer + getArticleView) and the server-rendered block HTML.
      const request = new Request('https://zuey.test/articles/kb-paid', { headers: r.headers() });
      const viewer = await resolveViewer(request, d1, { DB: d1 });
      const view = await getArticleView(d1, 'kb-paid', viewer, { locale: 'vi' });
      if (!view) throw new Error('article not visible');
      expect(view.truncated).toBe(!r.full);
      const html = renderToStaticMarkup(createElement(BlockRenderer, { doc: view.document, articleSlug: view.slug, interactive: false }));
      expect(html).toContain(FREE_TOKEN);
      expectLeak(html, r.full);
      expectLeak(JSON.stringify(view), r.full);

      // Markdown.
      const md = await (await call(mdApi, { params: { slug: 'kb-paid' }, path: '/articles/kb-paid.md', headers: r.headers() })).text();
      expect(md).toContain(FREE_TOKEN);
      expect(md).toContain(`full_text: ${r.full}`);
      expectLeak(md, r.full);

      // REST.
      const rest = await call(getApi, { params: { slug: 'kb-paid' }, headers: r.headers() });
      expect(rest.status).toBe(200);
      expectLeak(await rest.text(), r.full);

      // MCP (JSON and Markdown).
      const ctx = mcpCtx(r.headers());
      expectLeak(JSON.stringify(await articlesMcpModule.call('article_get', { slug: 'kb-paid' }, ctx)), r.full);
      expectLeak(JSON.stringify(await articlesMcpModule.call('article_get', { slug: 'kb-paid', format: 'markdown' }, ctx)), r.full);

      // Search snippets: free-token hits never quote paid text unless the reader may read it.
      const freeHit = await payload(await call(searchApi, { query: `?q=${FREE_TOKEN}`, headers: r.headers() }));
      const freeResults = arr(rec(freeHit.data).results);
      expect(freeResults.length).toBe(1);
      if (!r.full) expectLeak(JSON.stringify(freeResults), false);
      expect(rec(freeResults[0]).full_text).toBe(r.full);

      // Paid-only terms: not found at all (not even as a title-only hit) without read_full.
      const paidHit = await payload(await call(searchApi, { query: `?q=${PAID_TOKENS[0]}`, headers: r.headers() }));
      const paidResults = arr(rec(paidHit.data).results);
      expect(paidResults.length).toBe(r.full ? 1 : 0);
      if (r.full) expect(String(rec(paidResults[0]).snippet)).toContain(`**${PAID_TOKENS[0]}**`);

      const mcpSearch = rec(await taxonomyMcpModule.call('knowledge_search', { query: PAID_TOKENS[1] }, ctx));
      expect(arr(mcpSearch.results).length).toBe(r.full ? 1 : 0);

      // Discovery list with q uses the same authorization-first search.
      const listed = await payload(await call(listApi, { query: `?q=${PAID_TOKENS[2]}`, headers: r.headers() }));
      expect(arr(listed.data).length).toBe(r.full ? 1 : 0);
    });
  }

  it('declares the paywall honestly in Article JSON-LD', async () => {
    const view = await getArticleView(d1, 'kb-paid', { isAdmin: false, entitlements: [] }, { locale: 'vi' });
    if (!view) throw new Error('missing view');
    const ld = articleJsonLd(view, 'https://zuey.me', 'https://zuey.me/og.png');
    expect(ld.isAccessibleForFree).toBe(false);
    expect(JSON.stringify(ld.hasPart)).toContain('.zb-paywalled');
    expectLeak(JSON.stringify(ld), false);
  });
});

// ---------- Search: authorization before ranking ----------

describe('FTS search applies authorization before ranking', () => {
  it('maps principals to index tiers', async () => {
    expect(allowedTiers(await resolvePrincipal(new Request('https://zuey.test/'), { DB: d1 }))).toEqual(['free', 'preview']);
    expect(allowedTiers(await resolvePrincipal(new Request('https://zuey.test/', { headers: bearer(readerKey) }), { DB: d1 }))).toEqual(['free', 'full']);
  });

  it('never returns disallowed tiers even when the vector index ignores its filter', async () => {
    const filters: unknown[] = [];
    const ai: WorkersAiLike = {
      async run(_model, input) {
        const text = Array.isArray(input.text) ? input.text : [];
        return { data: text.map(() => [0.1, 0.2, 0.3]) };
      },
    };
    const article = await d1.prepare("SELECT id FROM articles WHERE slug = 'kb-paid'").first<{ id: string }>();
    if (!article) throw new Error('missing article');
    // A misbehaving index that returns every tier, including the paid full text.
    const index = {
      async query(_v: number[], opts: { filter?: Record<string, unknown> }) {
        filters.push(opts.filter);
        return { matches: ['full', 'preview'].map((tier, i) => ({ id: `${article.id}:vi:${tier}`, score: 0.9 - i / 10 })) };
      },
      async upsert() { return {}; },
      async deleteByIds() { return {}; },
    };
    const env: RuntimeEnv = Object.assign({ DB: d1, AI: ai }, { VECTORIZE: index });
    const anon = await resolvePrincipal(new Request('https://zuey.test/'), env);
    const result = await searchKnowledge(anon, 'members knowledge', 'vi', 10, env);
    expect(result.semantic).toBe(true);
    expect(JSON.stringify(filters[0])).toContain('"$in":["free","preview"]');
    expect(result.results.every(h => h.tier !== 'full')).toBe(true);
    expectNoPaid(JSON.stringify(result));
  });

  it('validates the query and reports BM25-only mode honestly', async () => {
    expect((await call(searchApi, { query: '?q=' })).status).toBe(400);
    expect((await call(searchApi, { query: `?q=${'x'.repeat(201)}` })).status).toBe(400);
    expect((await call(searchApi, { query: '?q=a&locale=xx' })).status).toBe(400);
    const res = await call(searchApi, { query: `?q=${FREE_TOKEN}&locale=vi` });
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(rec((await payload(res)).data).semantic).toBe(false);
  });
});

function expectNoPaid(text: string) {
  for (const t of PAID_TOKENS) expect(text).not.toContain(t);
}

// ---------- Locale editions, hreflang and sitemap ----------

describe('locale editions', () => {
  beforeAll(async () => {
    await create({ slug: 'kb-multi', title: 'Bài tiếng Việt', locale: 'vi', document: { version: 1, blocks: [para('Nội dung tiếng Việt')] } });
    const put = await call(putApi, {
      method: 'PUT', headers: admin(), params: { slug: 'kb-multi' },
      body: { locale: 'en', title: 'English edition', excerpt: 'In English', document: { version: 1, blocks: [para('English body text')] }, expected_revision: await revisionOf('kb-multi') },
    });
    expect(put.status).toBe(200);
    await publish('kb-multi', 'vi');
    await publish('kb-multi', 'en');
    // A Korean draft that is never published must stay invisible.
    const ko = await call(putApi, {
      method: 'PUT', headers: admin(), params: { slug: 'kb-multi' },
      body: { locale: 'ko', title: '한국어 초안', document: { version: 1, blocks: [para('초안')] }, expected_revision: await revisionOf('kb-multi') },
    });
    expect(ko.status).toBe(200);
  });

  it('serves each published edition and falls back to the primary one', async () => {
    const en = rec((await payload(await call(getApi, { params: { slug: 'kb-multi' }, query: '?lang=en' }))).data);
    expect(en.locale).toBe('en');
    expect(en.title).toBe('English edition');
    expect(en.locale_fallback).toBe(false);
    expect(arr(en.available_locales).slice().sort()).toEqual(['en', 'vi']);
    expect(en.editions).toBeUndefined();

    const ja = rec((await payload(await call(getApi, { params: { slug: 'kb-multi' }, query: '?lang=ja' }))).data);
    expect(ja.locale).toBe('vi');
    expect(ja.locale_fallback).toBe(true);

    const ko = rec((await payload(await call(getApi, { params: { slug: 'kb-multi' }, query: '?lang=ko' }))).data);
    expect(ko.locale).not.toBe('ko');
    expect(JSON.stringify(ko)).not.toContain('한국어');
    expect((await call(getApi, { params: { slug: 'kb-multi' }, query: '?lang=xx' })).status).toBe(400);
  });

  it('emits canonical and hreflang alternates for published editions only', async () => {
    const res = await call(mdApi, { params: { slug: 'kb-multi' }, path: '/articles/kb-multi.md', query: '?lang=en' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Language')).toBe('en');
    const link = res.headers.get('Link') ?? '';
    expect(link).toContain('/articles/kb-multi?lang=en>; rel="canonical"');
    expect(link).toContain('hreflang="vi"');
    expect(link).toContain('hreflang="x-default"');
    expect(link).not.toContain('hreflang="ko"');
    const md = await res.text();
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('locale: en');
    expect(md).toContain('English body text');

    const alternates = articleAlternates('https://zuey.me', 'kb-multi', ['vi', 'en']);
    expect(alternates.map(a => a.hreflang)).toEqual(['vi', 'en', 'x-default']);
    expect(linkHeader('https://zuey.me/articles/kb-multi?lang=vi', alternates)).toContain('<https://zuey.me/articles/kb-multi>; rel="alternate"; hreflang="x-default"');

    const sitemap = await (await call(sitemapApi, { path: '/sitemap.xml' })).text();
    expect(sitemap).toContain('<loc>https://zuey.test/articles/kb-multi?lang=en</loc>');
    expect(sitemap).toContain('<loc>https://zuey.test/articles/kb-multi?lang=vi</loc>');
    expect(sitemap).toContain('hreflang="x-default"');
    expect(sitemap).not.toContain('kb-multi?lang=ko');
  });

  it('records revisions per locale and protects the primary edition', async () => {
    const history = arr((await payload(await call(revisionsApi, { params: { slug: 'kb-multi' }, query: '?lang=en', headers: admin() }))).data);
    expect(history.map(h => rec(h).action)).toContain('publish');
    expect((await call(revisionsApi, { params: { slug: 'kb-multi' } })).status).toBe(401);

    const rev = await revisionOf('kb-multi');
    const primary = await payload(await call(deleteEditionApi, { method: 'DELETE', headers: admin(), params: { slug: 'kb-multi' }, body: { locale: 'vi', expected_revision: rev } }));
    expect(primary.status).toBe(409);
    const ko = await call(deleteEditionApi, { method: 'DELETE', headers: admin(), params: { slug: 'kb-multi' }, body: { locale: 'ko', expected_revision: rev } });
    expect(ko.status).toBe(200);
    const editions = rec((await payload(await call(getApi, { params: { slug: 'kb-multi' }, query: '?draft=1', headers: admin() }))).data).editions;
    expect(arr(editions).map(e => rec(e).locale).sort()).toEqual(['en', 'vi']);
  });
});

// ---------- Tags ----------

describe('topic tag validation', () => {
  it('creates tags with stable ids and rejects collisions and bad input', async () => {
    const created = await payload(await call(createTagApi, { method: 'POST', headers: admin(), body: { names: { vi: 'Tác tử AI', en: 'AI Agents' }, aliases: ['agents'] } }));
    expect(created.status).toBe(201);
    const tag = rec(created.data);
    expect(typeof tag.id).toBe('string');

    expect((await payload(await call(createTagApi, { method: 'POST', headers: admin(), body: { names: { en: 'agents' } } }))).code).toBe('tag_conflict');
    expect((await call(createTagApi, { method: 'POST', headers: admin(), body: { names: { en: 'x' }, slug: 'Bad Slug' } })).status).toBe(400);
    expect((await call(createTagApi, { method: 'POST', headers: admin(), body: { names: { en: 'y'.repeat(41) } } })).status).toBe(400);
    expect((await call(createTagApi, { method: 'POST', body: { names: { en: 'anon' } } })).status).toBe(401);

    const renamed = await payload(await call(updateTagApi, { method: 'PUT', headers: admin(), params: { id: String(tag.id) }, body: { names: { en: 'Agentic AI' }, expected_revision: tag.revision } }));
    expect(renamed.status).toBe(200);
    expect(rec(renamed.data).id).toBe(tag.id);
    const stale = await payload(await call(updateTagApi, { method: 'PUT', headers: admin(), params: { id: String(tag.id) }, body: { names: { en: 'Again' }, expected_revision: tag.revision } }));
    expect(stale.code).toBe('revision_conflict');
  });

  it('limits article tags and only links existing tags through the tags endpoint', async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `tag-${i}`);
    expect((await call(createApi, { method: 'POST', headers: admin(), body: { slug: 'kb-too-many', title: 'X', tags: tooMany } })).status).toBe(400);
    expect((await call(createApi, { method: 'POST', headers: admin(), body: { slug: 'kb-long-tag', title: 'X', tags: ['z'.repeat(41)] } })).status).toBe(400);

    await create({ slug: 'kb-tagged', title: 'Tagged', tags: ['agents', 'Brand New Topic'], document: { version: 1, blocks: [para('Tagged body')] } });
    const draft = rec((await payload(await call(getApi, { params: { slug: 'kb-tagged' }, query: '?draft=1', headers: admin() }))).data);
    const names = arr(draft.topic_tags).map(t => rec(t).slug);
    expect(names).toContain('brand-new-topic');
    expect(names.length).toBe(2);

    const unknown = await payload(await call(articleTagsApi, { method: 'PUT', headers: admin(), params: { slug: 'kb-tagged' }, body: { tags: ['does-not-exist'], expected_revision: draft.revision } }));
    expect(unknown.code).toBe('unknown_tag');

    // Public facets only list taxonomy used by published articles.
    const facets = JSON.stringify((await payload(await call(facetsApi, { query: '?lang=en' }))).data);
    expect(facets).not.toContain('brand-new-topic');
    await publish('kb-tagged');
    const after = JSON.stringify((await payload(await call(facetsApi, { query: '?lang=en' }))).data);
    expect(after).toContain('brand-new-topic');
    const filtered = arr((await payload(await call(listApi, { query: '?tag=brand-new-topic' }))).data);
    expect(filtered.map(a => rec(a).slug)).toEqual(['kb-tagged']);
  });
});

// ---------- Labels: proposals, approval, conflicts, revert ----------

describe('label proposals and revert', () => {
  let labelRevision = 0;

  beforeAll(async () => {
    await create({ slug: 'kb-labels', title: 'Labelled', document: { version: 1, blocks: [para('Text about agents', 'b1')] } });
    await publish('kb-labels');
  });

  async function labels(): Promise<Record<string, unknown>> {
    const res = await payload(await call(labelsGetApi, { params: { slug: 'kb-labels' }, headers: admin() }));
    expect(res.status).toBe(200);
    return rec(res.data);
  }

  async function propose(label: string): Promise<Record<string, unknown>> {
    const res = await payload(await call(createProposalApi, {
      method: 'POST', headers: admin(), body: { article_slug: 'kb-labels', locale: 'vi', assignments: [{ label, scope: 'locale', locale: 'vi' }], rationale: 'test' },
    }));
    expect(res.status).toBe(201);
    return rec(res.data);
  }

  it('rejects unverified facts on manual apply and downgrades them in proposals', async () => {
    const strict = await payload(await call(labelsPutApi, {
      method: 'PUT', headers: admin(), params: { slug: 'kb-labels' }, body: { assignments: [{ label: 'claim:fact', scope: 'locale', locale: 'vi' }], expected_label_revision: 0 },
    }));
    expect(strict.status).toBe(422);
    expect(strict.code).toBe('invalid_labels');

    const proposal = await propose('claim:fact');
    expect(JSON.stringify(proposal.proposed)).toContain('lbl_fresh_needs_review');
    expect(JSON.stringify(proposal.proposed)).not.toContain('lbl_claim_fact');
    expect(arr(proposal.questions).length).toBeGreaterThan(0);
    await call(decisionApi, { method: 'POST', headers: admin(), params: { id: String(proposal.id) }, body: { decision: 'reject', reason: 'test cleanup' } });
  });

  it('proposal → approve with a label revision conflict → apply idempotently', async () => {
    const proposal = await propose('claim:opinion');
    expect(proposal.status).toBe('pending');
    const base = Number(proposal.current_label_revision);

    // Someone edits labels meanwhile.
    const manual = await payload(await call(labelsPutApi, {
      method: 'PUT', headers: admin(), params: { slug: 'kb-labels' },
      body: { assignments: [{ label: 'claim:experience', scope: 'locale', locale: 'vi' }], expected_label_revision: base, reason: 'manual' },
    }));
    expect(manual.status).toBe(200);

    const noConfirm = await payload(await call(decisionApi, { method: 'POST', headers: admin(), params: { id: String(proposal.id) }, body: { decision: 'approve', expected_label_revision: base } }));
    expect(noConfirm.status).toBe(400);
    const conflict = await payload(await call(decisionApi, {
      method: 'POST', headers: admin(), params: { id: String(proposal.id) }, body: { decision: 'approve', confirm: true, expected_label_revision: base },
    }));
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe('label_revision_conflict');

    const fresh = rec((await payload(await call(proposalApi, { params: { id: String(proposal.id) }, headers: admin() }))).data);
    expect(fresh.status).toBe('pending');
    const current = Number(fresh.current_label_revision);
    expect(current).toBe(base + 1);

    const applied = rec((await payload(await call(decisionApi, {
      method: 'POST', headers: admin(), params: { id: String(proposal.id) }, body: { decision: 'approve', confirm: true, expected_label_revision: current },
    }))).data);
    expect(applied.already_applied).toBe(false);
    expect(rec(applied.proposal).status).toBe('applied');
    const state = rec(applied.labels);
    labelRevision = Number(state.label_revision);
    expect(labelRevision).toBe(current + 1);
    expect(JSON.stringify(state.assignments)).toContain('lbl_claim_opinion');

    const again = rec((await payload(await call(decisionApi, {
      method: 'POST', headers: admin(), params: { id: String(proposal.id) }, body: { decision: 'approve', confirm: true, expected_label_revision: labelRevision },
    }))).data);
    expect(again.already_applied).toBe(true);
    expect(Number(rec(await labels()).label_revision)).toBe(labelRevision);

    // Approved labels are public on the article and in the label filter.
    const pub = rec((await payload(await call(getApi, { params: { slug: 'kb-labels' } }))).data);
    expect(JSON.stringify(pub.labels)).toContain('opinion');
    expect(JSON.stringify(pub.labels)).not.toContain('evidence');
    const filtered = arr((await payload(await call(listApi, { query: '?label=claim:opinion' }))).data);
    expect(filtered.map(a => rec(a).slug)).toContain('kb-labels');
  });

  it('reverts to an earlier label revision as a new revision', async () => {
    const before = await labels();
    const history = arr(before.history).map(h => rec(h));
    const manualRev = Number(history.find(h => h.source === 'manual')?.label_revision);
    const stale = await payload(await call(labelsRevertApi, {
      method: 'POST', headers: admin(), params: { slug: 'kb-labels' }, body: { to_label_revision: manualRev, expected_label_revision: labelRevision - 1 },
    }));
    expect(stale.code).toBe('label_revision_conflict');
    const reverted = rec((await payload(await call(labelsRevertApi, {
      method: 'POST', headers: admin(), params: { slug: 'kb-labels' }, body: { to_label_revision: manualRev, expected_label_revision: labelRevision },
    }))).data);
    expect(Number(reverted.label_revision)).toBe(labelRevision + 1);
    expect(JSON.stringify(reverted.assignments)).toContain('lbl_claim_experience');
    expect(JSON.stringify(reverted.assignments)).not.toContain('lbl_claim_opinion');
    expect(arr((await labels()).history).map(h => rec(h).source)).toContain('revert');
  });

  it('turns a proposal stale when the edition text changes', async () => {
    const proposal = await propose('claim:hypothesis');
    const put = await call(putApi, {
      method: 'PUT', headers: admin(), params: { slug: 'kb-labels' },
      body: { document: { version: 1, blocks: [para('Rewritten text', 'b1')] }, expected_revision: await revisionOf('kb-labels') },
    });
    expect(put.status).toBe(200);
    const listed = arr((await payload(await call(proposalsApi, { query: '?status=pending', headers: admin() }))).data).map(p => rec(p));
    expect(listed.find(p => p.id === proposal.id)?.outdated).toBe(true);
    const state = await labels();
    const res = await payload(await call(decisionApi, {
      method: 'POST', headers: admin(), params: { id: String(proposal.id) }, body: { decision: 'approve', confirm: true, expected_label_revision: state.label_revision },
    }));
    expect(res.code).toBe('edition_changed');
    expect(rec((await payload(await call(proposalApi, { params: { id: String(proposal.id) }, headers: admin() }))).data).status).toBe('stale');
  });

  it('runs AI audits only with the AI binding and keeps a resumable cursor', async () => {
    const job = rec((await payload(await call(createJobApi, { method: 'POST', headers: admin(), body: { locales: ['vi'], batch_size: 1 } }))).data);
    const unavailable = await payload(await call(runJobApi, { method: 'POST', headers: admin(), params: { id: String(job.id) } }));
    expect(unavailable.status).toBe(503);
    expect(unavailable.code).toBe('ai_unavailable');
    const malformed = await call(runJobApi, { method: 'POST', headers: admin(), params: { id: String(job.id) }, body: ['not', 'an', 'object'] });
    expect((await payload(malformed)).code).toBe('invalid_json');

    const calls: string[] = [];
    const ai: WorkersAiLike = {
      async run(model) {
        calls.push(model);
        return { response: JSON.stringify({ assignments: [{ label: 'claim:opinion', scope: 'locale', locale: 'vi' }], questions: [], rationale: 'Reads as opinion' }) };
      },
    };
    const first = rec((await payload(await call(runJobApi, { method: 'POST', headers: admin(), params: { id: String(job.id) }, env: { AI: ai } }))).data);
    expect(first.processed).toBe(1);
    expect(String(first.cursor)).toContain('|vi');
    expect(['paused', 'completed']).toContain(String(first.status));
    let status = String(first.status);
    for (let i = 0; i < 20 && status !== 'completed'; i++) {
      status = String(rec((await payload(await call(runJobApi, { method: 'POST', headers: admin(), params: { id: String(job.id) }, env: { AI: ai } }))).data).status);
    }
    expect(status).toBe('completed');
    expect(calls.length).toBeGreaterThan(1);
    const aiProposals = arr((await payload(await call(proposalsApi, { query: `?job_id=${String(job.id)}`, headers: admin() }))).data);
    expect(aiProposals.length).toBe(calls.length);

    expect(() => parseAiSuggestion({ response: 'not json' })).toThrow();
  });
});

// ---------- Embeds ----------

describe('embed URL recognition per provider', () => {
  const cases: Array<[string, EmbedRecognition['provider'], string | null]> = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'youtube', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    ['https://vimeo.com/76979871', 'vimeo', 'https://player.vimeo.com/video/76979871'],
    ['https://soundcloud.com/artist/track-name', 'soundcloud', 'https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Ftrack-name'],
    ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', 'spotify', 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC'],
    ['https://x.com/someone/status/1234567890123', 'x', 'https://platform.twitter.com/embed/Tweet.html?id=1234567890123&dnt=true'],
    ['https://twitter.com/someone/status/1234567890123', 'x', 'https://platform.twitter.com/embed/Tweet.html?id=1234567890123&dnt=true'],
    ['https://www.facebook.com/someone/videos/1234567890', 'facebook', 'https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fsomeone%2Fvideos%2F1234567890'],
    ['https://www.facebook.com/someone/posts/abc', 'facebook', 'https://www.facebook.com/plugins/post.php?href=https%3A%2F%2Fwww.facebook.com%2Fsomeone%2Fposts%2Fabc'],
    ['https://www.instagram.com/p/C0deAbc123/', 'instagram', 'https://www.instagram.com/p/C0deAbc123/embed'],
    ['https://www.tiktok.com/@someone/video/7012345678901234567', 'tiktok', 'https://www.tiktok.com/embed/v2/7012345678901234567'],
    ['https://www.linkedin.com/feed/update/urn:li:activity:7012345678901234567/', 'linkedin', 'https://www.linkedin.com/embed/feed/update/urn:li:activity:7012345678901234567'],
    ['https://example.com/page', 'generic', null],
    ['http://www.youtube.com/watch?v=dQw4w9WgXcQ', 'generic', null],
    ['https://www.youtube.com/watch', 'youtube', null],
  ];
  for (const [url, provider, src] of cases) {
    it(`${provider}: ${url}`, () => {
      const rec = recognizeEmbed(url);
      expect(rec.provider).toBe(provider);
      expect(rec.src).toBe(src);
    });
  }

  it('reserves the right frame shape', () => {
    expect(embedFrame('youtube', 'https://www.youtube.com/shorts/abcdefghijk')).toBe('vertical');
    expect(embedFrame('spotify', 'https://open.spotify.com/track/x')).toBe('audio');
    expect(embedFrame('vimeo', 'https://vimeo.com/1')).toBe('video');
    expect(embedFrame('x', 'https://x.com/a/status/1')).toBe('post');
  });
});

// ---------- Markdown fallbacks ----------

describe('Markdown fallbacks for every block type', () => {
  const samples: Record<string, [unknown, string]> = {
    paragraph: [para('Plain **bold** text'), 'Plain **bold** text'],
    heading: [{ type: 'heading', level: 2, text: 'Section' }, '### Section'],
    list: [{ type: 'list', style: 'number', items: ['one', 'two'] }, '2. two'],
    checklist: [{ type: 'checklist', items: [{ text: 'done', checked: true }] }, '- [x] done'],
    quote: [{ type: 'quote', text: 'Quoted', cite: 'Someone' }, '> — Someone'],
    callout: [{ type: 'callout', tone: 'tip', text: 'Hint' }, '> **TIP:** Hint'],
    code: [{ type: 'code', language: 'ts', code: 'const a = 1;' }, '```ts\nconst a = 1;\n```'],
    divider: [{ type: 'divider' }, '---'],
    image: [{ type: 'image', url: 'https://cdn.example.com/a.png', alt: 'Alt text' }, '![Alt text](https://cdn.example.com/a.png)'],
    embed: [{ type: 'embed', url: 'https://vimeo.com/76979871' }, '[Vimeo: https://vimeo.com/76979871](https://vimeo.com/76979871)'],
    table: [{ type: 'table', headers: ['A', 'B'], rows: [['1', '2']] }, '| A | B |'],
    chart: [{ type: 'chart', kind: 'bar', title: 'Sales', labels: ['Q1'], series: [{ name: 'S', data: [3] }] }, '**Sales** (bar chart)'],
    diagram: [{ type: 'diagram', syntax: 'mermaid', source: 'graph TD; A-->B' }, '```mermaid'],
    survey: [{ type: 'survey', question: 'Pick?', options: [{ label: 'A' }, { label: 'B' }] }, '**Survey:** Pick?'],
    layout: [{ type: 'layout', variant: 'columns', cols: { base: 1, md: 2, lg: 2 }, children: [{ blocks: [para('Left col')] }, { blocks: [para('Right col')] }] }, 'Left col\n\nRight col'],
    math: [{ type: 'math', tex: 'E = mc^2' }, '$$\nE = mc^2\n$$'],
    gallery: [{ type: 'gallery', images: [{ url: 'https://cdn.example.com/1.jpg', alt: 'One' }, { url: 'https://cdn.example.com/2.jpg', alt: 'Two' }] }, '![Two](https://cdn.example.com/2.jpg)'],
    audio: [{ type: 'audio', url: 'https://cdn.example.com/talk.mp3' }, '[Audio: talk.mp3](https://cdn.example.com/talk.mp3)'],
    video: [{ type: 'video', url: 'https://cdn.example.com/clip.mp4', title: 'Clip' }, '[Video: Clip](https://cdn.example.com/clip.mp4)'],
    file: [{ type: 'file', url: 'https://cdn.example.com/guide.pdf', name: 'Guide', sizeBytes: 2048 }, '[PDF: Guide, 2.0 KB](https://cdn.example.com/guide.pdf)'],
    bookmark: [{ type: 'bookmark', url: 'https://example.com/post', title: 'A post', siteName: 'Example' }, '[A post](https://example.com/post)\n\n> Example'],
    toggle: [{ type: 'toggle', summary: 'More', blocks: [para('Hidden detail')] }, '**More**\n\nHidden detail'],
  };

  for (const [type, [block, expected]] of Object.entries(samples)) {
    it(type, () => {
      expect((BLOCK_TYPES as readonly string[]).includes(type)).toBe(true);
      const res = validateDocument({ version: 1, blocks: [block] });
      if (!res.ok) throw new Error(JSON.stringify(res.errors));
      expect(res.doc.blocks[0].type).toBe(type as BlockType);
      expect(documentToMarkdown(res.doc)).toContain(expected);
    });
  }

  it('covers every knowledge block type', () => {
    const known: BlockType[] = ['paragraph', 'heading', 'list', 'checklist', 'quote', 'callout', 'code', 'divider', 'image', 'embed', 'table', 'chart', 'diagram', 'survey', 'layout', 'math', 'gallery', 'audio', 'video', 'file', 'bookmark', 'toggle'];
    expect(Object.keys(samples).sort()).toEqual([...known].sort());
  });

  it('rejects toggles nested in toggles', () => {
    const res = validateDocument({ version: 1, blocks: [{ type: 'toggle', summary: 'a', blocks: [{ type: 'toggle', summary: 'b', blocks: [] }] }] });
    expect(res.ok).toBe(false);
  });

  it('renders media blocks without loading third-party players up front', () => {
    const res = validateDocument({ version: 1, blocks: [
      { type: 'embed', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      { type: 'file', url: 'https://cdn.example.com/guide.pdf', name: 'Guide' },
    ] });
    if (!res.ok) throw new Error('invalid');
    const html = renderToStaticMarkup(createElement(BlockRenderer, { doc: res.doc, interactive: false }));
    expect(html).not.toContain('<iframe');
    expect(html).toContain('guide.pdf');
  });
});

// ---------- Registries ----------

describe('REST, OpenAPI and MCP registration', () => {
  it('registers taxonomy/search OpenAPI paths and MCP tools', () => {
    expect(OPENAPI_FRAGMENTS).toContain(taxonomyOpenApi);
    const paths = Object.keys(taxonomyOpenApi.paths);
    for (const p of ['/api/v1/search', '/api/v1/taxonomy', '/api/v1/taxonomy/tags/{id}', '/api/v1/taxonomy/proposals/{id}/decision', '/api/v1/taxonomy/audit-jobs/{id}/run']) {
      expect(paths).toContain(p);
    }
    for (const p of ['/api/v1/articles/{slug}/editions', '/api/v1/articles/{slug}/labels/revert', '/api/v1/articles/{slug}/tags']) {
      expect(Object.keys(articlesOpenApi.paths)).toContain(p);
    }
    expect(MCP_FEATURE_MODULES).toContain(taxonomyMcpModule);
    const tools = taxonomyMcpModule.tools.map(t => t.name);
    for (const t of ['knowledge_search', 'label_proposal_decide', 'label_audit_job_run', 'article_labels_revert']) expect(tools).toContain(t);
  });

  it('enforces admin on taxonomy MCP writes', async () => {
    const denied = await taxonomyMcpModule.call('tag_create', { names: { en: 'Nope' } }, mcpCtx({})).then(() => null, (e: unknown) => e);
    expect(denied).not.toBeNull();
    const created = rec(await taxonomyMcpModule.call('tag_create', { names: { en: 'MCP made' } }, mcpCtx(admin())));
    expect(created.slug).toBe('mcp-made');
  });
});
