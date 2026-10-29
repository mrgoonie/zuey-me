import { describe, expect, test } from 'bun:test';
import { createTestD1 } from './helpers/d1';
import type { D1DatabaseLike } from '../src/db/store';
import { createArticle, listArticles, publishArticle, updateArticle } from '../src/lib/blocks/articles';
import type { ArticleDocument } from '../src/lib/blocks/schema';
import { createCategory } from '../src/lib/taxonomy/categories';
import { publicTaxonomy } from '../src/lib/taxonomy/public';
import { createTag } from '../src/lib/taxonomy/tags';

/**
 * A D1 stand-in that holds every query at a gate and counts sequential round trips. `drive` lets the event loop drain
 * (a macrotask runs only after all pending microtasks), then releases every query waiting at the gate as one round.
 * Queries issued together therefore share a round, and a query that needs an earlier result opens the next one.
 * No timers: the count depends only on how the code awaits. Far from the database each round costs hundreds of ms,
 * so a cold /articles render must not chain queries that could run together.
 */
function roundCountingD1(db: D1DatabaseLike) {
  let rounds = 0;
  const waiting: Array<() => void> = [];
  const gate = () => new Promise<void>(resolve => waiting.push(resolve));
  const drained = () => new Promise<void>(resolve => setImmediate(resolve));
  const wrap = <T extends object>(stmt: T): T => new Proxy(stmt, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (key === 'bind') return (...args: unknown[]) => wrap(value.apply(target, args));
      if (key === 'all' || key === 'first' || key === 'run' || key === 'raw') {
        return async (...args: unknown[]) => { await gate(); return value.apply(target, args); };
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
  async function drive<T>(work: Promise<T>): Promise<T> {
    let settled = false;
    work.then(() => { settled = true; }, () => { settled = true; });
    for (let step = 0; step < 1000 && !settled; step++) {
      await drained();
      if (waiting.length) {
        rounds++;
        for (const release of waiting.splice(0)) release();
      }
    }
    return work;
  }
  return { db: counted, drive, rounds: () => rounds };
}

const doc = (text: string): ArticleDocument => ({ version: 1, blocks: [{ id: 'p1', type: 'paragraph', text }] });

describe('article list D1 round trips', () => {
  test('the /articles list and its facets load in two concurrent rounds', async () => {
    const d1 = createTestD1();
    await createTag(d1, { slug: 'agents', names: { vi: 'Tác tử', en: 'Agents' } }, 'admin');
    await createCategory(d1, { slug: 'guides', names: { vi: 'Hướng dẫn', en: 'Guides' } }, 'admin');
    for (const slug of ['mot', 'hai']) {
      const tagged = slug === 'mot' ? { tags: ['agents'], category: 'guides' } : {};
      const created = await createArticle(d1, { slug, title: slug, document: doc(slug), ...tagged });
      const en = await updateArticle(d1, slug, { locale: 'en', title: `${slug} en`, document: doc('hello') }, created.revision);
      const vi = await publishArticle(d1, slug, en.revision, true, { locale: 'vi', notify: false });
      await publishArticle(d1, slug, vi.revision, true, { locale: 'en', notify: false });
    }

    const list = roundCountingD1(d1);
    const items = await list.drive(listArticles(list.db, { locale: 'vi' }));
    expect(items.map(a => a.slug).sort()).toEqual(['hai', 'mot']);
    expect(items.find(a => a.slug === 'mot')?.topic_tags.map(t => t.slug)).toEqual(['agents']);
    // Articles and editions together, then tags, categories and labels together.
    expect(list.rounds()).toBe(2);

    const page = roundCountingD1(d1);
    const [articles, facets] = await page.drive(Promise.all([listArticles(page.db, { locale: 'vi' }), publicTaxonomy(page.db, 'vi')]));
    expect(articles).toHaveLength(2);
    expect(facets.tags.map(t => [t.slug, t.published_count])).toEqual([['agents', 1]]);
    expect(facets.categories.map(c => [c.slug, c.published_count])).toEqual([['guides', 1]]);
    expect(facets.labels).toEqual([]);
    expect(page.rounds()).toBe(2);
  });
});
