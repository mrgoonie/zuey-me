import { describe, it, expect, beforeAll } from 'bun:test';
import type { APIRoute } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createSession } from '../src/db/store';
import { validateDocument } from '../src/lib/blocks/validate';
import { documentToMarkdown } from '../src/lib/blocks/markdown';
import { applyPaywall, canReadFull } from '../src/lib/blocks/paywall';
import type { ArticleDocument } from '../src/lib/blocks/schema';
import { articlesMcpModule, withFetchedDocument } from '../src/lib/blocks/mcp';
import { articlesOpenApi } from '../src/lib/blocks/openapi';
import { AppError } from '../src/lib/http';
import type { McpContext } from '../src/lib/mcp/types';
import { GET as listApi, POST as createApi } from '../src/pages/api/v1/articles/index';
import { GET as getApi, PUT as putApi, DELETE as deleteApi } from '../src/pages/api/v1/articles/[slug]';
import { POST as publishApi } from '../src/pages/api/v1/articles/[slug]/publish';
import { GET as mdApi } from '../src/pages/articles/[slug].md';
import { POST as voteApi } from '../src/pages/api/v1/surveys/[blockId]/vote';
import { GET as resultsApi } from '../src/pages/api/v1/surveys/[blockId]/results';
import { GET as exportApi } from '../src/pages/api/v1/surveys/[blockId]/export.csv';

const SALT = 'test-salt';

function para(text: string, id?: string) {
  return { type: 'paragraph', text, ...(id ? { id } : {}) };
}

function layout(cols: { base: number; md: number; lg: number }, children: unknown[]) {
  return { type: 'layout', variant: 'columns', cols, children };
}

function expectInvalid(input: unknown, pathPart: string) {
  const res = validateDocument(input);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.errors.some(e => e.path.includes(pathPart))).toBe(true);
}

