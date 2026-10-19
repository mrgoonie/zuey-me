import { describe, it, expect } from 'bun:test';
import { createTestD1 } from './helpers/d1';
import type { ArticleDocument } from '../src/lib/blocks/schema';
import { createArticle, publishArticle, toWriteReceipt, updateArticle } from '../src/lib/blocks/articles';
import type { ArticleInput } from '../src/lib/blocks/articles';

function doc(text: string): ArticleDocument {
  return { version: 1, blocks: [{ id: 'p1', type: 'paragraph', text }] };
}

describe('toWriteReceipt', () => {
  it('separates the write outcome from the public status of a published article', async () => {
    const d1 = createTestD1();
    const created = await createArticle(d1, { slug: 'post', title: 'Bài viết', document: doc('v1') });
    const published = await publishArticle(d1, 'post', created.revision, true);
    const input: ArticleInput = { document: doc('v2'), title: 'Bài viết mới' };
    const rec = await updateArticle(d1, 'post', input, published.revision);

    expect(rec.status).toBe('published');
    const receipt = toWriteReceipt(rec, input);
    expect(receipt).toEqual({
      operation_success: true,
      locale: rec.locale,
      article_revision: rec.revision,
      edition_draft_revision: rec.revision,
      published_revision: published.published_revision,
      has_unpublished_changes: true,
      submitted_fields: ['title', 'document'],
      next_action: 'publish',
    });
    expect(receipt.article_revision).toBeGreaterThan(published.revision);
  });

  it('reports next_action none for a metadata-free draft article that matches nothing to publish', async () => {
    const d1 = createTestD1();
    const created = await createArticle(d1, { slug: 'post', title: 'Bài viết', document: doc('v1') });
    const input: ArticleInput = { excerpt: 'tóm tắt' };
    const rec = await updateArticle(d1, 'post', input, created.revision);
    const receipt = toWriteReceipt(rec, input);
    expect(receipt.submitted_fields).toEqual(['excerpt']);
    expect(receipt.published_revision).toBeNull();
    expect(receipt.next_action).toBe('publish');
  });

  it('asks for no further action when a metadata-only save leaves the published document in sync', async () => {
    const d1 = createTestD1();
    const created = await createArticle(d1, { slug: 'post', title: 'Bài viết', document: doc('v1') });
    const published = await publishArticle(d1, 'post', created.revision, true);
    const input: ArticleInput = { access: 'knowledges' };
    const rec = await updateArticle(d1, 'post', input, published.revision);
    const receipt = toWriteReceipt(rec, input);
    expect(receipt.has_unpublished_changes).toBe(false);
    expect(receipt.next_action).toBe('none');
  });
});
