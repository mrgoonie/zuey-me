import { describe, it, expect } from 'bun:test';
import { createTestD1 } from './helpers/d1';
import type { RuntimeEnv } from '../src/env';
import { createArticle, listArticles, publishArticle } from '../src/lib/blocks/articles';
import { discoverArticles } from '../src/lib/blocks/discovery';
import { anonymousPrincipal } from '../src/lib/members/policy';
import { publicTaxonomy } from '../src/lib/taxonomy/public';

function countingDb() {
  const db = createTestD1();
  let articleLists = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    if (sql.includes('FROM articles WHERE deleted_at IS NULL ORDER BY updated_at')) articleLists += 1;
    return prepare(sql);
  };
  return { db, loads: () => articleLists };
}

async function seed(db: ReturnType<typeof createTestD1>) {
  const rec = await createArticle(db, { slug: 'one', title: 'One', excerpt: 'x', tags: ['alpha'] });
  await publishArticle(db, 'one', rec.revision, true, { notify: false });
}

describe('/articles shares one published-list load', () => {
  it('serves the unfiltered listing and the facets from a single article query', async () => {
    const { db, loads } = countingDb();
    await seed(db);
    const before = loads();
    const catalog = await listArticles(db, { locale: 'vi' });
    const env: RuntimeEnv = { DB: db };
    const result = await discoverArticles(anonymousPrincipal(), env, { locale: 'vi' }, undefined, catalog);
    const facets = await publicTaxonomy(db, 'vi', catalog);
    expect(loads() - before).toBe(1);
    expect(result.total).toBe(catalog.length);
    expect(facets.tags.map(t => t.published_count)).toEqual([1]);
  });

  it('still queries again when the request adds a filter', async () => {
    const { db, loads } = countingDb();
    await seed(db);
    const catalog = await listArticles(db, { locale: 'vi' });
    const before = loads();
    const env: RuntimeEnv = { DB: db };
    const result = await discoverArticles(anonymousPrincipal(), env, { locale: 'vi', tag: 'nope' }, undefined, catalog);
    expect(loads() - before).toBe(1);
    expect(result.total).toBe(0);
  });
});
