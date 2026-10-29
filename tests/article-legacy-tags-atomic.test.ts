import { describe, it, expect, beforeEach } from 'bun:test';
import { createTestD1, crashingD1 } from './helpers/d1';
import type { D1DatabaseLike } from '../src/db/store';
import { createArticle, setTagsForArticle, updateArticle } from '../src/lib/blocks/articles';
import { isObj, num, parseStringArray, str } from '../src/lib/taxonomy/common';
import type { Row } from '../src/lib/taxonomy/common';

// The legacy `articles.tags` name list (read by older builds) is rebuilt in the same batch as the article write
// that changes the tags: a crash leaves either the write and its names, or neither, never stale names.

type TestD1 = ReturnType<typeof createTestD1>;

const LEGACY = /^UPDATE articles SET tags/;
const sqlPoint = (re: RegExp) => (sql: string) => re.test(sql.trim());

async function settle(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => 'ok', (e: unknown) => e);
}

function rowOf(d1: TestD1, sql: string, ...params: string[]): Row {
  const row: unknown = d1.raw.query(sql).get(...params);
  return isObj(row) ? row : {};
}

/** The article's revision, its tag slugs from `article_tags` and its legacy tag names, or null when it does not exist. */
function stored(d1: TestD1, slug: string): { revision: number; tags: string[]; legacy: string[] } | null {
  const art = rowOf(d1, 'SELECT id, revision, tags FROM articles WHERE slug = ?', slug);
  if (!art.id) return null;
  const rows: unknown[] = d1.raw.query('SELECT t.slug FROM article_tags at JOIN topic_tags t ON t.id = at.tag_id WHERE at.article_id = ? ORDER BY at.position').all(str(art, 'id'));
  return { revision: num(art, 'revision'), tags: rows.filter(isObj).map(r => str(r, 'slug')), legacy: parseStringArray(art.tags) };
}

/** Every batch the write sent holds the legacy names update next to the tag rows, and no write ran it alone. */
function expectInWriteBatch(spy: ReturnType<typeof crashingD1>): void {
  const batch = spy.batches.find(b => b.some(s => /INSERT (OR IGNORE )?INTO article_tags/.test(s))) ?? [];
  expect(batch.some(s => LEGACY.test(s.trim()))).toBe(true);
  expect(spy.runs.some(s => LEGACY.test(s.trim()))).toBe(false);
}

describe('article create rebuilds the legacy tag names in its batch (real SQLite)', () => {
  let d1: TestD1;
  const create = (db: D1DatabaseLike) => createArticle(db, { slug: 'post', title: 'Bài viết', tags: ['alpha', 'beta'] });

  beforeEach(() => {
    d1 = createTestD1();
  });

  it('a crash at the legacy tag names update creates nothing, and a retry creates the article with its names', async () => {
    expect(String(await settle(create(crashingD1(d1, sqlPoint(LEGACY)).d1)))).toMatch(/crashed/);
    expect(stored(d1, 'post')).toBeNull();
    await create(d1);
    expect(stored(d1, 'post')).toEqual({ revision: 1, tags: ['alpha', 'beta'], legacy: ['alpha', 'beta'] });
  });


  it('writes the tag rows and the legacy tag names in one batch', async () => {
    const spy = crashingD1(d1);
    await create(spy.d1);
    expect(stored(d1, 'post')).toEqual({ revision: 1, tags: ['alpha', 'beta'], legacy: ['alpha', 'beta'] });
    expectInWriteBatch(spy);
  });
});

describe('article update and tags set rebuild the legacy tag names in their batch (real SQLite)', () => {
  let d1: TestD1;

  beforeEach(async () => {
    d1 = createTestD1();
    await createArticle(d1, { slug: 'post', title: 'Bài viết', tags: ['alpha'] });
    await createArticle(d1, { slug: 'seed', title: 'Hạt giống', tags: ['beta'] });
  });

  const writers: Array<[string, (db: D1DatabaseLike) => Promise<unknown>]> = [
    ['updateArticle', db => updateArticle(db, 'post', { title: 'Đã sửa', tags: ['beta', 'alpha'] }, 1)],
    ['setTagsForArticle', db => setTagsForArticle(db, 'post', ['beta', 'alpha'], 1)],
  ];
  const before = { revision: 1, tags: ['alpha'], legacy: ['alpha'] };
  const after = { revision: 2, tags: ['beta', 'alpha'], legacy: ['beta', 'alpha'] };

  for (const [name, write] of writers) {
    it(`${name}: a crash at the legacy tag names update changes nothing, and a retry commits the tags with their names`, async () => {
      expect(String(await settle(write(crashingD1(d1, sqlPoint(LEGACY)).d1)))).toMatch(/crashed/);
      expect(stored(d1, 'post')).toEqual(before);
      await write(d1);
      expect(stored(d1, 'post')).toEqual(after);
    });

    it(`${name}: a crash after the commit keeps the new tags with their legacy names`, async () => {
      // The search reindex runs after the commit and its failure is only logged, so the write may still answer.
      await settle(write(crashingD1(d1, sqlPoint(/^DELETE FROM knowledge_fts/)).d1));
      expect(stored(d1, 'post')).toEqual(after);
    });

    it(`${name}: writes the tag rows and the legacy tag names in one batch`, async () => {
      const spy = crashingD1(d1);
      await write(spy.d1);
      expect(stored(d1, 'post')).toEqual(after);
      expectInWriteBatch(spy);
    });

    it(`${name}: a stale revision changes neither the tags nor their legacy names`, async () => {
      await updateArticle(d1, 'post', { title: 'Khác' }, 1);
      const err = await settle(write(d1));
      expect(err).toBeInstanceOf(Error);
      expect(stored(d1, 'post')).toEqual({ ...before, revision: 2 });
    });
  }

  it('updateArticle without tags leaves the legacy tag names alone', async () => {
    const spy = crashingD1(d1);
    await updateArticle(spy.d1, 'post', { title: 'Đã sửa' }, 1);
    expect(stored(d1, 'post')).toEqual({ ...before, revision: 2 });
    expect(spy.batches.flat().some(s => LEGACY.test(s.trim()))).toBe(false);
  });
});