describe('block document validation', () => {
  it('accepts a valid rich document and generates missing ids', () => {
    const res = validateDocument({
      version: 1,
      blocks: [
        { type: 'heading', level: 1, text: 'Hello' },
        para('Some **bold** text'),
        { type: 'chart', kind: 'bar', title: 'Sales', labels: ['Q1', 'Q2'], series: [{ name: '2026', data: [1, 2] }] },
        { type: 'diagram', syntax: 'mermaid', source: 'graph TD; A-->B' },
        { type: 'survey', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] },
        { type: 'embed', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
        layout({ base: 1, md: 3, lg: 5 }, [
          { span: { md: 2, lg: 3 }, blocks: [para('left')] },
          { blocks: [layout({ base: 1, md: 2, lg: 2 }, [{ blocks: [para('nested')] }])] },
        ]),
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.blocks.every(b => b.id.length > 0)).toBe(true);
    const embed = res.doc.blocks[5];
    expect(embed.type === 'embed' && embed.provider).toBe('youtube');
    const survey = res.doc.blocks[4];
    expect(survey.type === 'survey' && survey.options.map(o => o.id)).toEqual(['o1', 'o2']);
  });

  it('rejects unknown block types', () => {
    expectInvalid({ blocks: [{ type: 'html', html: '<script>' }] }, '$.blocks[0].type');
  });

  it('rejects cols out of range', () => {
    expectInvalid({ blocks: [layout({ base: 1, md: 6, lg: 5 }, [{ blocks: [] }])] }, 'cols.md');
    expectInvalid({ blocks: [layout({ base: 0, md: 2, lg: 2 }, [{ blocks: [] }])] }, 'cols.base');
  });

  it('rejects span greater than cols at a breakpoint', () => {
    expectInvalid({ blocks: [layout({ base: 1, md: 3, lg: 5 }, [{ span: { md: 4 }, blocks: [] }])] }, 'children[0].span.md');
    expectInvalid({ blocks: [layout({ base: 1, md: 2, lg: 3 }, [{ span: 4, blocks: [] }])] }, 'children[0].span');
  });

  it('rejects three levels of layout nesting', () => {
    const level3 = layout({ base: 1, md: 1, lg: 1 }, [{ blocks: [para('deep')] }]);
    const level2 = layout({ base: 1, md: 1, lg: 1 }, [{ blocks: [level3] }]);
    expectInvalid({ blocks: [layout({ base: 1, md: 2, lg: 2 }, [{ blocks: [level2] }])] }, 'children[0].blocks[0].children[0].blocks[0]');
  });

  it('rejects chart series whose length differs from labels', () => {
    expectInvalid({ blocks: [{ type: 'chart', kind: 'line', labels: ['a', 'b', 'c'], series: [{ name: 's', data: [1, 2] }] }] }, 'series[0].data');
  });

  it('rejects duplicate ids, non-https urls and oversized documents', () => {
    expectInvalid({ blocks: [para('a', 'x'), para('b', 'x')] }, '$.blocks[1].id');
    expectInvalid({ blocks: [{ type: 'image', url: 'javascript:alert(1)', alt: '' }] }, 'url');
    expectInvalid({ blocks: Array.from({ length: 501 }, () => para('x')) }, '$.blocks[500]');
  });
});

describe('markdown fallbacks', () => {
  const doc: ArticleDocument = {
    version: 1,
    blocks: [
      { id: 'c', type: 'chart', kind: 'bar', title: 'Revenue', labels: ['Q1', 'Q2'], series: [{ name: 'VN', data: [10, 20] }, { name: 'US', data: [5, 7] }] },
      { id: 'd', type: 'diagram', syntax: 'mermaid', source: 'graph TD; A-->B' },
      {
        id: 'l', type: 'layout', variant: 'grid', cols: { base: 1, md: 2, lg: 2 },
        children: [{ blocks: [{ id: 'p1', type: 'paragraph', text: 'FIRST' }] }, { blocks: [{ id: 'p2', type: 'paragraph', text: 'SECOND' }] }],
      },
      { id: 's', type: 'survey', question: 'Best?', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] },
    ],
  };
  const md = documentToMarkdown(doc, { articleUrl: 'https://zuey.me/articles/x' });

  it('renders charts as a title plus a data table', () => {
    expect(md).toContain('**Revenue**');
    expect(md).toContain('| Label | VN | US |');
    expect(md).toContain('| Q2 | 20 | 7 |');
  });

  it('renders diagrams as a mermaid fence', () => {
    expect(md).toContain('```mermaid\ngraph TD; A-->B\n```');
  });

  it('renders layout children sequentially and surveys with a vote link', () => {
    expect(md.indexOf('FIRST')).toBeGreaterThan(-1);
    expect(md.indexOf('FIRST')).toBeLessThan(md.indexOf('SECOND'));
    expect(md).toContain('- Alpha\n- Beta');
    expect(md).toContain('(vote at https://zuey.me/articles/x)');
  });
});

describe('paywall', () => {
  const doc: ArticleDocument = {
    version: 1,
    blocks: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, type: 'paragraph' as const, text: 'x'.repeat(100) })),
  };

  it('keeps roughly the first third for non-entitled viewers', () => {
    const res = applyPaywall(doc, 'knowledges', { isAdmin: false, entitlements: [] });
    expect(res.truncated).toBe(true);
    expect(res.doc.blocks.map(b => b.id)).toEqual(['p0', 'p1']);
  });

  it('keeps at least one block and gives admins/entitled viewers everything', () => {
    const big: ArticleDocument = { version: 1, blocks: [{ id: 'a', type: 'paragraph', text: 'x'.repeat(5000) }, ...doc.blocks] };
    expect(applyPaywall(big, 'knowledges', { isAdmin: false, entitlements: [] }).doc.blocks).toHaveLength(1);
    expect(applyPaywall(doc, 'knowledges', { isAdmin: true, entitlements: [] }).truncated).toBe(false);
    expect(canReadFull({ isAdmin: false, entitlements: ['read_full'] })).toBe(true);
    expect(applyPaywall(doc, 'free', { isAdmin: false, entitlements: [] }).truncated).toBe(false);
  });

  const outlined: ArticleDocument = {
    version: 1,
    blocks: [
      { id: 'h0', type: 'heading', level: 1, text: 'Public intro heading' },
      { id: 'a', type: 'paragraph', text: 'Public '.repeat(15) },
      { id: 'b', type: 'paragraph', text: 'Public '.repeat(15) },
      { id: 'h1', type: 'heading', level: 2, text: 'Locked **chapter** one' },
      { id: 'c', type: 'paragraph', text: 'WITHHELD_BODY_ONE '.repeat(6) },
      { id: 'h2', type: 'heading', level: 3, text: 'Locked chapter two' },
      { id: 'd', type: 'list', style: 'bullet', items: ['WITHHELD_ITEM_TWO', 'WITHHELD_ITEM_THREE'] },
    ],
  };

  it('outlines only the withheld headings (plain text + level) and the withheld size', () => {
    const res = applyPaywall(outlined, 'knowledges', { isAdmin: false, entitlements: [] });
    expect(res.truncated).toBe(true);
    expect(res.doc.blocks.map(b => b.id)).toEqual(['h0', 'a', 'b']);
    expect(res.outline?.headings).toEqual([{ level: 2, text: 'Locked chapter one' }, { level: 3, text: 'Locked chapter two' }]);
    expect(res.outline?.blocks).toBe(4);
    expect(res.outline?.words).toBeGreaterThan(6);
    const outline = JSON.stringify(res.outline);
    expect(outline).not.toContain('Public intro heading');
    expect(outline).not.toContain('WITHHELD');
  });

  it('gives entitled viewers and free articles no outline and no truncation', () => {
    for (const viewer of [{ isAdmin: true, entitlements: [] }, { isAdmin: false, entitlements: ['read_full'] }]) {
      const res = applyPaywall(outlined, 'knowledges', viewer);
      expect(res.truncated).toBe(false);
      expect(res.outline).toBeUndefined();
      expect(res.doc.blocks).toHaveLength(outlined.blocks.length);
    }
    const free = applyPaywall(outlined, 'free', { isAdmin: false, entitlements: [] });
    expect(free.truncated).toBe(false);
    expect(free.outline).toBeUndefined();
    expect(free.doc.blocks).toHaveLength(outlined.blocks.length);
  });
});

