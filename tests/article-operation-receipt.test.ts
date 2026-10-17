import { describe, it, expect } from 'bun:test';
import { createTestD1 } from './helpers/d1';
import { articlesMcpModule } from '../src/lib/blocks/mcp';
import { buildReceipt, changedFields } from '../src/lib/blocks/receipt';
import type { McpContext } from '../src/lib/mcp/types';

// A writer call states what it did and what readers see, so an unchanged `status: "published"`
// is never mistaken for a failed save of a newer draft.

const d1 = createTestD1();
const ctx: McpContext = {
  request: new Request('https://zuey.me/api/mcp'),
  env: {},
  d1,
  requireAdmin: async () => {},
  isAdmin: async () => true,
};
const doc = (text: string) => ({ version: 1, blocks: [{ id: 'p1', type: 'paragraph', text }] });

interface Receipted { status: string; revision: number; receipt: ReturnType<typeof buildReceipt> }
const call = async (name: string, args: Record<string, unknown>) => (await articlesMcpModule.call(name, args, ctx)) as Receipted;

describe('operation receipts', () => {
  it('distinguishes a committed draft from the public edition', async () => {
    const created = await call('article_create', { slug: 'receipt-demo', title: 'Demo', document: doc('một') });
    expect(created.receipt).toMatchObject({ operation: 'create', public_status: 'unpublished', published_revision: null, next_action: 'article_publish to make this edition public' });

    const published = await call('article_publish', { slug: 'receipt-demo', expected_revision: created.revision, confirm: true, notify: false, summary_only: true });
    expect(published.receipt).toMatchObject({ operation: 'publish', public_status: 'published', has_unpublished_changes: false, next_action: 'none' });

    const updated = await call('article_update', { slug: 'receipt-demo', expected_revision: published.revision, document: doc('hai'), title: 'Demo 2' });
    expect(updated.status).toBe('published'); // legacy meaning is unchanged
    expect(updated.receipt).toMatchObject({
      operation_success: true, operation: 'update', article_revision: updated.revision, public_status: 'published',
      published_revision: published.receipt.published_revision, has_unpublished_changes: true, changed_fields: ['title', 'document'],
    });
    expect(updated.receipt.article_revision).toBeGreaterThan(published.revision);
    expect(updated.receipt.next_action).toContain('article_publish');
  });

  it('keeps stale revisions machine-readable', async () => {
    const rec = await call('article_update', { slug: 'receipt-demo', expected_revision: 99, title: 'x' }).catch((e: unknown) => e);
    expect(rec).toMatchObject({ status: 409, code: 'revision_conflict' });
  });

  it('describes the touched edition for non-primary updates, publishes and deletes', async () => {
    const base = await call('article_create', { slug: 'receipt-i18n', title: 'Xin chào', document: doc('vi') });
    const pub = await call('article_publish', { slug: 'receipt-i18n', expected_revision: base.revision, confirm: true, notify: false, summary_only: true });
    const en = await call('article_update', { slug: 'receipt-i18n', locale: 'en', title: 'Hello', document: doc('en'), expected_revision: pub.revision });
    expect(en.receipt).toMatchObject({ edition_locale: 'en', public_status: 'unpublished', published_revision: null, has_unpublished_changes: true, changed_fields: ['title', 'document'] });
    const enPub = await call('article_publish', { slug: 'receipt-i18n', locale: 'en', expected_revision: en.revision, confirm: true, notify: false, summary_only: true });
    expect(enPub.receipt).toMatchObject({ edition_locale: 'en', public_status: 'published', has_unpublished_changes: false, next_action: 'none' });
    const tags = await call('article_tags_set', { slug: 'receipt-i18n', tags: [], expected_revision: enPub.revision });
    expect(tags.receipt).toMatchObject({ operation: 'tags_set', changed_fields: ['tags'] });
    const del = await call('article_edition_delete', { slug: 'receipt-i18n', locale: 'en', expected_revision: tags.revision });
    expect(del.receipt).toMatchObject({ operation: 'edition_delete', edition_locale: 'en', public_status: 'unpublished', published_revision: null });
  });

  it('lists only the fields an update carried', () => {
    expect(changedFields({ title: 'a', document: undefined, tags: [], locale: 'en' })).toEqual(['title', 'tags']);
  });
});
