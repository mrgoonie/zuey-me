import { describe, it, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createTestD1 } from './helpers/d1';
import type { RuntimeEnv } from '../src/env';
import { createArticle, listArticles, publishArticle } from '../src/lib/blocks/articles';
import { discoverArticles } from '../src/lib/blocks/discovery';
import { throughPageWindow } from '../src/lib/blocks/pagination';
import { anonymousPrincipal } from '../src/lib/members/policy';
import { publicTaxonomy } from '../src/lib/taxonomy/public';

const ARTICLE_LIST_SQL = 'FROM articles WHERE deleted_at IS NULL ORDER BY updated_at';

function countingDb() {
  const db = createTestD1();
  let articleLists = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    if (sql.includes(ARTICLE_LIST_SQL)) articleLists += 1;
    return prepare(sql);
  };
  return { db, loads: () => articleLists };
}

async function seed(db: ReturnType<typeof createTestD1>) {
  for (const [slug, tags] of [['one', ['alpha']], ['two', ['alpha', 'beta']], ['three', ['beta']]] as const) {
    const rec = await createArticle(db, { slug, title: slug, excerpt: 'x', tags: [...tags] });
    await publishArticle(db, slug, rec.revision, true, { notify: false });
  }
}

describe('/articles shares one published-list load', () => {
  it('serves the unfiltered listing and the facets from a single article query', async () => {
    const { db, loads } = countingDb();
    await seed(db);
    const env: RuntimeEnv = { DB: db };
    const before = loads();
    const published = listArticles(db, { locale: 'vi' });
    const [result, facets] = await Promise.all([
      discoverArticles(anonymousPrincipal(), env, { locale: 'vi' }, throughPageWindow(1), published),
      publicTaxonomy(db, 'vi', published),
    ]);
    expect(loads() - before).toBe(1);
    expect(result.total).toBe(3);
    expect(facets.tags.map(t => [t.slug, t.published_count])).toEqual([['alpha', 2], ['beta', 2]]);
  });

  it('returns the same listing, facets and window as separate loads', async () => {
    const { db } = countingDb();
    await seed(db);
    const env: RuntimeEnv = { DB: db };
    const window = { offset: 1, limit: 1 };
    const published = listArticles(db, { locale: 'en' });
    const shared = await discoverArticles(anonymousPrincipal(), env, { locale: 'en', sort: 'new' }, window, published);
    const separate = await discoverArticles(anonymousPrincipal(), env, { locale: 'en', sort: 'new' }, window);
    expect(shared).toEqual(separate);
    expect(await publicTaxonomy(db, 'en', published)).toEqual(await publicTaxonomy(db, 'en'));
  });

  it('still queries the filtered list when the request adds a filter or another sort', async () => {
    const { db, loads } = countingDb();
    await seed(db);
    const env: RuntimeEnv = { DB: db };
    const published = listArticles(db, { locale: 'vi' });
    await published;
    const before = loads();
    const tagged = await discoverArticles(anonymousPrincipal(), env, { locale: 'vi', tag: 'beta' }, undefined, published);
    const titled = await discoverArticles(anonymousPrincipal(), env, { locale: 'vi', sort: 'title' }, undefined, published);
    expect(loads() - before).toBe(2);
    expect(tagged.items.map(i => i.slug).sort()).toEqual(['three', 'two']);
    expect(titled.items.map(i => i.slug)).toEqual(['one', 'three', 'two']);
  });

  it('the /articles page passes its one load to both the listing and the facets', async () => {
    const src = await readFile(new URL('../src/pages/articles/index.astro', import.meta.url), 'utf8');
    expect(src.includes('publicTaxonomy(env.DB, listLocale, published)')).toBe(true);
    expect(/discoverArticles\([^)]*throughPageWindow\(page\), published\)/.test(src)).toBe(true);
  });
});