// ---------- Route-level tests against a real SQLite database with all migrations ----------

const d1 = createTestD1();
let adminCookie = '';

interface CallInit {
  method?: string;
  body?: unknown;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  query?: string;
  env?: Record<string, unknown>;
  path?: string;
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
    locals: { runtime: { env: { DB: d1, SURVEY_HASH_SALT: SALT, ...(init.env ?? {}) } } },
  };
  // The handlers only read request/params/locals; a full APIContext is not constructible in tests.
  return handler(context as unknown as Parameters<APIRoute>[0]);
}

async function json(res: Response): Promise<{ success: boolean; data: unknown; error?: { code: string; results?: unknown } }> {
  return res.json();
}

function mcpCtx(isAdmin: boolean): McpContext {
  return {
    request: new Request('https://zuey.test/api/mcp'),
    env: {},
    d1,
    async requireAdmin() { if (!isAdmin) throw new AppError(401, 'unauthorized', 'Unauthorized'); },
    async isAdmin() { return isAdmin; },
  };
}

const PAID_SECRETS = ['PAID_SECRET_ONE', 'PAID_SECRET_TWO', 'PAID_SECRET_THREE', 'PAID_SECRET_FOUR'];

async function createAndPublish(slug: string, access: 'free' | 'knowledges', blocks: unknown[]): Promise<number> {
  const created = await call(createApi, { method: 'POST', headers: { cookie: adminCookie }, body: { slug, title: `T ${slug}`, access, document: { version: 1, blocks } } });
  expect(created.status).toBe(201);
  const rev = 1; // new drafts start at revision 1
  const pub = await call(publishApi, { method: 'POST', headers: { cookie: adminCookie }, params: { slug }, body: { expected_revision: rev, confirm: true } });
  expect(pub.status).toBe(200);
  return rev + 1;
}

