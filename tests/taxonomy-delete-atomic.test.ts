import { describe, it, expect, beforeEach } from 'bun:test';
import { createTestD1, crashingD1 } from './helpers/d1';
import { createArticle, setTagsForArticle } from '../src/lib/blocks/articles';
import { createCategory, deleteCategory, getCategory } from '../src/lib/taxonomy/categories';
import { createTag, deleteTag, getTag, mirrorLegacyTags } from '../src/lib/taxonomy/tags';
import { localizedName, parseNames } from '../src/lib/taxonomy/common';
import { isLocale } from '../src/lib/i18n/locales';
import { AppError } from '../src/lib/http';

// A taxonomy delete marks the term deleted, detaches it from its articles and audits it in one transaction: a crash
// or a failed statement at any point leaves either all of that or none of it, never an article pointing at a
// deleted term.

const sqlPoint = (re: RegExp) => (sql: string) => re.test(sql.trim());

async function settle(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => 'ok', (e: unknown) => e);
}

describe('category delete is atomic (real SQLite)', () => {
  let d1: ReturnType<typeof createTestD1>;
  let category: { id: string; revision: number };

  beforeEach(async () => {
    d1 = createTestD1();
    category = await createCategory(d1, { slug: 'guides', names: { vi: 'Hướng dẫn' } }, 'admin');
    await createArticle(d1, { slug: 'one', title: 'Một', category: 'guides' });
    await createArticle(d1, { slug: 'two', title: 'Hai', category: 'guides' });
  });

  const state = () => ({
    deleted: d1.raw.query('SELECT deleted_at FROM knowledge_categories WHERE id = ?').get(category.id) as { deleted_at: string | null },
    attached: (d1.raw.query('SELECT COUNT(*) AS n FROM articles WHERE category_id = ?').get(category.id) as { n: number }).n,
    audits: (d1.raw.query("SELECT COUNT(*) AS n FROM taxonomy_audit_log WHERE action = 'category.delete' AND target_id = ?").get(category.id) as { n: number }).n,
  });
  const untouched = () => expect(state()).toEqual({ deleted: { deleted_at: null }, attached: 2, audits: 0 });
  const fullyDeleted = (audits = 1) => {
    const s = state();
    expect(s.deleted.deleted_at).toEqual(expect.any(String));
    expect({ attached: s.attached, audits: s.audits }).toEqual({ attached: 0, audits });
  };

  const beforeCommit: Array<[string, RegExp]> = [
    ['the mark', /^UPDATE knowledge_categories SET deleted_at/],
    ['the read of the attached articles, right after the mark', /^SELECT id FROM articles WHERE category_id = \?$/],
    ['the article clear', /^UPDATE articles SET category_id = NULL/],
    ['the audit row', /^INSERT INTO taxonomy_audit_log/],
  ];

  for (const [name, re] of beforeCommit) {
    it(`a crash at ${name} deletes nothing and leaves every article attached`, async () => {
      expect(String(await settle(deleteCategory(crashingD1(d1, sqlPoint(re)).d1, category.id, category.revision, 'admin')))).toMatch(/crashed/);
      untouched();
      // Nothing half-applied blocks a retry.
      await deleteCategory(d1, category.id, category.revision, 'admin');
      fullyDeleted();
    });
  }

  it('a crash while reindexing after the commit keeps the category deleted and every article cleared', async () => {
    expect(String(await settle(deleteCategory(crashingD1(d1, sqlPoint(/^DELETE FROM knowledge_fts/)).d1, category.id, category.revision, 'admin')))).toMatch(/crashed/);
    fullyDeleted();
  });

  it('marks, clears and audits in one batch', async () => {
    const spy = crashingD1(d1);
    await deleteCategory(spy.d1, category.id, category.revision, 'admin');
    fullyDeleted();
    const batch = spy.batches.find(b => b.some(s => /UPDATE knowledge_categories SET deleted_at/.test(s))) ?? [];
    expect(batch.some(s => /UPDATE articles SET category_id = NULL/.test(s))).toBe(true);
    expect(batch.some(s => /INSERT INTO taxonomy_audit_log/.test(s))).toBe(true);
    expect(spy.runs.some(s => /knowledge_categories|category_id|taxonomy_audit_log/.test(s))).toBe(false);
  });

  it('a category restored after a delete can be deleted again', async () => {
    await deleteCategory(d1, category.id, category.revision, 'admin');
    // Categories have no restore endpoint; an operator restores one by clearing deleted_at (as a D1 time-travel
    // restore would) and reattaching its articles.
    d1.raw.query('UPDATE knowledge_categories SET deleted_at = NULL, revision = revision + 1 WHERE id = ?').run(category.id);
    d1.raw.query("UPDATE articles SET category_id = ? WHERE slug IN ('one', 'two')").run(category.id);
    const restored = await getCategory(d1, category.id);
    if (!restored) throw new Error('category was not restored');
    expect(state()).toEqual({ deleted: { deleted_at: null }, attached: 2, audits: 1 });
    // The previous revision is stale now; only the current one deletes.
    const stale = await settle(deleteCategory(d1, category.id, category.revision, 'admin'));
    expect(stale instanceof AppError ? [stale.status, stale.code] : stale).toEqual([409, 'revision_conflict']);
    await deleteCategory(d1, category.id, restored.revision, 'admin');
    fullyDeleted(2);
  });

  it('a stale revision is a 409 that clears no article and writes no audit row', async () => {
    const err = await settle(deleteCategory(d1, category.id, category.revision + 1, 'admin'));
    expect(err instanceof AppError ? [err.status, err.code] : err).toEqual([409, 'revision_conflict']);
    untouched();
  });
});

