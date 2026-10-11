import { describe, it, expect, beforeEach } from 'bun:test';
import { createTestD1 } from './helpers/d1';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../src/db/store';
import type { ArticleDocument } from '../src/lib/blocks/schema';
import type { ArticleRecord } from '../src/lib/blocks/articles';
import { createArticle, getArticle, updateArticle } from '../src/lib/blocks/articles';
import { AppError } from '../src/lib/http';

// A save bumps the revision and writes the draft together: no reader or concurrent save may ever
// observe one without the other.

function doc(text: string): ArticleDocument {
  return { version: 1, blocks: [{ id: 'p1', type: 'paragraph', text }] };
}

function paragraphText(rec: ArticleRecord | null): string {
  const block = rec?.draft.blocks[0];
  return block?.type === 'paragraph' ? block.text : '';
}

/** Wraps a database so `hook` runs once, right after the first write (run or batch) completes. */
function pauseAfterFirstWrite(inner: D1DatabaseLike, hook: () => Promise<void>): D1DatabaseLike {
  let fired = false;
  const fire = async (): Promise<void> => {
    if (fired) return;
    fired = true;
    await hook();
  };
  const unwrap = new WeakMap<D1PreparedStatementLike, D1PreparedStatementLike>();
  const wrap = (stmt: D1PreparedStatementLike): D1PreparedStatementLike => {
    const wrapped: D1PreparedStatementLike = {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
      first: <T = Record<string, unknown>>() => stmt.first<T>(),
      all: <T = Record<string, unknown>>() => stmt.all<T>(),
      run: async () => {
        const res = await stmt.run();
        await fire();
        return res;
      },
    };
    unwrap.set(wrapped, stmt);
    return wrapped;
  };
  return {
    prepare: (sql: string) => wrap(inner.prepare(sql)),
    batch: async (statements: D1PreparedStatementLike[]) => {
      const res = await inner.batch(statements.map(s => unwrap.get(s) ?? s));
      await fire();
      return res;
    },
  };
}

type Outcome = { ok: true; rec: ArticleRecord } | { ok: false; err: unknown };

function settle(p: Promise<ArticleRecord>): Promise<Outcome> {
  return p.then(rec => ({ ok: true as const, rec }), (err: unknown) => ({ ok: false as const, err }));
}

function conflictRevision(outcome: Outcome | undefined): number {
  if (!outcome || outcome.ok || !(outcome.err instanceof AppError)) throw new Error('expected an AppError');
  expect(outcome.err.status).toBe(409);
  expect(outcome.err.code).toBe('revision_conflict');
  const current = outcome.err.extra.current_revision;
  if (typeof current !== 'number') throw new Error('expected current_revision');
  return current;
}

describe('updateArticle atomicity (real SQLite)', () => {
  let d1: ReturnType<typeof createTestD1>;

  beforeEach(async () => {
    d1 = createTestD1();
    await createArticle(d1, { slug: 'post', title: 'Bài viết', document: doc('original') });
  });

  function storedDraft(): { revision: number; draft_json: string; history_json: string | null } {
    const row: unknown = d1.raw.query(`
      SELECT a.revision, e.draft_json,
        (SELECT r.document_json FROM article_revisions r WHERE r.article_id = a.id AND r.revision = a.revision) AS history_json
      FROM articles a JOIN article_editions e ON e.article_id = a.id AND e.locale = a.locale
      WHERE a.slug = 'post'
    `).get();
    if (!row || typeof row !== 'object' || !('revision' in row) || !('draft_json' in row) || !('history_json' in row)) {
      throw new Error('article row missing');
    }
    const { revision, draft_json, history_json } = row;
    if (typeof revision !== 'number' || typeof draft_json !== 'string') throw new Error('unexpected row shape');
    return { revision, draft_json, history_json: typeof history_json === 'string' ? history_json : null };
  }

  it('interleaved saves at the same revision: exactly one wins and the stored draft is the winner\'s', async () => {
    let snapshot: { revision: number; text: string } | undefined;
    let sameRevision: Outcome | undefined;
    let retried: Outcome | undefined;
    // Save A pauses right after its first write; meanwhile B saves at the same expected revision,
    // then retries at the revision it was told is current (the former lost-update window).
    const paused = pauseAfterFirstWrite(d1, async () => {
      const seen = await getArticle(d1, 'post');
      snapshot = { revision: seen?.revision ?? 0, text: paragraphText(seen) };
      sameRevision = await settle(updateArticle(d1, 'post', { document: doc('B') }, 1));
      retried = await settle(updateArticle(d1, 'post', { document: doc('B') }, conflictRevision(sameRevision)));
    });
    const a = await settle(updateArticle(paused, 'post', { document: doc('A') }, 1));

    // Same expected revision: A won, B lost with a conflict.
    expect(a.ok).toBe(true);
    expect(sameRevision?.ok).toBe(false);
    // Mid-save, a reader sees either the old article or A's save complete, never revision 2 with the old draft.
    expect(snapshot).toEqual({ revision: 2, text: 'A' });
    // B's retry is a later save on top of A's.
    expect(retried?.ok).toBe(true);

    const final = await getArticle(d1, 'post');
    expect(final?.revision).toBe(3);
    expect(paragraphText(final)).toBe('B');
    const stored = storedDraft();
    expect(stored.revision).toBe(3);
    expect(stored.history_json).toBe(stored.draft_json);
    expect(stored.draft_json).toBe(JSON.stringify(doc('B')));
  });

  it('a failed draft write leaves the revision, slug, tags and history untouched', async () => {
    d1.raw.run("CREATE TRIGGER fail_draft BEFORE UPDATE ON article_editions BEGIN SELECT RAISE(ABORT, 'draft write failed'); END");
    const input = { document: doc('lost'), slug: 'renamed', tags: ['atomic'] };
    let failed = false;
    try {
      await updateArticle(d1, 'post', input, 1);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);

    const rec = await getArticle(d1, 'post');
    expect(rec?.revision).toBe(1);
    expect(paragraphText(rec)).toBe('original');
    expect(rec?.tag_ids).toEqual([]);
    expect(await getArticle(d1, 'renamed')).toBeNull();
    expect(d1.raw.query('SELECT COUNT(*) AS n FROM article_revisions').get()).toEqual({ n: 1 });

    // The same save applies in full once the write can succeed.
    d1.raw.run('DROP TRIGGER fail_draft');
    const saved = await updateArticle(d1, 'post', input, 1);
    expect(saved.revision).toBe(2);
    expect(saved.slug).toBe('renamed');
    expect(paragraphText(saved)).toBe('lost');
    expect(saved.tag_ids.length).toBe(1);
    expect(d1.raw.query("SELECT tags FROM articles WHERE slug = 'renamed'").get()).toEqual({ tags: JSON.stringify(['atomic']) });
  });

  it('a stale save that would add an edition and tags writes nothing', async () => {
    await updateArticle(d1, 'post', { document: doc('newer') }, 1);
    const stale = await settle(updateArticle(d1, 'post', { locale: 'en', title: 'Post', document: doc('stale'), tags: ['stale'] }, 1));
    expect(conflictRevision(stale)).toBe(2);
    expect(d1.raw.query("SELECT COUNT(*) AS n FROM article_editions WHERE locale = 'en'").get()).toEqual({ n: 0 });
    expect(d1.raw.query('SELECT COUNT(*) AS n FROM article_tags').get()).toEqual({ n: 0 });
    expect(d1.raw.query('SELECT COUNT(*) AS n FROM article_revisions').get()).toEqual({ n: 2 });
    expect(storedDraft().draft_json).toBe(JSON.stringify(doc('newer')));
  });
});
