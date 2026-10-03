import { describe, it, expect, beforeEach } from 'vitest';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createApiKey } from '../src/db/store';
import type { D1DatabaseLike } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { AppError } from '../src/lib/http';
import { syncReads } from '../src/lib/reads/sync';
import type { Summarizer, SummaryInput } from '../src/lib/reads/summarizer';
import { WorkersAiSummarizer } from '../src/lib/reads/summarizer';
import { readsMcpModule } from '../src/lib/reads/mcp';
import type { McpContext } from '../src/lib/mcp/types';
import { GET as getReadsApi } from '../src/pages/api/v1/reads/index';
import { POST as postReadsSync } from '../src/pages/api/v1/reads/sync';
import { GET as getReadsMd } from '../src/pages/reads.md';

interface FakeDoc {
  id: string;
  title: string;
  tags: string;
  markdown: string;
  language?: string;
  source_kind?: string;
}

/** Fake AnyMD: serves the library in pages of `pageSize` with numeric cursors, plus ?format=md bodies. */
function fakeAnyMd(docs: FakeDoc[], pageSize = 2) {
  const calls: string[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push(input);
    const headers = new Headers(init?.headers);
    if (headers.get('authorization') !== 'Bearer test-key') {
      return Response.json({ error: { code: 'unauthorized', message: 'bad key' } }, { status: 401 });
    }
    const url = new URL(input);
    const mdMatch = url.pathname.match(/\/library\/([^/]+)$/);
    if (mdMatch) {
      const doc = docs.find(d => d.id === decodeURIComponent(mdMatch[1]));
      return doc ? new Response(doc.markdown) : Response.json({ error: { code: 'not_found', message: 'nope' } }, { status: 404 });
    }
    const before = url.searchParams.get('before');
    const start = before === null ? 0 : Number(before);
    const slice = docs.slice(start, start + pageSize);
    const next = start + pageSize < docs.length ? start + pageSize : null;
    return Response.json({
      items: slice.map((d, i) => ({
        id: d.id,
        url: `https://example.com/${d.id}`,
        title: d.title,
        author: 'Author',
        description: 'desc',
        domain: 'example.com',
        site: 'Example',
        image: null,
        published: '2026-09-01',
        language: d.language ?? 'en',
        source_kind: d.source_kind ?? 'article',
        tags: d.tags,
        word_count: 100,
        created_at: 1000 + start + i,
        updated_at: 2000 + start + i,
      })),
      next_cursor: next,
    });
  };
  return { fetchImpl, calls };
}

function countingSummarizer(): Summarizer & { calls: SummaryInput[] } {
  const calls: SummaryInput[] = [];
  return {
    calls,
    async summarize(input) {
      calls.push(input);
      return `Summary of ${input.title}`;
    },
  };
}

function ctx(env: RuntimeEnv, opts: { method?: string; path?: string; token?: string } = {}): APIContext {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const request = new Request(`http://localhost:4321${opts.path ?? '/'}`, { method: opts.method ?? 'GET', headers });
  // Route handlers only read `request` and `locals.runtime.env`; the rest of APIContext is unused here.
  const partial = { request, params: {}, locals: { runtime: { env } } };
  return partial as unknown as APIContext;
}

async function rows(d1: ReturnType<typeof createTestD1>) {
  return d1.raw.query('SELECT id, visible, summary, content_hash FROM reads ORDER BY id').all() as Array<{
    id: string;
    visible: number;
    summary: string | null;
    content_hash: string | null;
  }>;
}

const baseDocs = (): FakeDoc[] => [
  { id: 'a', title: 'Alpha', tags: 'ai zuey-reads', markdown: '# Alpha body' },
  { id: 'b', title: 'Beta', tags: 'misc', markdown: '# Beta body' },
  { id: 'c', title: 'Gamma', tags: 'zuey-reads', markdown: '# Gamma body', language: 'vi', source_kind: 'youtube' },
];

