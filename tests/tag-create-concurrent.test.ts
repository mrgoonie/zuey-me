import { describe, it, expect, beforeEach } from 'bun:test';
import type { APIRoute } from 'astro';
import { createTestD1 } from './helpers/d1';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../src/db/store';
import type { ArticleDocument } from '../src/lib/blocks/schema';
import { createArticle, getArticle } from '../src/lib/blocks/articles';
import { AppError } from '../src/lib/http';
import { createSession } from '../src/db/store';
import { createTag, updateTag } from '../src/lib/taxonomy/tags';
import { POST as createArticleApi } from '../src/pages/api/v1/articles/index';
import { POST as createTagApi } from '../src/pages/api/v1/taxonomy/tags/index';

// Article writes create unknown tags on the fly. Two writes adding the same new tag must both succeed and share
// one tag; an admin explicitly creating a tag whose slug is taken still gets 409 tag_conflict.

type TestD1 = ReturnType<typeof createTestD1>;

function doc(text: string): ArticleDocument {
  return { version: 1, blocks: [{ id: 'p1', type: 'paragraph', text }] };
}

function article(slug: string): { slug: string; title: string; excerpt: string; document: ArticleDocument; tags: string[] } {
  return { slug, title: `Bài ${slug}`, excerpt: 'Tóm tắt', document: doc(slug), tags: ['gamma'] };
}

/** Wraps a database so the hooks run around matching statements; batches are unwrapped after `beforeBatch` sees their SQL. */
function intercept(inner: D1DatabaseLike, hooks: {
  beforeRun?: (sql: string) => Promise<void>; afterAll?: (sql: string) => Promise<void>; beforeBatch?: (sql: string[]) => Promise<void>;
}): D1DatabaseLike {
  const unwrap = new WeakMap<D1PreparedStatementLike, D1PreparedStatementLike>();
  const sqlOf = new WeakMap<D1PreparedStatementLike, string>();
  const wrap = (stmt: D1PreparedStatementLike, sql: string): D1PreparedStatementLike => {
    const wrapped: D1PreparedStatementLike = {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql),
      first: <T = Record<string, unknown>>() => stmt.first<T>(),
      all: async <T = Record<string, unknown>>() => {
        const out = await stmt.all<T>();
        await hooks.afterAll?.(sql);
        return out;
      },
      run: async () => {
        await hooks.beforeRun?.(sql);
        return stmt.run();
      },
    };
    unwrap.set(wrapped, stmt);
    sqlOf.set(wrapped, sql);
    return wrapped;
  };
  return {
    prepare: (sql: string) => wrap(inner.prepare(sql), sql),
    batch: async (statements: D1PreparedStatementLike[]) => {
      await hooks.beforeBatch?.(statements.map(s => sqlOf.get(s) ?? ''));
      return inner.batch(statements.map(s => unwrap.get(s) ?? s));
    },
  };
}

