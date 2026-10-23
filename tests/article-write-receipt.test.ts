import { describe, it, expect, beforeAll } from 'bun:test';
import type { APIRoute } from 'astro';
import { createTestD1 } from './helpers/d1';
import type { ArticleDocument } from '../src/lib/blocks/schema';
import { createArticle, publishArticle, submittedArticleFields, submittedPublishFields, toWriteReceipt, updateArticle } from '../src/lib/blocks/articles';
import type { ArticleInput, WriteReceipt } from '../src/lib/blocks/articles';
import { articlesMcpModule } from '../src/lib/blocks/mcp';
import type { McpContext } from '../src/lib/mcp/types';
import { createSession } from '../src/db/store';
import { createTag } from '../src/lib/taxonomy/tags';
import { POST as createApi } from '../src/pages/api/v1/articles/index';
import { POST as publishApi } from '../src/pages/api/v1/articles/[slug]/publish';
import { PUT as tagsApi } from '../src/pages/api/v1/articles/[slug]/tags';
import { DELETE as editionDeleteApi } from '../src/pages/api/v1/articles/[slug]/editions';
import { PUT as updateApi } from '../src/pages/api/v1/articles/[slug]';

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
    const receipt = toWriteReceipt(rec, 'update', submittedArticleFields(input));
    expect(receipt).toEqual({
      operation_success: true,
      operation: 'update',
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

  it('asks to publish after a metadata-only save of a never-published draft', async () => {
    const d1 = createTestD1();
    const created = await createArticle(d1, { slug: 'post', title: 'Bài viết', document: doc('v1') });
    const input: ArticleInput = { excerpt: 'tóm tắt' };
    const rec = await updateArticle(d1, 'post', input, created.revision);
    const receipt = toWriteReceipt(rec, 'update', submittedArticleFields(input));
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
    const receipt = toWriteReceipt(rec, 'update', submittedArticleFields(input));
    expect(receipt.has_unpublished_changes).toBe(false);
    expect(receipt.next_action).toBe('none');
  });

  it('lists only the publish fields a request carried', () => {
    expect(submittedPublishFields({ expected_revision: 2, confirm: true, notify: false })).toEqual(['notify']);
    expect(submittedPublishFields({ published_at: '2026-01-01', notify: true })).toEqual(['published_at', 'notify']);
    // The parser treats an empty or null published_at as absent.
    expect(submittedPublishFields({ published_at: null })).toEqual([]);
    expect(submittedPublishFields({ published_at: '' })).toEqual([]);
  });
});

// Every writer states what it did and what readers see, so an unchanged `status: "published"` is never
// mistaken for a failed save of a newer draft.
describe('receipts on every article writer (MCP)', () => {
  const d1 = createTestD1();
  const ctx: McpContext = {
    request: new Request('https://zuey.test/api/mcp'),
    env: {},
    d1,
    requireAdmin: async () => {},
    isAdmin: async () => true,
  };
  interface Receipted { status: string; revision: number; locale: string; receipt: WriteReceipt }
  const call = async (name: string, args: Record<string, unknown>) => (await articlesMcpModule.call(name, args, ctx)) as Receipted;

  it('covers create, publish, update, tags_set and a non-primary edition delete', async () => {
    await createTag(d1, { slug: 'ai', names: { vi: 'AI' } }, 'admin');
    const created = await call('article_create', { slug: 'receipt-i18n', title: 'Xin chào', document: doc('vi'), response_mode: 'summary' });
    expect(created.receipt).toEqual({
      operation_success: true, operation: 'create', locale: 'vi', article_revision: 1, edition_draft_revision: 1,
      published_revision: null, has_unpublished_changes: true, submitted_fields: ['slug', 'title', 'document'], next_action: 'publish',
    });

    const pub = await call('article_publish', { slug: 'receipt-i18n', expected_revision: created.revision, confirm: true, notify: false, summary_only: true });
    expect(pub.receipt).toEqual({
      operation_success: true, operation: 'publish', locale: 'vi', article_revision: 2, edition_draft_revision: 2,
      published_revision: 2, has_unpublished_changes: false, submitted_fields: ['notify'], next_action: 'none',
    });

    const en = await call('article_update', { slug: 'receipt-i18n', locale: 'en', title: 'Hello', document: doc('en'), expected_revision: pub.revision });
    expect(en.receipt).toMatchObject({ operation: 'update', locale: 'en', published_revision: null, has_unpublished_changes: true, next_action: 'publish' });
    const enPub = await call('article_publish', { slug: 'receipt-i18n', locale: 'en', expected_revision: en.revision, confirm: true, notify: false });
    expect(enPub.receipt).toMatchObject({ operation: 'publish', locale: 'en', published_revision: enPub.revision, has_unpublished_changes: false, next_action: 'none' });

    const tags = await call('article_tags_set', { slug: 'receipt-i18n', tags: ['ai'], expected_revision: enPub.revision });
    expect(tags.receipt).toEqual({
      operation_success: true, operation: 'tags_set', locale: 'vi', article_revision: enPub.revision + 1,
      // Tags are article-wide: the primary edition itself did not change.
      edition_draft_revision: 2, published_revision: 2, has_unpublished_changes: false, submitted_fields: ['tags'], next_action: 'none',
    });

    const del = await call('article_edition_delete', { slug: 'receipt-i18n', locale: 'en', expected_revision: tags.revision });
    expect(del.locale).toBe('vi');
    expect(del.receipt).toEqual({
      operation_success: true, operation: 'edition_delete', locale: 'en', article_revision: tags.revision + 1, edition_draft_revision: tags.revision + 1,
      published_revision: null, has_unpublished_changes: false, submitted_fields: [], next_action: 'none',
    });
  });

  it('keeps stale revisions machine-readable', async () => {
    const created = await call('article_create', { slug: 'receipt-stale', title: 'Stale', document: doc('vi') });
    await call('article_update', { slug: 'receipt-stale', excerpt: 'newer', expected_revision: created.revision });
    const err = await call('article_tags_set', { slug: 'receipt-stale', tags: [], expected_revision: created.revision }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: 'revision_conflict' });
  });
});

