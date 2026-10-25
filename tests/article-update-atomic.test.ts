import { describe, it, expect, beforeEach } from 'bun:test';
import type { APIRoute } from 'astro';
import { createTestD1 } from './helpers/d1';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../src/db/store';
import type { ArticleDocument } from '../src/lib/blocks/schema';
import type { ArticleRecord } from '../src/lib/blocks/articles';
import { createArticle, deleteEdition, getArticle, publishArticle, setTagsForArticle, toWriteReceipt, updateArticle } from '../src/lib/blocks/articles';
import { AppError } from '../src/lib/http';
import { createSession } from '../src/db/store';
import { getArticleNotification } from '../src/lib/notifications/article-notification-schedule';
import { POST as publishApi } from '../src/pages/api/v1/articles/[slug]/publish';
import { PUT as updateApi } from '../src/pages/api/v1/articles/[slug]';
import { articlesMcpModule } from '../src/lib/blocks/mcp';
import type { McpContext } from '../src/lib/mcp/types';

// A save bumps the revision and writes the draft together: no reader or concurrent save may ever
// observe one without the other.

function doc(text: string): ArticleDocument {
  return { version: 1, blocks: [{ id: 'p1', type: 'paragraph', text }] };
}

function paragraphText(rec: ArticleRecord | null): string {
  const block = rec?.draft.blocks[0];
  return block?.type === 'paragraph' ? block.text : '';
}

