import { describe, it, expect, beforeEach } from 'bun:test';
import { createTestD1, crashingD1 } from './helpers/d1';
import { createArticle } from '../src/lib/blocks/articles';
import { createCategory, deleteCategory } from '../src/lib/taxonomy/categories';
import { deleteTag, getTag } from '../src/lib/taxonomy/tags';
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
  const fullyDeleted = () => {
    const s = state();
    expect(s.deleted.deleted_at).toEqual(expect.any(String));
    expect({ attached: s.attached, audits: s.audits }).toEqual({ attached: 0, audits: 1 });
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
    await createArticle(d1, { slug: 'one', title: 'Một', tags: ['kept'] });
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
  const untouched = () => expect(state()).toEqual({ deleted: { deleted_at: null }, assigned: 2, audits: 0 });
  const fullyDeleted = () => {
    const s = state();
    expect(s.deleted.deleted_at).toEqual(expect.any(String));
    expect({ assigned: s.assigned, audits: s.audits }).toEqual({ assigned: 0, audits: 1 });
  };

  const beforeCommit: Array<[string, RegExp]> = [
    ['the mark', /^UPDATE topic_tags SET deleted_at/],
    ['the read of the assigned articles, right after the mark', /^SELECT article_id FROM article_tags WHERE tag_id = \?$/],
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

  it('a crash while mirroring legacy tags after the commit keeps the tag deleted and unassigned', async () => {
    expect(String(await settle(deleteTag(crashingD1(d1, sqlPoint(/^UPDATE articles SET tags = \?/)).d1, tag.id, tag.revision, 'admin')))).toMatch(/crashed/);
    fullyDeleted();
  });

  it('a stale revision is a 409 that unassigns nothing and writes no audit row', async () => {
    const err = await settle(deleteTag(d1, tag.id, tag.revision + 1, 'admin'));
    expect(err instanceof AppError ? [err.status, err.code] : err).toEqual([409, 'revision_conflict']);
    untouched();
  });
});