describe('tag delete is atomic (real SQLite)', () => {
  let d1: ReturnType<typeof createTestD1>;
  let tag: { id: string; revision: number };

  beforeEach(async () => {
    d1 = createTestD1();
    await createArticle(d1, { slug: 'one', title: 'Một', tags: ['kept', 'other'] });
    await createArticle(d1, { slug: 'two', title: 'Hai', tags: ['kept'] });
    const found = await getTag(d1, 'kept');
    if (!found) throw new Error('seed tag missing');
    tag = found;
  });

  const state = () => ({
    deleted: d1.raw.query('SELECT deleted_at FROM topic_tags WHERE id = ?').get(tag.id) as { deleted_at: string | null },
    assigned: (d1.raw.query('SELECT COUNT(*) AS n FROM article_tags WHERE tag_id = ?').get(tag.id) as { n: number }).n,
    audits: (d1.raw.query("SELECT COUNT(*) AS n FROM taxonomy_audit_log WHERE action = 'tag.delete' AND target_id = ?").get(tag.id) as { n: number }).n,
  });
  // The legacy `articles.tags` name list of each article, which must always match its live tags.
  const legacy = () => Object.fromEntries((d1.raw.query('SELECT slug, tags FROM articles ORDER BY slug').all() as Array<{ slug: string; tags: string }>)
    .map(r => [r.slug, JSON.parse(r.tags)]));
  const untouched = () => {
    expect(state()).toEqual({ deleted: { deleted_at: null }, assigned: 2, audits: 0 });
    expect(legacy()).toEqual({ one: ['kept', 'other'], two: ['kept'] });
  };
  const fullyDeleted = (audits = 1) => {
    const s = state();
    expect(s.deleted.deleted_at).toEqual(expect.any(String));
    expect({ assigned: s.assigned, audits: s.audits }).toEqual({ assigned: 0, audits });
    expect(legacy()).toEqual({ one: ['other'], two: [] });
  };

  const beforeCommit: Array<[string, RegExp]> = [
    ['the mark', /^UPDATE topic_tags SET deleted_at/],
    ['the read of the assigned articles, right after the mark', /^SELECT article_id FROM article_tags WHERE tag_id = \?$/],
    ['the legacy tag names update', /^UPDATE articles SET tags/],
    ['the unassign', /^DELETE FROM article_tags WHERE tag_id/],
    ['the audit row', /^INSERT INTO taxonomy_audit_log/],
  ];

  for (const [name, re] of beforeCommit) {
    it(`a crash at ${name} deletes nothing and leaves every assignment`, async () => {
      expect(String(await settle(deleteTag(crashingD1(d1, sqlPoint(re)).d1, tag.id, tag.revision, 'admin')))).toMatch(/crashed/);
      untouched();
      await deleteTag(d1, tag.id, tag.revision, 'admin');
      fullyDeleted();
    });
  }

  it('a crash while reindexing after the commit keeps the tag deleted, unassigned and out of every legacy tag list', async () => {
    expect(String(await settle(deleteTag(crashingD1(d1, sqlPoint(/^DELETE FROM knowledge_fts/)).d1, tag.id, tag.revision, 'admin')))).toMatch(/crashed/);
    fullyDeleted();
  });

  it('marks, updates legacy tag names, unassigns and audits in one batch', async () => {
    const spy = crashingD1(d1);
    await deleteTag(spy.d1, tag.id, tag.revision, 'admin');
    fullyDeleted();
    const batch = spy.batches.find(b => b.some(s => /UPDATE topic_tags SET deleted_at/.test(s))) ?? [];
    expect(batch.some(s => /UPDATE articles SET tags/.test(s))).toBe(true);
    expect(batch.some(s => /DELETE FROM article_tags/.test(s))).toBe(true);
    expect(batch.some(s => /INSERT INTO taxonomy_audit_log/.test(s))).toBe(true);
    expect(spy.runs.some(s => /topic_tags|article_tags|taxonomy_audit_log|SET tags/.test(s))).toBe(false);
  });

  it('a tag restored after a delete can be deleted again', async () => {
    await deleteTag(d1, tag.id, tag.revision, 'admin');
    // Creating a tag with a deleted tag's slug restores it under the same id.
    const restored = await createTag(d1, { slug: 'kept', names: { vi: 'kept' }, aliases: [] }, 'admin');
    expect(restored.id).toBe(tag.id);
    await setTagsForArticle(d1, 'one', ['kept', 'other'], 1);
    await setTagsForArticle(d1, 'two', ['kept'], 1);
    const current = await getTag(d1, tag.id);
    if (!current) throw new Error('tag was not restored');
    expect(state()).toEqual({ deleted: { deleted_at: null }, assigned: 2, audits: 1 });
    expect(legacy()).toEqual({ one: ['kept', 'other'], two: ['kept'] });
    // The previous revision is stale now; only the current one deletes.
    const stale = await settle(deleteTag(d1, tag.id, tag.revision, 'admin'));
    expect(stale instanceof AppError ? [stale.status, stale.code] : stale).toEqual([409, 'revision_conflict']);
    await deleteTag(d1, tag.id, current.revision, 'admin');
    fullyDeleted(2);
  });

  it('a stale revision is a 409 that unassigns nothing and writes no audit row', async () => {
    const err = await settle(deleteTag(d1, tag.id, tag.revision + 1, 'admin'));
    expect(err instanceof AppError ? [err.status, err.code] : err).toEqual([409, 'revision_conflict']);
    untouched();
  });
});

