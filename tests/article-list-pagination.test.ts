import { describe, it, expect, beforeAll } from 'bun:test';
import type { APIRoute } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createSession } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { articlesMcpModule } from '../src/lib/blocks/mcp';
import { ARTICLE_PAGE_SIZE, MAX_ARTICLE_PAGE, applyWindow, pageWindow, queryWindow, throughPageWindow } from '../src/lib/blocks/pagination';
import { parseDiscoveryQuery } from '../src/lib/blocks/params';
import type { McpContext } from '../src/lib/mcp/types';
import { requireCan, resolvePrincipal } from '../src/lib/members/policy';
import { GET as listApi, POST as createApi } from '../src/pages/api/v1/articles/index';
import { GET as getApi } from '../src/pages/api/v1/articles/[slug]';
import { POST as publishApi } from '../src/pages/api/v1/articles/[slug]/publish';
import { listPageUrl, partialPageUrl } from '../src/scripts/article-list-infinite-scroll';
import {
  MAX_CHAT_MESSAGE_CHARS, PENDING_QUOTE_TTL_MS, composeQuotedQuestion, normalizeQuote, quotePreview,
  readPendingQuote, rememberArticleSession, savePendingQuote, sessionForArticle,
} from '../src/components/ai/article-chat-context';

// ---------- Pure helpers ----------

describe('list windows', () => {
  const all = Array.from({ length: 45 }, (_, i) => i);

  it('slices a page and reports what is left', () => {
    expect(applyWindow(all, pageWindow(1))).toEqual({ items: all.slice(0, 20), total: 45, hasMore: true });
    expect(applyWindow(all, pageWindow(3)).items).toEqual(all.slice(40));
    expect(applyWindow(all, pageWindow(3)).hasMore).toBe(false);
    expect(applyWindow(all, pageWindow(4))).toEqual({ items: [], total: 45, hasMore: false });
    expect(applyWindow(all)).toEqual({ items: all, total: 45, hasMore: false });
  });

  it('renders pages 1..N together for a reload or Back', () => {
    expect(throughPageWindow(2)).toEqual({ offset: 0, limit: 2 * ARTICLE_PAGE_SIZE });
    expect(applyWindow(all, throughPageWindow(2)).items.length).toBe(40);
  });

  it('pages REST/MCP queries by limit, and caps by limit alone without page', () => {
    expect(queryWindow({ page: 2, limit: 5 })).toEqual({ offset: 5, limit: 5 });
    expect(queryWindow({ page: 2 })).toEqual({ offset: ARTICLE_PAGE_SIZE, limit: ARTICLE_PAGE_SIZE });
    expect(queryWindow({ limit: 7 })).toEqual({ offset: 0, limit: 7 });
    expect(queryWindow({})).toEqual({ offset: 0, limit: undefined });
  });
});

describe('page query parameter', () => {
  const parse = (qs: string) => parseDiscoveryQuery(new URL(`https://zuey.test/articles${qs}`));

  it('accepts 1..MAX_ARTICLE_PAGE', () => {
    expect(parse('?page=1').page).toBe(1);
    expect(parse(`?page=${MAX_ARTICLE_PAGE}`).page).toBe(MAX_ARTICLE_PAGE);
    expect(parse('').page).toBeUndefined();
  });

  for (const bad of ['0', String(MAX_ARTICLE_PAGE + 1), '1.5', 'two', '-1']) {
    it(`rejects page=${bad} with 400`, () => {
      let status = 0;
      try { parse(`?page=${bad}`); } catch (e) { status = (e as { status?: number }).status ?? -1; }
      expect(status).toBe(400);
    });
  }
});

describe('infinite-scroll URLs', () => {
  it('keeps filters and drops page=1', () => {
    expect(listPageUrl('https://zuey.me/articles?tag=ai&sort=new', 3)).toBe('/articles?tag=ai&sort=new&page=3');
    expect(listPageUrl('https://zuey.me/articles?tag=ai&page=4', 1)).toBe('/articles?tag=ai');
    expect(listPageUrl('https://zuey.me/articles?page=2#top', 5)).toBe('/articles?page=5#top');
  });

  it('moves the partial to the next page', () => {
    expect(partialPageUrl('/articles/page/2?tag=ai', 3)).toBe('/articles/page/3?tag=ai');
    expect(partialPageUrl('/articles/page/12', 13)).toBe('/articles/page/13');
  });
});

