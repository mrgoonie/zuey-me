import { describe, expect, test } from 'bun:test';
import { createTestD1 } from './helpers/d1';
import type { D1DatabaseLike } from '../src/db/store';
import { createArticle, listArticles, publishArticle, updateArticle } from '../src/lib/blocks/articles';
import type { ArticleDocument } from '../src/lib/blocks/schema';
import { publicTaxonomy } from '../src/lib/taxonomy/public';

/**
 * A D1 stand-in that counts sequential round trips: queries issued while a round is open join it, and a query
 * issued after the round settled opens the next one. Far from the database (another continent) each round costs
 * hundreds of milliseconds, so a cold /articles render must not chain queries that could run together.
 */
function roundCountingD1(db: D1DatabaseLike): { db: D1DatabaseLike; rounds: () => number } {
  let rounds = 0;
  let open: Promise<void> | null = null;
  const nextRound = () => {
    if (!open) {
      rounds++;
      open = new Promise<void>(resolve => setTimeout(() => { open = null; resolve(); }, 5));
    }
    return open;
  };
  const wrap = <T extends object>(stmt: T): T => new Proxy(stmt, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (key === 'bind') return (...args: unknown[]) => wrap(value.apply(target, args));
      if (key === 'all' || key === 'first' || key === 'run' || key === 'raw') {
        return async (...args: unknown[]) => { await nextRound(); return value.apply(target, args); };
      }
      return value.bind(target);
    },
  });
  const counted = new Proxy(db, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (key === 'prepare' && typeof value === 'function') return (sql: string) => wrap(value.call(target, sql));
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: counted, rounds: () => rounds };
}

const doc = (text: string): ArticleDocument => ({ version: 1, blocks: [{ id: 'p1', type: 'paragraph', text }] });

describe('article list D1 round trips', () => {
  test('the /articles list and its facets load in a few concurrent rounds', async () => {
    const d1 = createTestD1();
    for (const slug of ['mot', 'hai']) {
      const created = await createArticle(d1, { slug, title: slug, document: doc(slug) });
      const en = await updateArticle(d1, slug, { locale: 'en', title: `${slug} en`, document: doc('hello') }, created.revision);
      const vi = await publishArticle(d1, slug, en.revision, true, { locale: 'vi', notify: false });
      await publishArticle(d1, slug, vi.revision, true, { locale: 'en', notify: false });
    }

    const list = roundCountingD1(d1);
    const items = await listArticles(list.db, { locale: 'vi' });
    expect(items.map(a => a.slug).sort()).toEqual(['hai', 'mot']);
    // Articles and editions together, then tags, categories and labels together.
    expect(list.rounds()).toBe(2);

    const page = roundCountingD1(d1);
    const [articles, facets] = await Promise.all([listArticles(page.db, { locale: 'vi' }), publicTaxonomy(page.db, 'vi')]);
    expect(articles).toHaveLength(2);
    expect(facets).toEqual({ tags: [], categories: [], labels: [] });
    expect(page.rounds()).toBe(2);
  });
});
