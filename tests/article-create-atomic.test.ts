import { describe, it, expect, beforeEach } from 'bun:test';
import type { APIRoute } from 'astro';
import { createTestD1 } from './helpers/d1';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../src/db/store';
import type { ArticleDocument } from '../src/lib/blocks/schema';
import { createArticle, getArticle } from '../src/lib/blocks/articles';
import { AppError } from '../src/lib/http';
import { createSession } from '../src/db/store';
import { createTag } from '../src/lib/taxonomy/tags';
import { POST as createApi } from '../src/pages/api/v1/articles/index';
import { articlesMcpModule } from '../src/lib/blocks/mcp';
import type { McpContext } from '../src/lib/mcp/types';

// Creating an article writes several rows (article, edition, first history row, tags). They must commit together:
// a partial create leaves an article that cannot be read while every retry is refused with slug_taken.

function doc(text: string): ArticleDocument {
  return { version: 1, blocks: [{ id: 'p1', type: 'paragraph', text }] };
}

const NEW = { slug: 'fresh-post', title: 'Bài mới', excerpt: 'Tóm tắt', document: doc('fresh'), tags: ['alpha', 'beta'] };

type TestD1 = ReturnType<typeof createTestD1>;

/** Makes one statement of the create fail inside SQLite itself, the way a D1 storage error would. */
function failOn(d1: TestD1, table: string, when = '1'): void {
  d1.raw.run(`CREATE TEMP TRIGGER injected_failure BEFORE INSERT ON ${table} WHEN ${when} BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END`);
}

function clearFailure(d1: TestD1): void {
  d1.raw.run('DROP TRIGGER IF EXISTS temp.injected_failure');
}

function rowCounts(d1: TestD1): Record<string, number> {
  const count = (table: string): number => {
    const row: unknown = d1.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get();
    return row && typeof row === 'object' && 'n' in row && typeof row.n === 'number' ? row.n : -1;
  };
  return {
    articles: count('articles'), article_editions: count('article_editions'),
    article_revisions: count('article_revisions'), article_tags: count('article_tags'),
  };
}

const EMPTY = { articles: 0, article_editions: 0, article_revisions: 0, article_tags: 0 };

async function expectFullyCreated(d1: TestD1): Promise<void> {
  const rec = await getArticle(d1, NEW.slug);
  expect(rec).toMatchObject({ slug: NEW.slug, title: NEW.title, excerpt: NEW.excerpt, revision: 1, status: 'draft', tags: ['alpha', 'beta'] });
  expect(rowCounts(d1)).toEqual({ articles: 1, article_editions: 1, article_revisions: 1, article_tags: 2 });
  expect(d1.raw.query('SELECT revision, action FROM article_revisions').all()).toEqual([{ revision: 1, action: 'create' }]);
  expect(d1.raw.query('SELECT tags FROM articles').get()).toEqual({ tags: JSON.stringify(['alpha', 'beta']) });
}

async function adminCookie(d1: TestD1): Promise<string> {
  return `zuey_session=${await createSession('admin@zuey.me', d1)}`;
}

async function callCreate(db: D1DatabaseLike, cookie: string, body: unknown): Promise<{ status: number; text: string; json: unknown }> {
  const request = new Request('https://zuey.test/api/v1/articles', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const ctx = { request, params: {}, url: new URL(request.url), locals: { runtime: { env: { DB: db } } } };
  // The handler only reads request/params/locals; a full APIContext is not constructible in tests.
  const res = await createApi(ctx as unknown as Parameters<APIRoute>[0]);
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}

function errorCode(json: unknown): string | undefined {
  if (!json || typeof json !== 'object' || !('error' in json) || !json.error || typeof json.error !== 'object' || !('code' in json.error)) return undefined;
  return typeof json.error.code === 'string' ? json.error.code : undefined;
}

describe('createArticle is atomic (real SQLite)', () => {
  let d1: TestD1;

  beforeEach(() => {
    d1 = createTestD1();
  });

  const failures: Array<[string, string, string?]> = [
    ['the article row', 'articles'],
    ['the edition row', 'article_editions'],
    ['the first history row', 'article_revisions'],
    ['the first tag row', 'article_tags', 'NEW.position = 0'],
    ['the last tag row', 'article_tags', 'NEW.position = 1'],
  ];

  for (const [what, table, when] of failures) {
    it(`a failure writing ${what} leaves no rows and a retry succeeds`, async () => {
      failOn(d1, table, when);
      const err = await createArticle(d1, NEW).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err instanceof AppError ? err.code : '').not.toBe('slug_taken');
      expect(rowCounts(d1)).toEqual(EMPTY);
      expect(await getArticle(d1, NEW.slug)).toBeNull();

      clearFailure(d1);
      await createArticle(d1, NEW);
      await expectFullyCreated(d1);
    });
  }

  it('REST: a failed create answers 500 without the raw error, and the retry answers 201', async () => {
    const cookie = await adminCookie(d1);
    failOn(d1, 'article_editions');
    const failed = await callCreate(d1, cookie, NEW);
    expect(failed.status).toBe(500);
    expect(failed.text).not.toContain('injected storage failure');
    expect(rowCounts(d1)).toEqual(EMPTY);

    clearFailure(d1);
    const retry = await callCreate(d1, cookie, NEW);
    expect(retry.status).toBe(201);
    await expectFullyCreated(d1);
  });

  it('MCP: a failed article_create leaves nothing and the retry creates the article', async () => {
    const ctx: McpContext = { request: new Request('https://zuey.test/api/mcp'), env: {}, d1, async requireAdmin() {}, async isAdmin() { return true; } };
    failOn(d1, 'article_tags', 'NEW.position = 1');
    expect(await articlesMcpModule.call('article_create', { ...NEW, response_mode: 'summary' }, ctx).then(() => 'ok', () => 'failed')).toBe('failed');
    expect(rowCounts(d1)).toEqual(EMPTY);

    clearFailure(d1);
    expect(await articlesMcpModule.call('article_create', { ...NEW, response_mode: 'summary' }, ctx)).toMatchObject({ slug: NEW.slug, revision: 1, receipt: { operation: 'create', article_revision: 1 } });
    await expectFullyCreated(d1);
  });
});

