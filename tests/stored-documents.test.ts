import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createTestD1 } from './helpers/d1';
import {
  createArticle, getArticle, getRevisionDocument, listRevisions, publishArticle, updateArticle,
} from '../src/lib/blocks/articles';
import { readStoredDocument, validateDocument } from '../src/lib/blocks/validate';
import { AppError } from '../src/lib/http';

// Stored documents were valid when written; today's stricter rules must never blank them on read,
// and a write must never persist a document that a read had to throw away.

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const SECRET = 'Nội dung riêng tư của bài';

/** A stored document whose embed claims a provider its URL does not match, plus a block no longer valid. */
function legacyDraft(): string {
  return JSON.stringify({
    version: 1,
    blocks: [
      { id: 'p1', type: 'paragraph', text: SECRET },
      { id: 'e1', type: 'embed', url: YT, provider: 'vimeo', caption: 'Video' },
      { id: 'h1', type: 'heading', level: 9, text: 'Bad level' },
      { id: 't1', type: 'toggle', summary: 'Mở', blocks: [{ id: 'x1', type: 'nope' }, { id: 'p2', type: 'paragraph', text: 'Inside' }] },
    ],
  });
}

describe('readStoredDocument (pure)', () => {
  it('degrades a mismatched embed to generic and drops only the invalid blocks', () => {
    const res = readStoredDocument(JSON.parse(legacyDraft()));
    if (!res) throw new Error('expected a readable document');
    expect(res.degraded).toBe(1);
    expect(res.dropped).toBe(2);
    expect(res.doc.blocks.map(b => b.id)).toEqual(['p1', 'e1', 't1']);
    expect(res.doc.blocks[1]).toEqual({ id: 'e1', type: 'embed', url: YT, provider: 'generic', caption: 'Video' });
    const toggle = res.doc.blocks[2];
    expect(toggle.type === 'toggle' ? toggle.blocks.map(b => b.id) : []).toEqual(['p2']);
    // The recovered document is valid under the strict write rules.
    expect(validateDocument(res.doc).ok).toBe(true);
  });

  it('keeps an id free when the block that claimed it was dropped', () => {
    const res = readStoredDocument({ version: 1, blocks: [{ id: 'a', type: 'heading', level: 7, text: 'x' }, { id: 'a', type: 'paragraph', text: 'kept' }] });
    expect(res?.doc.blocks).toEqual([{ id: 'a', type: 'paragraph', text: 'kept' }]);
  });

  it('returns null only for an unreadable envelope', () => {
    expect(readStoredDocument(null)).toBeNull();
    expect(readStoredDocument({ version: 2, blocks: [] })).toBeNull();
    expect(readStoredDocument({ blocks: 'nope' })).toBeNull();
    expect(readStoredDocument({ version: 1, blocks: [] })).toEqual({ doc: { version: 1, blocks: [] }, dropped: 0, degraded: 0 });
  });

  it('still rejects the same document on writes', () => {
    const res = validateDocument(JSON.parse(legacyDraft()));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some(e => e.path === '$.blocks[1].provider')).toBe(true);
  });
});

describe('stored article documents (real SQLite)', () => {
  let d1: ReturnType<typeof createTestD1>;
  const warnings: string[] = [];
  const originalWarn = console.warn;

  beforeEach(() => {
    d1 = createTestD1();
    warnings.length = 0;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  });
  afterEach(() => { console.warn = originalWarn; });

  async function seed(slug: string, draftJson: string): Promise<number> {
    const rec = await createArticle(d1, { slug, title: 'Bài cũ', document: { version: 1, blocks: [{ id: 'p0', type: 'paragraph', text: 'Ban đầu' }] } });
    d1.raw.query('UPDATE article_editions SET draft_json = ? WHERE article_id = ?').run(draftJson, rec.id);
    return rec.revision;
  }

  async function expectAppError(p: Promise<unknown>, status: number, code: string): Promise<void> {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      if (err instanceof AppError) {
        expect(err.status).toBe(status);
        expect(err.code).toBe(code);
      }
      return;
    }
    throw new Error(`expected ${code}`);
  }

  it('reads a partly invalid draft block by block and warns without content', async () => {
    await seed('legacy', legacyDraft());
    const rec = await getArticle(d1, 'legacy');
    expect(rec?.draft.blocks.map(b => b.id)).toEqual(['p1', 'e1', 't1']);
    expect(rec?.draft.blocks[1]).toMatchObject({ type: 'embed', provider: 'generic' });
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join('\n')).not.toContain(SECRET);
    expect(warnings.join('\n')).not.toContain(YT);
  });

  it('a metadata-only update keeps the stored draft byte for byte', async () => {
    const revision = await seed('legacy', legacyDraft());
    const updated = await updateArticle(d1, 'legacy', { title: 'Tên mới' }, revision);
    expect(updated.title).toBe('Tên mới');
    const row = d1.raw.query('SELECT draft_json FROM article_editions WHERE article_id = ?').get(updated.id);
    expect(row).toEqual({ draft_json: legacyDraft() });
    // The revision snapshot is the stored JSON too, so history is not rewritten by the read fallback.
    const snap = d1.raw.query("SELECT document_json FROM article_revisions WHERE article_id = ? AND action = 'save'").get(updated.id);
    expect(snap).toEqual({ document_json: legacyDraft() });
  });

  it('publishes a recovered draft and readers get the recovered blocks', async () => {
    const revision = await seed('legacy', legacyDraft());
    const published = await publishArticle(d1, 'legacy', revision, true);
    expect(published.published?.blocks.map(b => b.id)).toEqual(['p1', 'e1', 't1']);
    expect(published.published?.blocks[1]).toMatchObject({ provider: 'generic' });
  });

  it('refuses to update or publish from an unreadable draft instead of saving it empty', async () => {
    for (const bad of ['{not json', JSON.stringify({ version: 1, blocks: [{ id: 'z', type: 'unknown' }] })]) {
      const slug = bad.startsWith('{not') ? 'broken-json' : 'all-invalid';
      const revision = await seed(slug, bad);
      expect((await getArticle(d1, slug))?.draft.blocks).toEqual([]);

      await expectAppError(updateArticle(d1, slug, { title: 'Ghi đè' }, revision), 409, 'stored_document_unreadable');
      await expectAppError(publishArticle(d1, slug, revision, true), 409, 'stored_document_unreadable');
      // Nothing changed: same revision, same stored bytes, nothing published.
      const row = d1.raw.query('SELECT e.draft_json, e.published_json, a.revision FROM article_editions e JOIN articles a ON a.id = e.article_id WHERE a.slug = ?').get(slug);
      expect(row).toEqual({ draft_json: bad, published_json: null, revision });

      // Sending a complete document replaces the unreadable draft.
      const fixed = await updateArticle(d1, slug, { document: { version: 1, blocks: [{ id: 'n1', type: 'paragraph', text: 'Mới' }] } }, revision);
      expect(fixed.draft.blocks).toEqual([{ id: 'n1', type: 'paragraph', text: 'Mới' }]);
    }
  });

  it('reads stored revisions leniently', async () => {
    const rec = await createArticle(d1, { slug: 'history', title: 'Lịch sử' });
    d1.raw.query('UPDATE article_revisions SET document_json = ? WHERE article_id = ?').run(legacyDraft(), rec.id);
    const [entry] = await listRevisions(d1, 'history');
    const doc = await getRevisionDocument(d1, 'history', entry.locale, entry.revision);
    expect(doc?.document.blocks.map(b => b.id)).toEqual(['p1', 'e1', 't1']);
    expect(doc?.document.blocks[1]).toMatchObject({ provider: 'generic' });
  });
});