beforeAll(async () => {
  adminCookie = `zuey_session=${await createSession('admin@zuey.me', d1)}`;
});

describe('articles REST, Markdown and MCP', () => {
  it('rejects anonymous writes and invalid documents', async () => {
    expect((await call(createApi, { method: 'POST', body: { slug: 'x', title: 'X' } })).status).toBe(401);
    const res = await call(createApi, { method: 'POST', headers: { cookie: adminCookie }, body: { slug: 'bad-doc', title: 'Bad', document: { blocks: [{ type: 'nope' }] } } });
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error?.code).toBe('invalid_document');
  });

  it('keeps drafts private, publishes with confirm, and detects revision conflicts', async () => {
    const created = await call(createApi, { method: 'POST', headers: { cookie: adminCookie }, body: { slug: 'draft-flow', title: 'Draft', document: { blocks: [para('v1 text')] } } });
    expect(created.status).toBe(201);
    expect((await call(getApi, { params: { slug: 'draft-flow' } })).status).toBe(404);
    expect((await call(getApi, { params: { slug: 'draft-flow' }, query: '?draft=1' })).status).toBe(401);

    const put = await call(putApi, { method: 'PUT', headers: { cookie: adminCookie }, params: { slug: 'draft-flow' }, body: { expected_revision: 1, document: { blocks: [para('v2 text')] } } });
    expect(put.status).toBe(200);
    const stale = await call(putApi, { method: 'PUT', headers: { cookie: adminCookie }, params: { slug: 'draft-flow' }, body: { expected_revision: 1, title: 'Stale' } });
    expect(stale.status).toBe(409);
    expect((await json(stale)).error?.code).toBe('revision_conflict');

    const noConfirm = await call(publishApi, { method: 'POST', headers: { cookie: adminCookie }, params: { slug: 'draft-flow' }, body: { expected_revision: 2 } });
    expect(noConfirm.status).toBe(400);
    const pub = await call(publishApi, { method: 'POST', headers: { cookie: adminCookie }, params: { slug: 'draft-flow' }, body: { expected_revision: 2, confirm: true } });
    expect(pub.status).toBe(200);

    const pubRes = await call(getApi, { params: { slug: 'draft-flow' } });
    expect(JSON.stringify(await json(pubRes))).toContain('v2 text');
    const list = await json(await call(listApi));
    expect(JSON.stringify(list.data)).toContain('draft-flow');

    expect((await call(deleteApi, { method: 'DELETE', headers: { cookie: adminCookie }, params: { slug: 'draft-flow' } })).status).toBe(200);
    expect((await call(getApi, { params: { slug: 'draft-flow' } })).status).toBe(404);
  });

  it('withholds the paid remainder from REST, .md and MCP for non-entitled readers', async () => {
    await createAndPublish('paid', 'knowledges', [
      para('Free intro paragraph one with enough text to count, plus a longer lead-in sentence.'),
      para('Free intro paragraph two with enough text to count, plus a longer lead-in sentence.'),
      ...PAID_SECRETS.map(s => para(`${s} paid paragraph with enough text to count.`)),
    ]);

    const rest = await call(getApi, { params: { slug: 'paid' } });
    const restText = JSON.stringify(await json(rest));
    expect(restText).toContain('"truncated":true');
    for (const s of PAID_SECRETS) expect(restText).not.toContain(s);

    const md = await (await call(mdApi, { params: { slug: 'paid' }, path: '/articles/paid.md' })).text();
    expect(md).toContain('Free intro paragraph one');
    expect(md).toContain('Phần còn lại dành cho thành viên có quyền đọc toàn bài');
    expect(md).toContain('/pricing');
    for (const s of PAID_SECRETS) expect(md).not.toContain(s);

    const anonMcp = JSON.stringify(await articlesMcpModule.call('article_get', { slug: 'paid' }, mcpCtx(false)));
    for (const s of PAID_SECRETS) expect(anonMcp).not.toContain(s);
    const anonMcpMd = JSON.stringify(await articlesMcpModule.call('article_get', { slug: 'paid', format: 'markdown' }, mcpCtx(false)));
    for (const s of PAID_SECRETS) expect(anonMcpMd).not.toContain(s);

    const adminRest = JSON.stringify(await json(await call(getApi, { params: { slug: 'paid' }, headers: { cookie: adminCookie } })));
    for (const s of PAID_SECRETS) expect(adminRest).toContain(s);
    const adminMcp = JSON.stringify(await articlesMcpModule.call('article_get', { slug: 'paid' }, mcpCtx(true)));
    expect(adminMcp).toContain(PAID_SECRETS[3]);
  });

  it('returns a locked outline of withheld headings without leaking withheld text', async () => {
    await createAndPublish('paid-outline', 'knowledges', [
      { type: 'heading', level: 1, text: 'Open heading' },
      para('Free intro paragraph one with enough text to count, plus a longer lead-in sentence.'),
      para('Free intro paragraph two with enough text to count, plus a longer lead-in sentence.'),
      { type: 'heading', level: 2, text: 'Members chapter' },
      ...PAID_SECRETS.map(s => para(`${s} paid paragraph with enough text to count.`)),
      { type: 'heading', level: 3, text: 'Members appendix' },
    ]);

    const restBody = await json(await call(getApi, { params: { slug: 'paid-outline' } }));
    const restText = JSON.stringify(restBody);
    for (const s of PAID_SECRETS) expect(restText).not.toContain(s);
    const data = restBody.data;
    const outline = typeof data === 'object' && data !== null && 'locked_outline' in data ? data.locked_outline : undefined;
    expect(outline).toEqual({ headings: [{ level: 2, text: 'Members chapter' }, { level: 3, text: 'Members appendix' }], blocks: 6, words: expect.any(Number) });

    const anonMcp = JSON.stringify(await articlesMcpModule.call('article_get', { slug: 'paid-outline' }, mcpCtx(false)));
    expect(anonMcp).toContain('Members chapter');
    for (const s of PAID_SECRETS) expect(anonMcp).not.toContain(s);
    const md = await (await call(mdApi, { params: { slug: 'paid-outline' }, path: '/articles/paid-outline.md' })).text();
    for (const s of PAID_SECRETS) expect(md).not.toContain(s);

    const adminText = JSON.stringify(await json(await call(getApi, { params: { slug: 'paid-outline' }, headers: { cookie: adminCookie } })));
    expect(adminText).not.toContain('locked_outline');
    expect(adminText).toContain(PAID_SECRETS[0]);
  });

  it('enforces admin on MCP writes and exposes the block schema', async () => {
    const denied = await articlesMcpModule.call('article_create', { slug: 'mcp-x', title: 'X' }, mcpCtx(false)).then(() => null, (e: unknown) => e);
    expect(denied).toBeInstanceOf(AppError);
    const created = await articlesMcpModule.call('article_create', { slug: 'mcp-x', title: 'X', document: { blocks: [para('hi')] } }, mcpCtx(true));
    expect(JSON.stringify(created)).toContain('mcp-x');
    const schema = JSON.stringify(await articlesMcpModule.call('block_schema', {}, mcpCtx(false)));
    expect(schema).toContain('BlockLayout');
    expect(Object.keys(articlesOpenApi.paths)).toContain('/api/v1/surveys/{blockId}/vote');
  });

  it('backdates published_at on publish and rejects future dates', async () => {
    const created = await call(createApi, { method: 'POST', headers: { cookie: adminCookie }, body: { slug: 'backdated', title: 'B', document: { version: 1, blocks: [para('old post')] } } });
    expect(created.status).toBe(201);
    const future = await call(publishApi, { method: 'POST', headers: { cookie: adminCookie }, params: { slug: 'backdated' }, body: { expected_revision: 1, confirm: true, published_at: '2999-01-01' } });
    expect(future.status).toBe(400);
    const pub = await call(publishApi, { method: 'POST', headers: { cookie: adminCookie }, params: { slug: 'backdated' }, body: { expected_revision: 1, confirm: true, published_at: '2026-03-16T09:00:00+07:00' } });
    expect(pub.status).toBe(200);
    expect(JSON.stringify(await json(pub))).toContain('"published_at":"2026-03-16T02:00:00.000Z"');
  });

  it('resolves document_url only from the first-party media host', async () => {
    const doc = { version: 1, blocks: [para('from url')] };
    const fetcher = (async () => new Response(JSON.stringify({ document: doc }))) as unknown as typeof fetch;
    const resolved = await withFetchedDocument({ slug: 'x', document_url: 'https://media.zuey.me/imports/x.json' }, fetcher);
    expect(resolved.document).toEqual(doc);
    expect(resolved).not.toHaveProperty('document_url');
    const withMeta = (async () => new Response(JSON.stringify({ document: doc, title: 'From payload', excerpt: 'E', tags: ['AI'], slug: 'ignored' }))) as unknown as typeof fetch;
    const merged = await withFetchedDocument({ slug: 'x', title: 'Explicit', document_url: 'https://media.zuey.me/x.json' }, withMeta);
    expect(merged).toMatchObject({ slug: 'x', title: 'Explicit', excerpt: 'E', tags: ['AI'], document: doc });
    const edition = (async () => new Response(JSON.stringify({ document: doc, locale: 'en', primary_locale: 'en' }))) as unknown as typeof fetch;
    expect(await withFetchedDocument({ document_url: 'https://media.zuey.me/x.json' }, edition)).toMatchObject({ locale: 'en', primary_locale: 'en' });
    const update = await withFetchedDocument({ document_url: 'https://media.zuey.me/x.json' }, edition, 'update');
    expect(update).toMatchObject({ locale: 'en' });
    expect(update).not.toHaveProperty('primary_locale');
    const bare = await withFetchedDocument({ document_url: 'https://media.zuey.me/x.json' }, (async () => new Response(JSON.stringify(doc))) as unknown as typeof fetch);
    expect(bare.document).toEqual(doc);
    for (const bad of ['http://media.zuey.me/x.json', 'https://evil.example/x.json', 'https://media.zuey.me.evil.example/x.json', 'nope']) {
      await expect(withFetchedDocument({ document_url: bad }, fetcher)).rejects.toBeInstanceOf(AppError);
    }
    const failing = (async () => new Response('missing', { status: 404 })) as unknown as typeof fetch;
    await expect(withFetchedDocument({ document_url: 'https://media.zuey.me/x.json' }, failing)).rejects.toBeInstanceOf(AppError);
    const redirecting = (async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })) as unknown as typeof fetch;
    await expect(withFetchedDocument({ document_url: 'https://media.zuey.me/x.json' }, redirecting)).rejects.toBeInstanceOf(AppError);
    const inline = { document: doc, document_url: 'https://evil.example/x.json' };
    expect(await withFetchedDocument(inline, fetcher)).toBe(inline);
  });
});