describe('legacy tag names (real SQLite)', () => {
  it('match localizedName for every article locale and name shape', async () => {
    const d1 = createTestD1();
    await createArticle(d1, { slug: 'one', title: 'Một', tags: ['a', 'b', 'c', 'd', 'e'] });
    const shapes: Record<string, string> = {
      a: '{"vi":"Việt","en":"English","ja":"日本"}',
      b: '{"ja":"日本","ko":"한국"}',
      c: '{"en":"   ","zh":"中文"}',
      d: '{}',
      e: 'not json',
    };
    for (const [slug, names] of Object.entries(shapes)) d1.raw.query('UPDATE topic_tags SET names = ? WHERE slug = ?').run(names, slug);
    for (const locale of ['vi', 'en', 'ja', 'ko', 'zh', 'xx']) {
      d1.raw.query("UPDATE articles SET locale = ? WHERE slug = 'one'").run(locale);
      const row = d1.raw.query("SELECT id, tags FROM articles WHERE slug = 'one'").get() as { id: string; tags: string };
      await mirrorLegacyTags(d1, row.id);
      const stored = (d1.raw.query('SELECT tags FROM articles WHERE id = ?').get(row.id) as { tags: string }).tags;
      const expected = Object.entries(shapes).map(([slug, names]) => localizedName(parseNames(names), isLocale(locale) ? locale : 'vi', slug));
      expect([locale, JSON.parse(stored)]).toEqual([locale, expected]);
    }
  });
});
