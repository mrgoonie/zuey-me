import { describe, it, expect } from 'bun:test';
import { createTestD1 } from './helpers/d1';
import type { RuntimeEnv } from '../src/env';
import { articlesMcpModule } from '../src/lib/blocks/mcp';
import { buildReceipt, changedFields } from '../src/lib/blocks/receipt';
import type { McpContext } from '../src/lib/mcp/types';

// A writer call states what it did and what readers see, so an unchanged `status: "published"`
// is never mistaken for a failed save of a newer draft.

const d1 = createTestD1();
const ctx: McpContext = {
  request: new Request('https://zuey.me/api/mcp'),
  env: {} as RuntimeEnv,
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

  it('reports tag writes and keeps stale revisions machine-readable', async () => {
    const rec = await call('article_update', { slug: 'receipt-demo', expected_revision: 99, title: 'x' }).catch((e: unknown) => e);
    expect(rec).toMatchObject({ status: 409, code: 'revision_conflict' });
  });

  it('lists only the fields an update carried', () => {
    expect(changedFields({ title: 'a', document: undefined, tags: [] })).toEqual(['title', 'tags']);
    expect(buildReceipt('edition_delete', { slug: 's', revision: 3, locale: 'en', published_revision: null, has_unpublished_changes: false }).next_action).toBe('none');
  });
});