describe('surveys', () => {
  const surveyBlock = { id: 'poll', type: 'survey', question: 'Favourite?', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] };

  beforeAll(async () => {
    await createAndPublish('poll-article', 'free', [para('Intro'), surveyBlock]);
    await createAndPublish('locked-poll', 'knowledges', [
      para('Public intro paragraph with some words in it.'),
      para('Members paragraph with plenty of words to weigh more.'),
      para('Another members paragraph with plenty of words.'),
      { ...surveyBlock, id: 'locked' },
    ]);
  });

  const vote = (cookie: string | null, ip: string, optionIds: string[] = ['a'], blockId = 'poll', slug = 'poll-article', env?: Record<string, unknown>) =>
    call(voteApi, {
      method: 'POST',
      params: { blockId },
      headers: { 'cf-connecting-ip': ip, ...(cookie ? { cookie: `zuey_voter=${cookie}` } : {}) },
      body: { article_slug: slug, option_ids: optionIds },
      env,
    });

  it('allows one vote per anonymous voter and counts different voters separately', async () => {
    const first = await vote('voterAAAAAAAAAAAAAAAA', '10.0.0.1');
    expect(first.status).toBe(201);
    const firstBody = await json(first);
    expect(JSON.stringify(firstBody.data)).toContain('"total_voters":1');

    const again = await vote('voterAAAAAAAAAAAAAAAA', '10.0.0.1', ['b']);
    expect(again.status).toBe(409);
    const againBody = await json(again);
    expect(againBody.error?.code).toBe('already_voted');
    expect(JSON.stringify(againBody.error?.results)).toContain('"total_voters":1');

    const other = await vote('voterBBBBBBBBBBBBBBBB', '10.0.0.1', ['b']);
    expect(other.status).toBe(201);

    const results = await json(await call(resultsApi, { params: { blockId: 'poll' }, query: '?article_slug=poll-article', headers: { cookie: 'zuey_voter=voterAAAAAAAAAAAAAAAA' } }));
    const text = JSON.stringify(results.data);
    expect(text).toContain('"total_voters":2');
    expect(text).toContain('"voted":true');
    expect(text).toContain('"percent":50');
  });

  it('issues an HttpOnly voter cookie for first-time anonymous voters', async () => {
    const res = await vote(null, '10.0.0.2');
    expect(res.status).toBe(201);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('zuey_voter=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('rejects invalid options, missing salt and surveys inside the paywalled part', async () => {
    expect((await vote('voterCCCCCCCCCCCCCCCC', '10.0.0.3', ['a', 'b'])).status).toBe(400);
    expect((await vote('voterCCCCCCCCCCCCCCCC', '10.0.0.3', ['zzz'])).status).toBe(400);
    const unconfigured = await vote('voterCCCCCCCCCCCCCCCC', '10.0.0.3', ['a'], 'poll', 'poll-article', { SURVEY_HASH_SALT: undefined });
    expect(unconfigured.status).toBe(503);
    const locked = await vote('voterCCCCCCCCCCCCCCCC', '10.0.0.3', ['a'], 'locked', 'locked-poll');
    expect(locked.status).toBe(403);
    expect((await json(locked)).error?.code).toBe('survey_locked');
  });

  it('rate limits votes per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      statuses.push((await vote(`rate${String(i).padStart(2, '0')}xxxxxxxxxxxxxx`, '10.9.9.9')).status);
    }
    expect(statuses.slice(0, 20).every(s => s === 201)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('exports CSV for admins only, without raw voter keys or IPs', async () => {
    expect((await call(exportApi, { params: { blockId: 'poll' }, query: '?article_slug=poll-article' })).status).toBe(401);
    const res = await call(exportApi, { params: { blockId: 'poll' }, query: '?article_slug=poll-article', headers: { cookie: adminCookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const csv = await res.text();
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('"voted_at","voter","option_ids","option_labels"');
    expect(lines.length).toBeGreaterThan(3);
    expect(csv).toContain('Alpha');
    expect(csv).not.toContain('10.0.0.1');
    expect(csv).not.toContain('a:');
  });
});