describe('Zuey Reads sync', () => {
  let d1: ReturnType<typeof createTestD1>;
  beforeEach(() => {
    d1 = createTestD1();
  });

  it('first sync stores only tagged items across pages and summarizes each once', async () => {
    const anymd = fakeAnyMd(baseDocs());
    const summarizer = countingSummarizer();
    const run = await syncReads({ d1, apiKey: 'test-key', fetchImpl: anymd.fetchImpl, summarizer });
    expect(run.status).toBe('success');
    expect(run.fetched).toBe(3);
    expect(run.tagged).toBe(2);
    expect(run.summarized).toBe(2);
    expect(summarizer.calls.length).toBe(2);
    expect(anymd.calls.filter(c => c.includes('/library?')).length).toBe(2);
    const stored = await rows(d1);
    expect(stored.map(r => r.id)).toEqual(['a', 'c']);
    expect(stored.every(r => r.visible === 1 && r.summary && r.content_hash)).toBe(true);
    // Raw markdown is never persisted.
    const dump = JSON.stringify(d1.raw.query('SELECT * FROM reads').all());
    expect(dump).not.toContain('Alpha body');
  });

  it('second sync with unchanged content does not call the LLM', async () => {
    const docs = baseDocs();
    await syncReads({ d1, apiKey: 'test-key', fetchImpl: fakeAnyMd(docs).fetchImpl, summarizer: countingSummarizer() });
    const summarizer = countingSummarizer();
    const run = await syncReads({ d1, apiKey: 'test-key', fetchImpl: fakeAnyMd(docs).fetchImpl, summarizer });
    expect(summarizer.calls.length).toBe(0);
    expect(run.unchanged).toBe(2);
  });

  it('changed content triggers exactly one new summary', async () => {
    const docs = baseDocs();
    await syncReads({ d1, apiKey: 'test-key', fetchImpl: fakeAnyMd(docs).fetchImpl, summarizer: countingSummarizer() });
    docs[2].markdown = '# Gamma body v2';
    const summarizer = countingSummarizer();
    const run = await syncReads({ d1, apiKey: 'test-key', fetchImpl: fakeAnyMd(docs).fetchImpl, summarizer });
    expect(summarizer.calls.length).toBe(1);
    expect(summarizer.calls[0].title).toBe('Gamma');
    expect(run.summarized).toBe(1);
    expect(run.unchanged).toBe(1);
  });

  it('removing the tag hides the item and excludes it from GET /api/v1/reads', async () => {
    const docs = baseDocs();
    await syncReads({ d1, apiKey: 'test-key', fetchImpl: fakeAnyMd(docs).fetchImpl, summarizer: countingSummarizer() });
    docs[0].tags = 'ai';
    const run = await syncReads({ d1, apiKey: 'test-key', fetchImpl: fakeAnyMd(docs).fetchImpl, summarizer: countingSummarizer() });
    expect(run.hidden).toBe(1);
    expect((await rows(d1)).find(r => r.id === 'a')?.visible).toBe(0);

    const res = await getReadsApi(ctx({ DB: d1 }, { path: '/api/v1/reads' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items.map((i: { id: string }) => i.id)).toEqual(['c']);
    expect(body.data.sources).toEqual([{ source_kind: 'youtube', count: 1 }]);
    expect(typeof body.data.last_synced_at).toBe('string');

    const search = await (await getReadsApi(ctx({ DB: d1 }, { path: '/api/v1/reads?q=gamma&source=youtube' }))).json();
    expect(search.data.total).toBe(1);
    const none = await (await getReadsApi(ctx({ DB: d1 }, { path: '/api/v1/reads?q=alpha' }))).json();
    expect(none.data.total).toBe(0);
  });

  it('does not hide anything when the crawl fails part-way', async () => {
    const docs = baseDocs();
    await syncReads({ d1, apiKey: 'test-key', fetchImpl: fakeAnyMd(docs).fetchImpl, summarizer: countingSummarizer() });
    const good = fakeAnyMd(docs).fetchImpl;
    const flaky = async (input: string, init?: RequestInit) =>
      input.includes('before=') ? new Response('boom', { status: 500 }) : good(input, init);
    const run = await syncReads({ d1, apiKey: 'test-key', fetchImpl: flaky, summarizer: countingSummarizer() });
    expect(run.status).toBe('partial');
    expect(run.hidden).toBe(0);
    expect((await rows(d1)).find(r => r.id === 'c')?.visible).toBe(1);
  });

  it('maps AnyMD 401 to anymd_unauthorized and records a failed run', async () => {
    const anymd = fakeAnyMd(baseDocs());
    let caught: unknown;
    try {
      await syncReads({ d1, apiKey: 'wrong', fetchImpl: anymd.fetchImpl, summarizer: countingSummarizer() });
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof AppError && caught.code === 'anymd_unauthorized').toBe(true);
    const run = d1.raw.query('SELECT status FROM reads_sync_runs').get() as { status: string };
    expect(run.status).toBe('failed');
  });

  it('WorkersAiSummarizer parses { response } and rejects other shapes', async () => {
    const ok = new WorkersAiSummarizer({ run: async () => ({ response: '  Hello.  ' }) });
    expect(await ok.summarize({ title: 't', url: 'u', language: 'vi', markdown: 'x' })).toBe('Hello.');
    const bad = new WorkersAiSummarizer({ run: async () => ({ nope: 1 }) });
    await expect(bad.summarize({ title: 't', url: 'u', language: 'en', markdown: 'x' })).rejects.toThrow();
  });
});

describe('Zuey Reads routes', () => {
  let d1: ReturnType<typeof createTestD1>;
  let adminKey: string;
  let readKey: string;
  beforeEach(async () => {
    d1 = createTestD1();
    adminKey = (await createApiKey('t', 'admin', d1)).key;
    readKey = (await createApiKey('r', 'read', d1)).key;
  });

  const fakeAi = { run: async () => ({ response: 'ok' }) };

  it('POST /api/v1/reads/sync without auth returns 401, read key returns 403', async () => {
    const env: RuntimeEnv = { DB: d1, ANYMD_API_KEY: 'k', AI: fakeAi };
    const res = await postReadsSync(ctx(env, { method: 'POST', path: '/api/v1/reads/sync' }));
    expect(res.status).toBe(401);
    expect((await res.json()).success).toBe(false);
    const forbidden = await postReadsSync(ctx(env, { method: 'POST', path: '/api/v1/reads/sync', token: readKey }));
    expect(forbidden.status).toBe(403);
  });

  it('returns honest 503 errors when AnyMD key or AI binding is missing', async () => {
    const noKey = await postReadsSync(ctx({ DB: d1, AI: fakeAi }, { method: 'POST', token: adminKey }));
    expect(noKey.status).toBe(503);
    expect((await noKey.json()).error.code).toBe('anymd_unconfigured');

    const noAi = await postReadsSync(ctx({ DB: d1, ANYMD_API_KEY: 'k' }, { method: 'POST', token: adminKey }));
    expect(noAi.status).toBe(503);
    expect((await noAi.json()).error.code).toBe('llm_unconfigured');
    expect(d1.raw.query('SELECT count(*) AS n FROM reads').get()).toEqual({ n: 0 });
  });

  it('GET /reads.md renders summaries and the AI notice', async () => {
    await syncReads({ d1, apiKey: 'test-key', fetchImpl: fakeAnyMd(baseDocs()).fetchImpl, summarizer: countingSummarizer() });
    const res = await getReadsMd(ctx({ DB: d1 }));
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const md = await res.text();
    expect(md).toContain('# Zuey Reads');
    expect(md).toContain('[Alpha](https://example.com/a)');
    expect(md).toContain('Summary of Gamma');
    expect(md).toContain('AI');
    expect(md).not.toContain('Beta');
  });

  it('include_hidden requires admin', async () => {
    const res = await getReadsApi(ctx({ DB: d1 }, { path: '/api/v1/reads?include_hidden=1' }));
    expect(res.status).toBe(401);
    const ok = await getReadsApi(ctx({ DB: d1 }, { path: '/api/v1/reads?include_hidden=1', token: adminKey }));
    expect(ok.status).toBe(200);
  });
});

describe('Zuey Reads MCP module', () => {
  function mcpCtx(d1: D1DatabaseLike, admin: boolean, env: RuntimeEnv = {}): McpContext {
    return {
      request: new Request('http://localhost/api/mcp', { method: 'POST' }),
      env: { DB: d1, ...env },
      d1,
      async requireAdmin() {
        if (!admin) throw new AppError(401, 'unauthorized', 'Admin required');
      },
      async isAdmin() {
        return admin;
      },
    };
  }

  it('reads_list is public and reads_sync requires admin', async () => {
    const d1 = createTestD1();
    await syncReads({ d1, apiKey: 'test-key', fetchImpl: fakeAnyMd(baseDocs()).fetchImpl, summarizer: countingSummarizer() });
    expect(readsMcpModule.tools.map(t => t.name)).toEqual(['reads_list', 'reads_sync']);

    const list = await readsMcpModule.call('reads_list', { q: 'alpha', limit: 5 }, mcpCtx(d1, false));
    expect(list).toMatchObject({ total: 1, items: [{ id: 'a', summary: 'Summary of Alpha' }] });

    await expect(readsMcpModule.call('reads_sync', {}, mcpCtx(d1, false))).rejects.toThrow('Admin required');
    let caught: unknown;
    try {
      await readsMcpModule.call('reads_sync', {}, mcpCtx(d1, true));
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof AppError && caught.code === 'anymd_unconfigured').toBe(true);
  });
});