describe('receipts on every article writer (REST)', () => {
  const d1 = createTestD1();
  let cookie = '';
  beforeAll(async () => { cookie = `zuey_session=${await createSession('admin@zuey.me', d1)}`; });

  async function rest(handler: APIRoute, method: string, path: string, slug: string | undefined, body: unknown) {
    const request = new Request(`https://zuey.test/api/v1/articles${path}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const ctx = { request, params: { slug }, url: new URL(request.url), locals: { runtime: { env: { DB: d1 } } } };
    // The handlers only read request/params/locals; a full APIContext is not constructible in tests.
    const res = await handler(ctx as unknown as Parameters<APIRoute>[0]);
    return { status: res.status, data: (await res.json() as { data: { revision: number; receipt: WriteReceipt } }).data };
  }

  it('returns the receipt from POST, PUT, publish, tags and edition DELETE', async () => {
    const created = await rest(createApi, 'POST', '', undefined, { slug: 'rest-receipt', title: 'REST', document: doc('vi') });
    expect(created.status).toBe(201);
    expect(created.data.receipt).toMatchObject({ operation: 'create', locale: 'vi', article_revision: 1, next_action: 'publish' });

    const pub = await rest(publishApi, 'POST', '/rest-receipt/publish', 'rest-receipt', { expected_revision: 1, confirm: true, notify: false, response_mode: 'summary' });
    expect(pub.status).toBe(200);
    expect(pub.data.receipt).toMatchObject({ operation: 'publish', published_revision: 2, has_unpublished_changes: false, submitted_fields: ['notify'], next_action: 'none' });

    const en = await rest(updateApi, 'PUT', '/rest-receipt', 'rest-receipt', { locale: 'en', title: 'EN', document: doc('en'), expected_revision: 2 });
    expect(en.data.receipt).toMatchObject({ operation: 'update', locale: 'en' });

    const tags = await rest(tagsApi, 'PUT', '/rest-receipt/tags', 'rest-receipt', { tags: [], expected_revision: 3 });
    expect(tags.status).toBe(200);
    expect(tags.data.receipt).toMatchObject({ operation: 'tags_set', article_revision: 4, submitted_fields: ['tags'] });

    const del = await rest(editionDeleteApi, 'DELETE', '/rest-receipt/editions', 'rest-receipt', { locale: 'en', expected_revision: 4 });
    expect(del.status).toBe(200);
    expect(del.data.receipt).toMatchObject({ operation: 'edition_delete', locale: 'en', article_revision: 5, published_revision: null, next_action: 'none' });
  });
});
