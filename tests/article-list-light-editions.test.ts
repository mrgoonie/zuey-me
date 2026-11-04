import { describe, expect, test } from 'bun:test';
import { createTestD1 } from './helpers/d1';
import type { D1DatabaseLike } from '../src/db/store';
import { createArticle, listArticles, publishArticle, updateArticle } from '../src/lib/blocks/articles';
import type { ArticleDocument } from '../src/lib/blocks/schema';

/** Records every SQL statement the code prepares. */
function recordingD1(db: D1DatabaseLike) {
  const sql: string[] = [];
  const recorded = new Proxy(db, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (key === 'prepare' && typeof value === 'function') return (text: string) => { sql.push(text); return value.call(target, text); };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: recorded, sql };
}

const doc = (text: string): ArticleDocument => ({ version: 1, blocks: [{ id: 'p1', type: 'paragraph', text }] });

describe('article list edition load', () => {
  // Every body together runs to megabytes in production; a list that read them all timed out (Cloudflare 524).
  test('the list never reads article or edition bodies yet still reports status and unpublished changes', async () => {
    const d1 = createTestD1();
    const created = await createArticle(d1, { slug: 'mot', title: 'Một', document: doc('một') });
    const published = await publishArticle(d1, 'mot', created.revision, true, { locale: 'vi', notify: false });
    const edited = await updateArticle(d1, 'mot', { locale: 'vi', title: 'Một', document: doc('sửa') }, published.revision);
    await updateArticle(d1, 'mot', { locale: 'en', title: 'One', document: doc('one') }, edited.revision);
    await createArticle(d1, { slug: 'hai', title: 'Hai', document: doc('hai') });

    const rec = recordingD1(d1);
    const publicList = await listArticles(rec.db, { locale: 'vi' });
    const adminList = await listArticles(rec.db, { includeDrafts: true });

    // Both tables hold document bodies: editions their own, articles the legacy pre-edition copy.
    const bodyTableReads = rec.sql.filter(q => /FROM (article_editions|articles)\b/i.test(q));
    expect(bodyTableReads.some(q => /FROM articles\b/i.test(q))).toBe(true);
    expect(bodyTableReads.some(q => /FROM article_editions/i.test(q))).toBe(true);
    for (const q of bodyTableReads) {
      expect(q).not.toMatch(/SELECT \*/i);
      // The bodies are compared only once the revisions show the edition was edited after publishing.
      const gated = /WHEN published_revision = revision THEN 0\s+ELSE published_json IS NOT draft_json END/;
      expect(q.replace(gated, '')).not.toMatch(/draft_json|published_json/);
    }

    expect(publicList.map(a => a.slug)).toEqual(['mot']);
    expect(publicList[0]).toMatchObject({ status: 'published', has_unpublished_changes: true, available_locales: ['vi'] });

    const mot = adminList.find(a => a.slug === 'mot');
    expect(mot?.editions?.map(e => [e.locale, e.status, e.has_unpublished_changes])).toEqual([['en', 'draft', true], ['vi', 'published', true]]);
    expect(adminList.find(a => a.slug === 'hai')).toMatchObject({ status: 'draft', has_unpublished_changes: true });
  });

  test('a draft save that leaves the body as published reports no unpublished changes', async () => {
    const d1 = createTestD1();
    const created = await createArticle(d1, { slug: 'bon', title: 'Bốn', document: doc('bốn') });
    const published = await publishArticle(d1, 'bon', created.revision, true, { locale: 'vi', notify: false });
    const saved = await updateArticle(d1, 'bon', { locale: 'vi', title: 'Bốn', document: doc('bốn') }, published.revision);
    expect(saved.revision).toBeGreaterThan(published.revision);
    const [item] = await listArticles(d1, { locale: 'vi' });
    expect(item).toMatchObject({ slug: 'bon', status: 'published', has_unpublished_changes: false });
  });

  test('a freshly published edition has no unpublished changes', async () => {
    const d1 = createTestD1();
    const created = await createArticle(d1, { slug: 'ba', title: 'Ba', document: doc('ba') });
    await publishArticle(d1, 'ba', created.revision, true, { locale: 'vi', notify: false });
    const [item] = await listArticles(d1, { locale: 'vi' });
    expect(item).toMatchObject({ slug: 'ba', status: 'published', has_unpublished_changes: false });
  });
});