/** Wraps a database so `hook` runs once, right before or right after the first write (run or batch). */
function interleaveAtFirstWrite(inner: D1DatabaseLike, when: 'before' | 'after', hook: () => Promise<void>): D1DatabaseLike {
  let fired = false;
  const fire = async (): Promise<void> => {
    if (fired) return;
    fired = true;
    await hook();
  };
  const around = async <T>(write: () => Promise<T>): Promise<T> => {
    if (when === 'before') await fire();
    const res = await write();
    if (when === 'after') await fire();
    return res;
  };
  const unwrap = new WeakMap<D1PreparedStatementLike, D1PreparedStatementLike>();
  const wrap = (stmt: D1PreparedStatementLike): D1PreparedStatementLike => {
    const wrapped: D1PreparedStatementLike = {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
      first: <T = Record<string, unknown>>() => stmt.first<T>(),
      all: <T = Record<string, unknown>>() => stmt.all<T>(),
      run: () => around(() => stmt.run()),
    };
    unwrap.set(wrapped, stmt);
    return wrapped;
  };
  return {
    prepare: (sql: string) => wrap(inner.prepare(sql)),
    batch: (statements: D1PreparedStatementLike[]) => around(() => inner.batch(statements.map(s => unwrap.get(s) ?? s))),
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
    const paused = interleaveAtFirstWrite(d1, 'after', async () => {
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

  it('stale saves to the existing edition, a deleted edition or the tags change nothing', async () => {
    await updateArticle(d1, 'post', { tags: ['kept'] }, 1);
    await updateArticle(d1, 'post', { locale: 'en', title: 'Post', document: doc('english') }, 2);
    await deleteEdition(d1, 'post', 'en', 3);
    await updateArticle(d1, 'post', { document: doc('current') }, 4);
    const stale = 4;
    const state = () => ({
      articles: d1.raw.query('SELECT * FROM articles').all(),
      editions: d1.raw.query('SELECT * FROM article_editions ORDER BY locale').all(),
      tags: d1.raw.query('SELECT article_id, tag_id, position FROM article_tags ORDER BY position').all(),
      revisions: d1.raw.query('SELECT COUNT(*) AS n FROM article_revisions').get(),
    });
    const before = state();
    expect(before.tags.length).toBe(1);

    const saves: Array<[string, Parameters<typeof updateArticle>[2]]> = [
      ['existing edition', { document: doc('stale'), title: 'Stale' }],
      ['deleted edition', { locale: 'en', title: 'Stale', document: doc('stale') }],
      ['tags', { tags: ['replaced'] }],
    ];
    for (const [label, input] of saves) {
      const outcome = await settle(updateArticle(d1, 'post', input, stale));
      expect(conflictRevision(outcome)).toBe(5);
      expect({ label, ...state() }).toEqual({ label, ...before });
    }
    expect(paragraphText(await getArticle(d1, 'post'))).toBe('current');
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

describe('updateArticle race and post-commit errors (real SQLite)', () => {
  let d1: ReturnType<typeof createTestD1>;

  beforeEach(async () => {
    d1 = createTestD1();
    await createArticle(d1, { slug: 'post', title: 'Bài viết', document: doc('original') });
  });

  const state = () => ({
    articles: d1.raw.query("SELECT * FROM articles WHERE id = (SELECT id FROM articles WHERE title = 'Bài viết')").all(),
    editions: d1.raw.query('SELECT * FROM article_editions ORDER BY article_id, locale').all(),
    revisions: d1.raw.query('SELECT COUNT(*) AS n FROM article_revisions').get(),
  });

  it('a slug taken between the check and the write is 409 slug_taken and writes nothing', async () => {
    let afterTake: ReturnType<typeof state> | undefined;
    const paused = interleaveAtFirstWrite(d1, 'before', async () => {
      await createArticle(d1, { slug: 'renamed', title: 'Other' });
      afterTake = state();
    });
    const outcome = await settle(updateArticle(paused, 'post', { slug: 'renamed', document: doc('lost') }, 1));
    if (outcome.ok || !(outcome.err instanceof AppError)) throw new Error('expected an AppError');
    expect(outcome.err.status).toBe(409);
    expect(outcome.err.code).toBe('slug_taken');
    if (!afterTake) throw new Error('the interleaved create did not run');
    expect(state()).toEqual(afterTake);
    expect(paragraphText(await getArticle(d1, 'post'))).toBe('original');
  });

  it('a conflict with a save that renamed the article is 409 revision_conflict, not 404', async () => {
    const paused = interleaveAtFirstWrite(d1, 'before', async () => {
      await updateArticle(d1, 'post', { slug: 'moved' }, 1);
    });
    const outcome = await settle(updateArticle(paused, 'post', { document: doc('stale') }, 1));
    expect(conflictRevision(outcome)).toBe(2);
    expect(paragraphText(await getArticle(d1, 'moved'))).toBe('original');
  });

  it('a failed legacy tag mirror after commit still returns the saved article', async () => {
    d1.raw.run("CREATE TRIGGER fail_mirror BEFORE UPDATE OF tags ON articles BEGIN SELECT RAISE(ABORT, 'mirror failed'); END");
    const saved = await updateArticle(d1, 'post', { document: doc('saved'), tags: ['kept'] }, 1);
    expect(saved.revision).toBe(2);
    expect(paragraphText(saved)).toBe('saved');
    expect(saved.tag_ids.length).toBe(1);
    // The derived column catches up on the next save once the mirror works again.
    d1.raw.run('DROP TRIGGER fail_mirror');
    await updateArticle(d1, 'post', { tags: ['kept'] }, 2);
    expect(d1.raw.query("SELECT tags FROM articles WHERE slug = 'post'").get()).toEqual({ tags: JSON.stringify(['kept']) });
  });

  it('a failed search reindex after commit still returns the saved article', async () => {
    d1.raw.run('DROP TABLE knowledge_fts');
    const saved = await updateArticle(d1, 'post', { document: doc('saved') }, 1);
    expect(saved.revision).toBe(2);
    expect(paragraphText(saved)).toBe('saved');
    expect(storedRevision(d1)).toBe(2);
  });
});

function storedRevision(d1: ReturnType<typeof createTestD1>): number {
  const row: unknown = d1.raw.query("SELECT revision FROM articles WHERE slug = 'post'").get();
  if (!row || typeof row !== 'object' || !('revision' in row) || typeof row.revision !== 'number') throw new Error('article row missing');
  return row.revision;
}

describe('publish, edition delete and tag writes are atomic with the revision bump (real SQLite)', () => {
  let d1: ReturnType<typeof createTestD1>;
  // Article at revision 4: primary vi draft, a live en edition, tag "kept" (tag "spare" exists, unassigned).
  const R = 4;

  beforeEach(async () => {
    d1 = createTestD1();
    await createArticle(d1, { slug: 'post', title: 'Bài viết', document: doc('original') });
    await updateArticle(d1, 'post', { tags: ['spare'] }, 1);
    await updateArticle(d1, 'post', { tags: ['kept'] }, 2);
    await updateArticle(d1, 'post', { locale: 'en', title: 'Post', document: doc('english') }, 3);
  });

  const state = () => ({
    articles: d1.raw.query('SELECT * FROM articles').all(),
    editions: d1.raw.query('SELECT * FROM article_editions ORDER BY locale').all(),
    tags: d1.raw.query('SELECT article_id, tag_id, position FROM article_tags ORDER BY position').all(),
    revisions: d1.raw.query('SELECT * FROM article_revisions ORDER BY revision, created_at').all(),
  });

  type Writer = (db: D1DatabaseLike, expected: number) => Promise<ArticleRecord>;
  const writers: Array<[string, Writer]> = [
    ['publishArticle', (db, expected) => publishArticle(db, 'post', expected, true)],
    ['deleteEdition', (db, expected) => deleteEdition(db, 'post', 'en', expected)],
    ['setTagsForArticle', (db, expected) => setTagsForArticle(db, 'post', ['spare'], expected)],
  ];

  for (const [name, write] of writers) {
    it(`${name}: a save between its read and its write makes it a conflict that writes nothing`, async () => {
      let afterSave: ReturnType<typeof state> | undefined;
      const paused = interleaveAtFirstWrite(d1, 'before', async () => {
        await updateArticle(d1, 'post', { document: doc('B') }, R);
        afterSave = state();
      });
      const outcome = await settle(write(paused, R));
      expect(conflictRevision(outcome)).toBe(R + 1);
      if (!afterSave) throw new Error('the interleaved save did not run');
      expect(state()).toEqual(afterSave);
    });
  }

  it('publishArticle publishes the draft it read, even when a save lands right after it', async () => {
    const paused = interleaveAtFirstWrite(d1, 'after', async () => {
      await updateArticle(d1, 'post', { document: doc('B') }, R + 1);
    });
    await publishArticle(paused, 'post', R, true);
    const row: unknown = d1.raw.query(`
      SELECT e.published_json, e.draft_json, r.document_json AS history_json
      FROM article_editions e JOIN article_revisions r ON r.article_id = e.article_id AND r.locale = e.locale AND r.action = 'publish'
      WHERE e.locale = 'vi'
    `).get();
    expect(row).toEqual({ published_json: JSON.stringify(doc('original')), draft_json: JSON.stringify(doc('B')), history_json: JSON.stringify(doc('original')) });
  });

  it('deleteEdition never discards a save that lands right after it', async () => {
    const paused = interleaveAtFirstWrite(d1, 'after', async () => {
      await updateArticle(d1, 'post', { locale: 'en', title: 'Post', document: doc('B') }, R + 1);
    });
    await deleteEdition(paused, 'post', 'en', R);
    expect(d1.raw.query("SELECT draft_json, deleted_at FROM article_editions WHERE locale = 'en'").get())
      .toEqual({ draft_json: JSON.stringify(doc('B')), deleted_at: null });
    expect(d1.raw.query('SELECT revision FROM articles').get()).toEqual({ revision: R + 2 });
  });

  it('setTagsForArticle never overwrites tags saved right after it', async () => {
    const paused = interleaveAtFirstWrite(d1, 'after', async () => {
      await updateArticle(d1, 'post', { tags: ['later'] }, R + 1);
    });
    await setTagsForArticle(paused, 'post', ['spare'], R);
    expect(d1.raw.query('SELECT t.slug FROM article_tags at JOIN topic_tags t ON t.id = at.tag_id').all()).toEqual([{ slug: 'later' }]);
    expect(d1.raw.query('SELECT tags FROM articles').get()).toEqual({ tags: JSON.stringify(['later']) });
  });

  const failures: Array<[string, string, Writer]> = [
    ['publishArticle', 'CREATE TRIGGER fail BEFORE INSERT ON article_revisions BEGIN SELECT RAISE(ABORT, \'history write failed\'); END', writers[0][1]],
    ['deleteEdition', 'CREATE TRIGGER fail BEFORE INSERT ON article_revisions BEGIN SELECT RAISE(ABORT, \'history write failed\'); END', writers[1][1]],
    ['setTagsForArticle', 'CREATE TRIGGER fail BEFORE INSERT ON article_tags BEGIN SELECT RAISE(ABORT, \'tag write failed\'); END', writers[2][1]],
  ];
  for (const [name, trigger, write] of failures) {
    it(`${name}: a failed write part-way through leaves no partial change, and a retry applies in full`, async () => {
      const before = state();
      d1.raw.run(trigger);
      const failed = await settle(write(d1, R));
      expect(failed.ok).toBe(false);
      expect(state()).toEqual(before);

      d1.raw.run('DROP TRIGGER fail');
      const saved = await write(d1, R);
      expect(saved.revision).toBe(R + 1);
    });
  }
});

describe('post-commit failures and renames never turn a committed write into an error (real SQLite)', () => {
  let d1: ReturnType<typeof createTestD1>;
  // Article at revision 4: primary vi draft, a live en edition, tag "kept" (tag "spare" exists, unassigned).
  const R = 4;

  beforeEach(async () => {
    d1 = createTestD1();
    await createArticle(d1, { slug: 'post', title: 'Bài viết', document: doc('original') });
    await updateArticle(d1, 'post', { tags: ['spare'] }, 1);
    await updateArticle(d1, 'post', { tags: ['kept'] }, 2);
    await updateArticle(d1, 'post', { locale: 'en', title: 'Post', document: doc('english') }, 3);
  });

  type Writer = (db: D1DatabaseLike, expected: number) => Promise<ArticleRecord>;
  const writers: Array<[string, Writer, (rec: ArticleRecord) => void]> = [
    ['publishArticle', (db, expected) => publishArticle(db, 'post', expected, true, { notify: false }), rec => expect(rec.published_revision).toBe(R + 1)],
    ['deleteEdition', (db, expected) => deleteEdition(db, 'post', 'en', expected), rec => expect(rec.editions.map(e => e.locale)).toEqual(['vi'])],
    ['setTagsForArticle', (db, expected) => setTagsForArticle(db, 'post', ['spare'], expected), rec => expect(rec.tags).toEqual(['spare'])],
  ];

  for (const [name, write, landed] of writers) {
    it(`${name}: a failed search reindex after commit still returns the committed article`, async () => {
      d1.raw.run('DROP TABLE knowledge_fts');
      const rec = await write(d1, R);
      expect(rec.revision).toBe(R + 1);
      landed(rec);
      expect(storedRevision(d1)).toBe(R + 1);
    });

    it(`${name}: a rename between commit and read-back still returns the committed article`, async () => {
      const paused = interleaveAtFirstWrite(d1, 'after', async () => {
        await updateArticle(d1, 'post', { slug: 'moved' }, R + 1);
      });
      const rec = await write(paused, R);
      expect(rec.slug).toBe('moved');
      expect(rec.revision).toBe(R + 2);
      landed(rec);
    });
  }

  it('setTagsForArticle: a failed legacy tag mirror after commit still returns the committed tags', async () => {
    d1.raw.run("CREATE TRIGGER fail_mirror BEFORE UPDATE OF tags ON articles BEGIN SELECT RAISE(ABORT, 'mirror failed'); END");
    const rec = await setTagsForArticle(d1, 'post', ['spare'], R);
    expect(rec.revision).toBe(R + 1);
    expect(rec.tags).toEqual(['spare']);
    // The derived column catches up on the next tag write once the mirror works again.
    d1.raw.run('DROP TRIGGER fail_mirror');
    await setTagsForArticle(d1, 'post', ['spare'], R + 1);
    expect(d1.raw.query('SELECT tags FROM articles').get()).toEqual({ tags: JSON.stringify(['spare']) });
  });

  it('updateArticle: a rename between commit and read-back still returns the saved article', async () => {
    const paused = interleaveAtFirstWrite(d1, 'after', async () => {
      await updateArticle(d1, 'post', { slug: 'moved' }, R + 1);
    });
    const rec = await updateArticle(paused, 'post', { document: doc('saved') }, R);
    expect(rec.slug).toBe('moved');
    expect(rec.revision).toBe(R + 2);
    expect(paragraphText(rec)).toBe('saved');
  });
});
describe('publishArticle: a failed email step after commit is reported, not thrown (real SQLite)', () => {
  let d1: ReturnType<typeof createTestD1>;

  beforeEach(async () => {
    d1 = createTestD1();
    await createArticle(d1, { slug: 'post', title: 'Bài viết', document: doc('original') });
    // The email step is the only writer of article_notifications, and it runs after the publish batch.
    d1.raw.run("CREATE TRIGGER fail_notify BEFORE INSERT ON article_notifications BEGIN SELECT RAISE(ABORT, 'email provider down'); END");
  });

  async function publishRest(body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
    const cookie = `zuey_session=${await createSession('admin@zuey.me', d1)}`;
    const request = new Request('https://zuey.test/api/v1/articles/post/publish', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const ctx = { request, params: { slug: 'post' }, url: new URL(request.url), locals: { runtime: { env: { DB: d1 } } } };
    // The handler only reads request/params/locals; a full APIContext is not constructible in tests.
    const res = await publishApi(ctx as unknown as Parameters<APIRoute>[0]);
    const json: unknown = await res.json();
    if (!json || typeof json !== 'object' || !('data' in json) || !json.data || typeof json.data !== 'object') throw new Error(`unexpected body (${res.status})`);
    return { status: res.status, data: { ...json.data } };
  }

  it('REST publish returns 200 with the edition published and a failed email_notification', async () => {
    const res = await publishRest({ expected_revision: 1, confirm: true, response_mode: 'summary' });
    expect(res.status).toBe(200);
    expect(res.data.email_notification).toEqual({ status: 'failed', send_after: null, sent_count: 0, reason: 'notification_update_failed', updated_at: expect.any(String) });
    expect(res.data.receipt).toMatchObject({ operation: 'publish', published_revision: 2 });
    expect(JSON.stringify(res.data)).not.toContain('email provider down');

    const published = await getArticle(d1, 'post');
    expect(published?.status).toBe('published');
    expect(published?.published_revision).toBe(2);
  });

  it('a republish with an explicit notify applies the email decision once the step works again', async () => {
    const first = await publishArticle(d1, 'post', 1, true);
    expect(first.published_revision).toBe(2);
    expect(first.email_notification?.status).toBe('failed');
    expect(await getArticleNotification(d1, first.id)).toBeNull();

    d1.raw.run('DROP TRIGGER fail_notify');
    const retried = await publishArticle(d1, 'post', first.revision, true, { notify: true });
    expect(retried.email_notification?.status).toBe('scheduled');
    expect((await getArticleNotification(d1, first.id))?.status).toBe('scheduled');
  });
});

describe('publishArticle: a failed email update reports the email state that is actually stored (real SQLite)', () => {
  let d1: ReturnType<typeof createTestD1>;

  beforeEach(async () => {
    d1 = createTestD1();
    await createArticle(d1, { slug: 'post', title: 'Bài viết', document: doc('original') });
  });

  const failUpdates = (): void => {
    d1.raw.run("CREATE TRIGGER fail_notify_update BEFORE UPDATE ON article_notifications BEGIN SELECT RAISE(ABORT, 'email provider down'); END");
  };

  it('a failed notify:false cancel reports the email as still scheduled, as stored', async () => {
    const first = await publishArticle(d1, 'post', 1, true);
    expect(first.email_notification?.status).toBe('scheduled');
    const stored = await getArticleNotification(d1, first.id);
    expect(stored?.status).toBe('scheduled');
    failUpdates();

    const republished = await publishArticle(d1, 'post', first.revision, true, { notify: false });
    expect(republished.published_revision).toBe(first.revision + 1);
    expect(republished.email_notification).toMatchObject({ status: 'scheduled', send_after: stored?.send_after, reason: 'notification_update_failed' });
    expect((await getArticleNotification(d1, first.id))?.status).toBe('scheduled');
  });

  it('a failed notify:true re-schedule reports the email as still skipped, as stored', async () => {
    const first = await publishArticle(d1, 'post', 1, true, { notify: false });
    expect(first.email_notification?.status).toBe('skipped');
    failUpdates();

    const republished = await publishArticle(d1, 'post', first.revision, true, { notify: true });
    expect(republished.email_notification).toMatchObject({ status: 'skipped', reason: 'notification_update_failed' });
    expect((await getArticleNotification(d1, first.id))?.status).toBe('skipped');
  });

  it('MCP article_publish reports a still-scheduled email when the cancel fails', async () => {
    const ctx: McpContext = { request: new Request('https://zuey.test/api/mcp'), env: {}, d1, async requireAdmin() {}, async isAdmin() { return true; } };
    const first = await publishArticle(d1, 'post', 1, true);
    failUpdates();

    const res = await articlesMcpModule.call('article_publish', { slug: 'post', expected_revision: first.revision, confirm: true, notify: false, response_mode: 'summary' }, ctx);
    expect(res).toMatchObject({ email_notification: { status: 'scheduled', reason: 'notification_update_failed' } });
    expect(JSON.stringify(res)).not.toContain('email provider down');
    expect((await getArticleNotification(d1, first.id))?.status).toBe('scheduled');
  });
});
/**
 * Wraps a database so that, once the first batch (the commit) has run, every read of the article row by id fails
 * like a D1 storage error: exactly the read-back a writer does after its commit.
 */
function failReadBackAfterCommit(inner: D1DatabaseLike): D1DatabaseLike {
  let committed = false;
  const failing = (stmt: D1PreparedStatementLike): D1PreparedStatementLike => ({
    bind: (...values: unknown[]) => failing(stmt.bind(...values)),
    first: async () => { throw new Error('D1_ERROR: read-back storage unavailable'); },
    all: () => stmt.all(),
    run: () => stmt.run(),
  });
  return {
    prepare: (sql: string) => {
      const stmt = inner.prepare(sql);
      return committed && sql.startsWith('SELECT * FROM articles WHERE id = ?') ? failing(stmt) : stmt;
    },
    batch: async (statements: D1PreparedStatementLike[]) => {
      const res = await inner.batch(statements);
      committed = true;
      return res;
    },
  };
}

describe('a failed read-back after commit never turns a committed update or publish into an error (real SQLite)', () => {
  let d1: ReturnType<typeof createTestD1>;
  const RAW_ERROR = 'read-back storage unavailable';

  beforeEach(async () => {
    d1 = createTestD1();
    await createArticle(d1, { slug: 'post', title: 'Bài viết', document: doc('original'), tags: ['kept'] });
  });

  const storedEdition = () => d1.raw.query("SELECT draft_json, published_json, published_revision, revision FROM article_editions WHERE locale = 'vi'").get();
  // A concurrent delete between the commit and the read-back.
  const deleteAfterCommit = () => interleaveAtFirstWrite(d1, 'after', async () => {
    d1.raw.run("UPDATE articles SET deleted_at = '2026-01-01T00:00:00.000Z'");
  });
  const breakings: Array<[string, () => D1DatabaseLike]> = [
    ['a D1 error', () => failReadBackAfterCommit(d1)],
    ['a concurrent delete', deleteAfterCommit],
  ];

  for (const [cause, broken] of breakings) {
    it(`publishArticle: ${cause} on read-back returns the published edition flagged read_back failed`, async () => {
      const rec = await publishArticle(broken(), 'post', 1, true, { notify: false });
      expect(rec).toMatchObject({ read_back: 'failed', status: 'published', revision: 2, published_revision: 2, has_unpublished_changes: false, slug: 'post', locale: 'vi' });
      expect(paragraphText(rec)).toBe('original');
      expect(rec.published).toEqual(doc('original'));
      expect(toWriteReceipt(rec, 'publish', [])).toMatchObject({ operation: 'publish', article_revision: 2, edition_draft_revision: 2, published_revision: 2, next_action: 'none' });
      expect(storedEdition()).toEqual({ draft_json: JSON.stringify(doc('original')), published_json: JSON.stringify(doc('original')), published_revision: 2, revision: 2 });
    });

    it(`updateArticle: ${cause} on read-back returns the saved draft flagged read_back failed`, async () => {
      const rec = await updateArticle(broken(), 'post', { document: doc('saved'), title: 'Mới' }, 1);
      expect(rec).toMatchObject({ read_back: 'failed', status: 'draft', revision: 2, published_revision: null, has_unpublished_changes: true, title: 'Mới' });
      expect(paragraphText(rec)).toBe('saved');
      expect(toWriteReceipt(rec, 'update', ['title', 'document'])).toMatchObject({ operation: 'update', article_revision: 2, edition_draft_revision: 2, next_action: 'publish' });
      expect(storedEdition()).toMatchObject({ draft_json: JSON.stringify(doc('saved')), revision: 2 });
    });
  }

  it('a working read-back carries no read_back flag', async () => {
    const saved = await updateArticle(d1, 'post', { document: doc('saved') }, 1);
    const published = await publishArticle(d1, 'post', 2, true, { notify: false });
    expect(saved.read_back).toBeUndefined();
    expect(published.read_back).toBeUndefined();
    expect(published.tags).toEqual(['kept']);
  });

  async function callRest(handler: APIRoute, method: 'POST' | 'PUT', path: string, body: unknown): Promise<{ status: number; text: string; data: Record<string, unknown> }> {
    const cookie = `zuey_session=${await createSession('admin@zuey.me', d1)}`;
    const request = new Request(`https://zuey.test${path}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const ctx = { request, params: { slug: 'post' }, url: new URL(request.url), locals: { runtime: { env: { DB: failReadBackAfterCommit(d1) } } } };
    // The handlers only read request/params/locals; a full APIContext is not constructible in tests.
    const res = await handler(ctx as unknown as Parameters<APIRoute>[0]);
    const text = await res.text();
    const json: unknown = JSON.parse(text);
    if (!json || typeof json !== 'object' || !('data' in json) || !json.data || typeof json.data !== 'object') throw new Error(`unexpected body (${res.status})`);
    return { status: res.status, text, data: { ...json.data } };
  }

  it('REST publish returns 200 with the edition published and read_back failed', async () => {
    const res = await callRest(publishApi, 'POST', '/api/v1/articles/post/publish', { expected_revision: 1, confirm: true, notify: false });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ read_back: 'failed', status: 'published', published_revision: 2, document: doc('original') });
    expect(res.data.receipt).toMatchObject({ operation_success: true, operation: 'publish', article_revision: 2, published_revision: 2 });
    expect(res.text).not.toContain(RAW_ERROR);
    expect((await getArticle(d1, 'post'))?.published_revision).toBe(2);
  });

  it('REST update returns 200 with the draft saved and read_back failed', async () => {
    const res = await callRest(updateApi, 'PUT', '/api/v1/articles/post', { expected_revision: 1, document: doc('saved'), response_mode: 'summary' });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ read_back: 'failed', revision: 2, document_blocks: 1 });
    expect(res.data.receipt).toMatchObject({ operation: 'update', article_revision: 2, next_action: 'publish' });
    expect(res.text).not.toContain(RAW_ERROR);
    expect(paragraphText(await getArticle(d1, 'post'))).toBe('saved');
  });

  const mcpCtx = (): McpContext => ({ request: new Request('https://zuey.test/api/mcp'), env: {}, d1: failReadBackAfterCommit(d1), async requireAdmin() {}, async isAdmin() { return true; } });

  it('MCP article_publish answers with the edition published and read_back failed', async () => {
    const res = await articlesMcpModule.call('article_publish', { slug: 'post', expected_revision: 1, confirm: true, notify: false, response_mode: 'summary' }, mcpCtx());
    expect(res).toMatchObject({ read_back: 'failed', status: 'published', receipt: { operation: 'publish', article_revision: 2, published_revision: 2 } });
    expect(JSON.stringify(res)).not.toContain(RAW_ERROR);
    expect((await getArticle(d1, 'post'))?.status).toBe('published');
  });

  it('MCP article_update answers with the draft saved and read_back failed', async () => {
    const res = await articlesMcpModule.call('article_update', { slug: 'post', expected_revision: 1, document: doc('saved'), response_mode: 'summary' }, mcpCtx());
    expect(res).toMatchObject({ read_back: 'failed', revision: 2, receipt: { operation: 'update', article_revision: 2 } });
    expect(JSON.stringify(res)).not.toContain(RAW_ERROR);
    expect(paragraphText(await getArticle(d1, 'post'))).toBe('saved');
  });
});

describe('the read-back fallback reports the same exact fields as a normal read of the committed state (real SQLite)', () => {
  let d1: ReturnType<typeof createTestD1>;

  beforeEach(async () => {
    d1 = createTestD1();
    await createArticle(d1, { slug: 'post', title: 'Bài viết', document: doc('original'), tags: ['kept'] });
  });

  // Fields documented as exact in a read_back "failed" answer.
  const EXACT = [
    'id', 'slug', 'locale', 'primary_locale', 'title', 'excerpt', 'access', 'status', 'revision', 'label_revision', 'published_revision',
    'created_at', 'updated_at', 'published_at', 'has_unpublished_changes', 'reading_minutes', 'cover_url', 'cover_asset_id', 'cover_alt',
    'social_preview', 'category_id', 'draft', 'draft_recovery', 'published',
  ] as const;

  async function expectMatchesStored(fallback: ArticleRecord, operation: 'update' | 'publish'): Promise<void> {
    const real = await getArticle(d1, 'post', { locale: fallback.locale });
    if (!real) throw new Error('article missing');
    for (const key of EXACT) expect({ [key]: fallback[key] }).toEqual({ [key]: real[key] });
    expect(fallback.editions).toEqual(real.editions.filter(e => e.locale === fallback.locale));
    expect(toWriteReceipt(fallback, operation, [])).toEqual(toWriteReceipt(real, operation, []));
    // Not loaded: reported empty rather than derived from the one written edition.
    expect(fallback).toMatchObject({ read_back: 'failed', tags: [], topic_tags: [], category: null, labels: [], available_locales: [], tag_ids: [] });
  }

  it('update of a draft edition while another edition is live', async () => {
    await publishArticle(d1, 'post', 1, true, { notify: false });
    await updateArticle(d1, 'post', { locale: 'en', title: 'Post', document: doc('english') }, 2);
    const rec = await updateArticle(failReadBackAfterCommit(d1), 'post', { locale: 'en', document: doc('english 2') }, 3);
    expect(rec.status).toBe('draft');
    await expectMatchesStored(rec, 'update');
    // The live vi edition is not reported as missing: available_locales is "not loaded", not "nothing public".
    expect((await getArticle(d1, 'post', { locale: 'en' }))?.available_locales).toEqual(['vi']);
  });

  it('update that creates a missing edition', async () => {
    const rec = await updateArticle(failReadBackAfterCommit(d1), 'post', { locale: 'en', title: 'Post', excerpt: 'New', document: doc('english') }, 1);
    expect(rec).toMatchObject({ locale: 'en', status: 'draft', published_revision: null, has_unpublished_changes: true });
    await expectMatchesStored(rec, 'update');
  });

  it('update that re-creates a deleted edition', async () => {
    await updateArticle(d1, 'post', { locale: 'en', title: 'Post', document: doc('english') }, 1);
    await publishArticle(d1, 'post', 2, true, { locale: 'en', notify: false });
    await deleteEdition(d1, 'post', 'en', 3);
    const rec = await updateArticle(failReadBackAfterCommit(d1), 'post', { locale: 'en', title: 'Again', document: doc('again') }, 4);
    expect(rec).toMatchObject({ locale: 'en', status: 'draft', published_revision: null, published_at: null });
    await expectMatchesStored(rec, 'update');
  });

  it('update of an edition that is already published keeps its public snapshot', async () => {
    await publishArticle(d1, 'post', 1, true, { notify: false });
    const rec = await updateArticle(failReadBackAfterCommit(d1), 'post', { title: 'Đổi tên', document: doc('changed') }, 2);
    expect(rec).toMatchObject({ status: 'published', published_revision: 2, has_unpublished_changes: true });
    expect(rec.published).toEqual(doc('original'));
    await expectMatchesStored(rec, 'update');
  });

  it('publish of a second edition, with a backdated publish time', async () => {
    await publishArticle(d1, 'post', 1, true, { notify: false });
    await updateArticle(d1, 'post', { locale: 'en', title: 'Post', document: doc('english') }, 2);
    const rec = await publishArticle(failReadBackAfterCommit(d1), 'post', 3, true, { locale: 'en', publishedAt: '2020-05-01T00:00:00.000Z', notify: false });
    expect(rec).toMatchObject({ locale: 'en', status: 'published', published_revision: 4, published_at: '2020-05-01T00:00:00.000Z' });
    await expectMatchesStored(rec, 'publish');
  });

  it('republish keeps the first publish time', async () => {
    await publishArticle(d1, 'post', 1, true, { notify: false });
    await updateArticle(d1, 'post', { document: doc('changed') }, 2);
    const rec = await publishArticle(failReadBackAfterCommit(d1), 'post', 3, true, { notify: false });
    await expectMatchesStored(rec, 'publish');
  });
});