// ---------- Ask Zuey AI: quote composition and storage ----------

function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true });
  return store;
}

describe('quoted questions', () => {
  const source = '(Trích từ bài "Bài A" — https://zuey.me/articles/a)';

  it('normalizes whitespace and blank lines from multi-block selections', () => {
    expect(normalizeQuote('  one\t\ttwo  \r\n\r\n\r\n three ')).toBe('one two\n\nthree');
  });

  it('puts the passage in a blockquote, then the source, then the question', () => {
    const msg = composeQuotedQuestion('first line\n\nsecond', '  Why?  ', source);
    expect(msg).toBe(`> first line\n>\n> second\n\n${source}\n\nWhy?`);
  });

  it('shortens a long passage so the whole message fits the chat limit', () => {
    const msg = composeQuotedQuestion('word '.repeat(2000), 'What does this mean?', source);
    expect(msg.length).toBeLessThanOrEqual(MAX_CHAT_MESSAGE_CHARS);
    expect(msg).toContain('…');
    expect(msg.endsWith('What does this mean?')).toBe(true);
  });

  it('sends the question alone when the passage is empty', () => {
    expect(composeQuotedQuestion('   ', 'Hello', source)).toBe('Hello');
  });

  it('previews the passage on one line', () => {
    expect(quotePreview('a\n\nb')).toBe('a b');
    const long = quotePreview('x'.repeat(500), 50);
    expect(long.length).toBe(50);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('per-article session and pending quote storage', () => {
  it('remembers one session per article and forgets on null', () => {
    stubLocalStorage();
    expect(sessionForArticle('a')).toBeNull();
    rememberArticleSession('a', 'sess_1');
    rememberArticleSession('b', 'sess_2');
    expect(sessionForArticle('a')).toBe('sess_1');
    rememberArticleSession('a', null);
    expect(sessionForArticle('a')).toBeNull();
    expect(sessionForArticle('b')).toBe('sess_2');
  });

  it('keeps a pending passage for its article for 30 minutes only', () => {
    const store = stubLocalStorage();
    const t0 = 1_000_000;
    savePendingQuote('a', 'passage', t0);
    expect(readPendingQuote('b', t0)).toBeNull();
    expect(readPendingQuote('a', t0 + PENDING_QUOTE_TTL_MS)).toBe('passage');
    expect(readPendingQuote('a', t0 + PENDING_QUOTE_TTL_MS + 1)).toBeNull();
    expect(store.size).toBe(0);
    savePendingQuote('a', 'again', t0);
    savePendingQuote('a', null, t0);
    expect(readPendingQuote('a', t0)).toBeNull();
  });

  it('survives unavailable or corrupt storage', () => {
    const store = stubLocalStorage();
    store.set('zuey.ai.articleSessions', '{not json');
    expect(sessionForArticle('a')).toBeNull();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('denied'); },
    });
    expect(() => rememberArticleSession('a', 'x')).not.toThrow();
    expect(readPendingQuote('a')).toBeNull();
    stubLocalStorage();
  });
});

// ---------- REST and MCP pagination over real routes ----------

const d1 = createTestD1();
let adminCookie = '';
const TOTAL = 25;

async function call(handler: APIRoute, init: { method?: string; body?: unknown; params?: Record<string, string>; query?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  const request = new Request(`https://zuey.test/api/v1/articles${init.query ?? ''}`, {
    method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const context = { request, params: init.params ?? {}, url: new URL(request.url), locals: { runtime: { env: { DB: d1 } } } };
  return handler(context as unknown as Parameters<APIRoute>[0]);
}

async function json(res: Response): Promise<{ status: number; data: unknown }> {
  const body = (await res.json()) as { data?: unknown };
  return { status: res.status, data: body.data };
}

const slugsOf = (data: unknown): string[] => (data as Array<{ slug: string }>).map(a => a.slug);

function mcpCtx(): McpContext {
  const request = new Request('https://zuey.test/api/mcp');
  const env: RuntimeEnv = { DB: d1 };
  const principal = () => resolvePrincipal(request, env);
  return {
    request, env, d1, principal,
    async isAdmin() { return (await principal()).kind === 'admin'; },
    async requireAdmin() { requireCan(await principal(), 'admin'); },
  };
}

beforeAll(async () => {
  adminCookie = `zuey_session=${await createSession('admin@zuey.me', d1)}`;
  const admin = { cookie: adminCookie };
  for (let i = 1; i <= TOTAL; i++) {
    const slug = `paged-${String(i).padStart(2, '0')}`;
    const created = await call(createApi, {
      method: 'POST', headers: admin,
      body: { slug, title: `Paged ${i}`, excerpt: `Excerpt ${i}`, document: { version: 1, blocks: [{ type: 'paragraph', text: `Body of paged article ${i}.` }] } },
    });
    if (created.status !== 201) throw new Error(`create failed: ${created.status} ${await created.text()}`);
    const draft = await json(await call(getApi, { params: { slug }, query: '?draft=1', headers: admin }));
    const revision = (draft.data as { revision: number }).revision;
    const published = await call(publishApi, { method: 'POST', headers: admin, params: { slug }, body: { expected_revision: revision, confirm: true } });
    if (published.status !== 200) throw new Error(`publish failed: ${published.status} ${await published.text()}`);
  }
});

describe('REST /api/v1/articles pagination', () => {
  it('returns one page with totals and a rel=next link', async () => {
    const res = await call(listApi, { query: '?page=1&limit=10&sort=title' });
    const { status, data } = await json(res);
    expect(status).toBe(200);
    expect(slugsOf(data).length).toBe(10);
    expect(res.headers.get('X-Total-Count')).toBe(String(TOTAL));
    expect(res.headers.get('X-Has-More')).toBe('1');
    const link = res.headers.get('Link') ?? '';
    expect(link).toContain('rel="next"');
    expect(link).toContain('page=2');
    expect(link).toContain('limit=10');
  });

  it('pages do not overlap and the last page has no next link', async () => {
    const pages = await Promise.all([1, 2, 3].map(p => call(listApi, { query: `?page=${p}&limit=10` })));
    const slugs = (await Promise.all(pages.map(async r => slugsOf((await json(r)).data)))).flat();
    expect(slugs.length).toBe(TOTAL);
    expect(new Set(slugs).size).toBe(TOTAL);
    expect(pages[2].headers.get('X-Has-More')).toBe('0');
    expect(pages[2].headers.get('Link')).toBeNull();
  });

  it('keeps the old behaviour without page (limit caps, no Link)', async () => {
    const res = await call(listApi, { query: '?limit=5' });
    expect(slugsOf((await json(res)).data).length).toBe(5);
    expect(res.headers.get('X-Total-Count')).toBe(String(TOTAL));
    expect(res.headers.get('Link')).toBeNull();
    const all = await call(listApi);
    expect(slugsOf((await json(all)).data).length).toBe(TOTAL);
  });

  it('rejects an out-of-range page', async () => {
    expect((await call(listApi, { query: `?page=${MAX_ARTICLE_PAGE + 1}` })).status).toBe(400);
  });
});

describe('MCP article_list pagination', () => {
  it('accepts page and matches the REST page', async () => {
    const mcp = await articlesMcpModule.call('article_list', { page: 2, limit: 10 }, mcpCtx());
    const rest = await json(await call(listApi, { query: '?page=2&limit=10' }));
    expect(slugsOf(mcp)).toEqual(slugsOf(rest.data));
    const schema = articlesMcpModule.tools.find(t => t.name === 'article_list')?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    expect(schema?.properties?.page).toBeDefined();
  });
});