const TAG_INSERT = /INSERT INTO topic_tags \(/;
const TAG_LOOKUP = /FROM topic_tags t WHERE t\.deleted_at IS NULL/;

/** Holds each request's tag INSERT until `parties` requests reached it, so all of them passed every tag lookup. */
function barrierAtTagInsert(parties: number): (inner: D1DatabaseLike) => D1DatabaseLike {
  let arrived = 0;
  let release: () => void = () => {};
  const open = new Promise<void>(resolve => { release = resolve; });
  return inner => {
    let waited = false;
    return intercept(inner, {
      beforeRun: async sql => {
        if (waited || !TAG_INSERT.test(sql)) return;
        waited = true;
        arrived += 1;
        if (arrived >= parties) release();
        await open;
      },
    });
  };
}

/** Holds a request right after its first tag lookup until `until` settles, so it acts on a stale "tag missing" view. */
function holdAfterTagLookup(inner: D1DatabaseLike, until: Promise<unknown>): D1DatabaseLike {
  let held = false;
  return intercept(inner, {
    afterAll: async sql => {
      if (held || !TAG_LOOKUP.test(sql)) return;
      held = true;
      await until.catch(() => {});
    },
  });
}

async function adminCookie(d1: TestD1): Promise<string> {
  return `zuey_session=${await createSession('admin@zuey.me', d1)}`;
}

type RouteContext = Parameters<APIRoute>[0];

/** Checks the fields the tag and article handlers read, so a partial context can be passed without a cast. */
function isRouteContext(value: unknown): value is RouteContext {
  return typeof value === 'object' && value !== null
    && 'request' in value && value.request instanceof Request
    && 'url' in value && value.url instanceof URL
    && 'params' in value && typeof value.params === 'object'
    && 'locals' in value && typeof value.locals === 'object';
}

async function callApi(route: APIRoute, path: string, db: D1DatabaseLike, cookie: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const request = new Request(`https://zuey.test${path}`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const ctx = { request, params: {}, url: new URL(request.url), locals: { runtime: { env: { DB: db } } } };
  // The handlers only read request/params/url/locals; a full APIContext is not constructible in tests.
  if (!isRouteContext(ctx)) throw new Error('route context is missing request, params, url or locals');
  const res = await route(ctx);
  return { status: res.status, json: JSON.parse(await res.text()) };
}

function tagRows(d1: TestD1): unknown[] {
  return d1.raw.query("SELECT id FROM topic_tags WHERE slug = 'gamma'").all();
}

/** Both articles carry the one `gamma` tag. */
async function expectSharedTag(d1: TestD1, slugs: string[]): Promise<void> {
  const rows = tagRows(d1);
  expect(rows).toHaveLength(1);
  for (const slug of slugs) expect((await getArticle(d1, slug))?.tags).toEqual(['gamma']);
  expect(d1.raw.query('SELECT DISTINCT tag_id AS id FROM article_tags').all()).toEqual(rows);
  expect(d1.raw.query('SELECT COUNT(*) AS n FROM article_tags').get()).toEqual({ n: slugs.length });
}

describe('concurrent article creates adding the same new tag (real SQLite)', () => {
  let d1: TestD1;

  beforeEach(() => {
    d1 = createTestD1();
  });

  it('both pass the tag lookup and insert the tag: both succeed with one tag id', async () => {
    const gated = barrierAtTagInsert(2);
    const outcomes = await Promise.allSettled([createArticle(gated(d1), article('post-a')), createArticle(gated(d1), article('post-b'))]);
    expect(outcomes.map(o => o.status)).toEqual(['fulfilled', 'fulfilled']);
    await expectSharedTag(d1, ['post-a', 'post-b']);
  });

  it('one inserts the tag after the other looked it up: both succeed with one tag id', async () => {
    const first = createArticle(d1, article('post-b'));
    const outcomes = await Promise.allSettled([createArticle(holdAfterTagLookup(d1, first), article('post-a')), first]);
    expect(outcomes.map(o => o.status)).toEqual(['fulfilled', 'fulfilled']);
    await expectSharedTag(d1, ['post-a', 'post-b']);
  });

  it('REST: both creates answer 201 and share one tag id', async () => {
    const cookie = await adminCookie(d1);
    const gated = barrierAtTagInsert(2);
    const results = await Promise.all([
      callApi(createArticleApi, '/api/v1/articles', gated(d1), cookie, article('post-a')),
      callApi(createArticleApi, '/api/v1/articles', gated(d1), cookie, article('post-b')),
    ]);
    expect(results.map(r => r.status)).toEqual([201, 201]);
    await expectSharedTag(d1, ['post-a', 'post-b']);
  });

  it('a new tag clashing with another tag alias is still refused', async () => {
    await createTag(d1, { slug: 'other', names: { vi: 'Other' }, aliases: ['gamma-ray'] }, 'admin');
    // "gamma_ray!" matches no key of "other", so it reaches the create; its slug "gamma-ray" is that tag's alias.
    const err = await createArticle(d1, { ...article('post-a'), tags: ['gamma_ray!'] }).catch((e: unknown) => e);
    expect(err instanceof AppError ? [err.status, err.code] : err).toEqual([409, 'tag_conflict']);
  });

  it('a different name that only shares the slug ("C++" then "C#") is refused, not reused', async () => {
    await createArticle(d1, { ...article('post-a'), tags: ['C++'] });
    const err = await createArticle(d1, { ...article('post-b'), tags: ['C#'] }).catch((e: unknown) => e);
    expect(err instanceof AppError ? [err.status, err.code] : err).toEqual([409, 'tag_conflict']);
    expect(await getArticle(d1, 'post-b')).toBeNull();
    expect(d1.raw.query('SELECT slug, names FROM topic_tags').all()).toEqual([{ slug: 'c', names: JSON.stringify({ vi: 'C++' }) }]);
    expect(d1.raw.query('SELECT COUNT(*) AS n FROM article_tags').get()).toEqual({ n: 1 });
  });

  it('when the slug owner differs from the tag owning the clashing alias, nothing is reused', async () => {
    // Legacy rows can hold a slug and an equal alias on two tags; the requested name matches neither.
    d1.raw.run(`INSERT INTO topic_tags (id, slug, names, aliases, created_at, updated_at) VALUES
      ('tag_x', 'gamma-ray', '{"vi":"Gamma Ray"}', '[]', '2026-01-01', '2026-01-01'),
      ('tag_y', 'other', '{"vi":"Other"}', '["gamma-ray"]', '2026-01-01', '2026-01-01')`);
    const err = await createArticle(d1, { ...article('post-a'), tags: ['Gamma-Ray!'] }).catch((e: unknown) => e);
    expect(err instanceof AppError ? [err.status, err.code] : err).toEqual([409, 'tag_conflict']);
    expect(await getArticle(d1, 'post-a')).toBeNull();
    expect(d1.raw.query('SELECT COUNT(*) AS n FROM topic_tags').get()).toEqual({ n: 2 });
  });
});

describe('explicit admin tag creates keep 409 tag_conflict (real SQLite)', () => {
  let d1: TestD1;

  beforeEach(() => {
    d1 = createTestD1();
  });

  it('a duplicate slug is 409 tag_conflict', async () => {
    const first = await createTag(d1, { slug: 'gamma', names: { vi: 'Gamma' }, aliases: [] }, 'admin');
    const err = await createTag(d1, { slug: 'gamma', names: { en: 'Gamma two' }, aliases: [] }, 'admin').catch((e: unknown) => e);
    expect(err instanceof AppError ? [err.status, err.code, err.extra.tag_id] : err).toEqual([409, 'tag_conflict', first.id]);
  });

  it('two concurrent creates of the same slug: one 201, one 409 tag_conflict (not a raw 500)', async () => {
    const cookie = await adminCookie(d1);
    const gated = barrierAtTagInsert(2);
    const results = await Promise.all([
      callApi(createTagApi, '/api/v1/taxonomy/tags', gated(d1), cookie, { slug: 'gamma', names: { vi: 'Gamma' } }),
      callApi(createTagApi, '/api/v1/taxonomy/tags', gated(d1), cookie, { slug: 'gamma', names: { en: 'Gamma' } }),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect(results.find(r => r.status === 409)?.json).toMatchObject({ success: false, error: { code: 'tag_conflict' } });
    expect(tagRows(d1)).toHaveLength(1);
  });
});

describe('a tag rename that loses the slug race (real SQLite)', () => {
  let d1: TestD1;

  beforeEach(() => {
    d1 = createTestD1();
  });

  const TAG_RENAME = /UPDATE topic_tags SET slug/;

  it('a concurrent write taking the slug after the pre-checks is 409 tag_conflict naming the owner, not a raw 500', async () => {
    const mover = await createTag(d1, { slug: 'mover', names: { vi: 'Mover' }, aliases: [] }, 'admin');
    // Another writer inserts (and soft-deletes) a tag with the target slug right before the batch holding this rename runs.
    const racing = intercept(d1, {
      beforeBatch: async sqls => {
        if (sqls.some(sql => TAG_RENAME.test(sql))) d1.raw.run("INSERT INTO topic_tags (id, slug, created_at, updated_at, deleted_at) VALUES ('tag_race', 'taken', '2026-10-25', '2026-10-25', '2026-10-25')");
      },
    });
    const err = await updateTag(racing, mover.id, { slug: 'taken' }, mover.revision, 'admin').catch((e: unknown) => e);
    expect(err instanceof AppError ? [err.status, err.code, err.extra.tag_id] : err).toEqual([409, 'tag_conflict', 'tag_race']);
  });

  it('a unique violation on another index is not reported as tag_conflict', async () => {
    const mover = await createTag(d1, { slug: 'mover', names: { vi: 'Mover' }, aliases: [] }, 'admin');
    // The rename runs in a batch, so the batch holding it is the write that fails.
    const failing = intercept(d1, {
      beforeBatch: async sqls => {
        if (sqls.some(sql => TAG_RENAME.test(sql))) throw new Error('D1_ERROR: UNIQUE constraint failed: topic_tags.id: SQLITE_CONSTRAINT');
      },
    });
    const err = await updateTag(failing, mover.id, { slug: 'renamed' }, mover.revision, 'admin').catch((e: unknown) => e);
    expect(err instanceof AppError).toBe(false);
    expect(err instanceof Error ? err.message : err).toContain('topic_tags.id');
  });
});