/**
 * Holds every request's first article write (a batch, or the article INSERT) until `parties` requests reached it,
 * so concurrent creates have all passed the slug check before any of them writes.
 */
function barrierAtFirstWrite(parties: number): (inner: D1DatabaseLike) => D1DatabaseLike {
  let arrived = 0;
  let release: () => void = () => {};
  const open = new Promise<void>(resolve => { release = resolve; });
  const arrive = async (): Promise<void> => {
    arrived += 1;
    if (arrived >= parties) release();
    await open;
  };
  return inner => {
    let waited = false;
    const gate = async (): Promise<void> => {
      if (waited) return;
      waited = true;
      await arrive();
    };
    const unwrap = new WeakMap<D1PreparedStatementLike, D1PreparedStatementLike>();
    const wrap = (stmt: D1PreparedStatementLike, sql: string): D1PreparedStatementLike => {
      const wrapped: D1PreparedStatementLike = {
        bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql),
        first: <T = Record<string, unknown>>() => stmt.first<T>(),
        all: <T = Record<string, unknown>>() => stmt.all<T>(),
        run: async () => {
          if (/INSERT INTO articles \(/.test(sql)) await gate();
          return stmt.run();
        },
      };
      unwrap.set(wrapped, stmt);
      return wrapped;
    };
    return {
      prepare: (sql: string) => wrap(inner.prepare(sql), sql),
      batch: async (statements: D1PreparedStatementLike[]) => {
        await gate();
        return inner.batch(statements.map(s => unwrap.get(s) ?? s));
      },
    };
  };
}

describe('concurrent creates with the same slug (real SQLite)', () => {
  let d1: TestD1;

  beforeEach(async () => {
    d1 = createTestD1();
    // Both requests then reuse the tags instead of racing to create them.
    for (const slug of NEW.tags) await createTag(d1, { slug, names: { vi: slug }, aliases: [] }, 'admin');
  });

  it('createArticle: one creates the article, the other gets 409 slug_taken', async () => {
    const gated = barrierAtFirstWrite(2);
    const outcomes = await Promise.allSettled([createArticle(gated(d1), NEW), createArticle(gated(d1), { ...NEW, title: 'Other' })]);
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const err: unknown = rejected[0]?.reason;
    expect(err).toBeInstanceOf(AppError);
    expect(err instanceof AppError ? [err.status, err.code] : []).toEqual([409, 'slug_taken']);
    await expectFullyCreated(d1);
  });

  it('REST: one 201, one 409 slug_taken in the error envelope', async () => {
    const cookie = await adminCookie(d1);
    const gated = barrierAtFirstWrite(2);
    const [a, b] = await Promise.all([callCreate(gated(d1), cookie, NEW), callCreate(gated(d1), cookie, { ...NEW, title: 'Other' })]);
    expect([a?.status, b?.status].sort()).toEqual([201, 409]);
    const lost = a?.status === 409 ? a : b;
    expect(lost?.json).toMatchObject({ success: false, error: { code: 'slug_taken' } });
    expect(errorCode(lost?.json)).toBe('slug_taken');
    await expectFullyCreated(d1);
  });
});

describe('the legacy tag names commit with the create (real SQLite)', () => {
  let d1: TestD1;

  beforeEach(() => {
    d1 = createTestD1();
    d1.raw.run(`CREATE TEMP TRIGGER injected_failure BEFORE UPDATE OF tags ON articles BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END`);
  });

  it('a failed legacy tag names update fails the create and leaves no rows, and a retry succeeds', async () => {
    const err = await createArticle(d1, NEW).catch((e: unknown) => e);
    expect(String(err)).toMatch(/injected/);
    expect(rowCounts(d1)).toEqual(EMPTY);
    clearFailure(d1);
    await createArticle(d1, NEW);
    await expectFullyCreated(d1);
  });

  it('REST: a failed legacy tag names update is an error that creates nothing', async () => {
    const res = await callCreate(d1, await adminCookie(d1), NEW);
    expect(res.status).toBe(500);
    expect(res.json).toMatchObject({ success: false });
    expect(rowCounts(d1)).toEqual(EMPTY);
  });
});
