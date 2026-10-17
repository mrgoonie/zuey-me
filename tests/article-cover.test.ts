import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createApiKey } from '../src/db/store';
import type { R2BucketLike, RuntimeEnv } from '../src/env';
import { createArticle, getArticle, getArticleView, publishArticle, updateArticle } from '../src/lib/blocks/articles';
import type { ArticleDocument } from '../src/lib/blocks/schema';
import { articleJsonLd } from '../src/lib/blocks/seo';
import { sniffImage } from '../src/lib/media/image-sniff';
import { sha256Hex } from '../src/lib/media/media-asset-store';
import { membersRuntime } from '../src/lib/members/runtime';
import { POST as mcpApi } from '../src/pages/api/mcp';
import { PUT as coverApi } from '../src/pages/api/v1/articles/[slug]/cover';
import { POST as reconcileApi } from '../src/pages/api/v1/admin/media/reconcile';

const ORIGIN = 'https://zuey.test';
const T0 = Date.parse('2026-10-17T07:00:00.000Z');
const ANON = { isAdmin: false, entitlements: [] };

type TestDb = ReturnType<typeof createTestD1>;
let d1: TestDb;
let bucket: FakeBucket;
let adminKey: string;
let readKey: string;
const originalNow = membersRuntime.now;

interface StoredObject { bytes: Uint8Array<ArrayBuffer>; contentType?: string; cacheControl?: string }

class FakeBucket implements R2BucketLike {
  objects = new Map<string, StoredObject>();
  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    const { bytes } = object;
    return {
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      size: bytes.length,
      httpMetadata: { contentType: object.contentType },
      arrayBuffer: async () => bytes.buffer,
    };
  }
  async put(key: string, value: ReadableStream | ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }) {
    const bytes = value instanceof Uint8Array ? Uint8Array.from(value) : new Uint8Array();
    this.objects.set(key, { bytes, ...options?.httpMetadata });
    return {};
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field(v: unknown, ...keys: string[]): unknown {
  let cur: unknown = v;
  for (const k of keys) cur = isRecord(cur) ? cur[k] : undefined;
  return cur;
}

const pad = (n: number) => new Array<number>(n).fill(0);
const ascii = (s: string) => Array.from(s, c => c.charCodeAt(0));
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];

/** A VP8X WebP header carrying the given pixel size; `salt` makes the bytes (and hash) differ. */
function webp(width: number, height: number, salt = 0): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([...ascii('RIFF'), ...pad(4), ...ascii('WEBP'), ...ascii('VP8X'), 10, 0, 0, 0, ...pad(4), ...le24(width - 1), ...le24(height - 1), salt, ...pad(8)]);
}

const COVER = webp(1672, 941);

const env = (extra: Partial<RuntimeEnv> = {}): RuntimeEnv => ({ DB: d1, MEDIA: bucket, PUBLIC_SITE_URL: ORIGIN, ...extra });

async function mcpCall(key: string | null, name: string, args: Record<string, unknown>) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (key) headers.set('Authorization', `Bearer ${key}`);
  const request = new Request(`${ORIGIN}/api/mcp`, {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = await mcpApi({ request, url: new URL(request.url), params: {}, locals: { runtime: { env: env() } } } as unknown as APIContext);
  const body: unknown = await res.json();
  const content = field(body, 'result', 'content');
  const text = field(Array.isArray(content) ? content[0] : undefined, 'text');
  return { status: res.status, result: typeof text === 'string' ? JSON.parse(text) as unknown : null, code: field(body, 'error', 'data', 'code') };
}

function doc(text: string, image?: string): ArticleDocument {
  return { version: 1, blocks: [{ id: 'p1', type: 'paragraph', text }, ...(image ? [{ id: 'i1', type: 'image' as const, url: image, alt: 'Ảnh trong bài' }] : [])] };
}

/** Puts `bytes` in the bucket under `key` like a hand-made R2 upload (no registry row) and returns its hash. */
async function putRaw(key: string, bytes: Uint8Array<ArrayBuffer>, contentType?: string): Promise<string> {
  bucket.objects.set(key, { bytes, contentType });
  return sha256Hex(bytes);
}

async function uploadCover(bytes = COVER): Promise<string> {
  const stored = await mcpCall(adminKey, 'media_upload', { data_base64: btoa(String.fromCharCode(...bytes)), alt: 'Ảnh bìa' });
  return String(field(stored.result, 'asset', 'id'));
}

/** Published vi + en article with a body image in vi; returns the article revision. */
async function seedArticle(): Promise<number> {
  const created = await createArticle(d1, { slug: 'post', title: 'Bài viết', document: doc('xin chào', 'https://media.zuey.me/articles/2026/10/body.png') });
  const en = await updateArticle(d1, 'post', { locale: 'en', title: 'Post', document: doc('hello') }, created.revision);
  const vi = await publishArticle(d1, 'post', en.revision, true, { locale: 'vi', notify: false });
  const both = await publishArticle(d1, 'post', vi.revision, true, { locale: 'en', notify: false });
  return both.revision;
}

beforeEach(async () => {
  d1 = createTestD1();
  bucket = new FakeBucket();
  membersRuntime.now = () => T0;
  adminKey = (await createApiKey('ops', 'admin', d1)).key;
  readKey = (await createApiKey('viewer', 'read', d1)).key;
});

afterEach(() => {
  membersRuntime.now = originalNow;
});

describe('media_reconcile', () => {
  it('reads a 1672x941 WebP header exactly', () => {
    expect(sniffImage(COVER)).toEqual({ mime: 'image/webp', ext: 'webp', width: 1672, height: 941 });
  });

  it('registers a pre-existing object after re-validating its bytes and records actor and origin', async () => {
    const key = 'articles/2026/10/cover-hand-made.webp';
    const sha256 = await putRaw(key, COVER);
    const res = await mcpCall(adminKey, 'media_reconcile', { object_key: key, sha256, width: 1672, height: 941, alt: 'Bìa' });
    expect(res.status).toBe(200);
    expect(field(res.result, 'created')).toBe(true);
    expect(field(res.result, 'asset')).toMatchObject({
      object_key: key, url: `https://media.zuey.me/${key}`, sha256, mime: 'image/webp', width: 1672, height: 941,
      origin: 'reconcile', created_by: 'admin-api-key', alt: 'Bìa',
    });
    expect(field(res.result, 'block')).toMatchObject({ type: 'image', width: 1672, height: 941 });
    // The object had no headers; identical bytes are rewritten with the detected type and immutable caching.
    expect(bucket.objects.get(key)).toMatchObject({ contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' });

    const again = await mcpCall(adminKey, 'media_reconcile', { object_key: key, sha256 });
    expect(field(again.result, 'created')).toBe(false);
    expect(field(again.result, 'asset', 'id')).toBe(field(res.result, 'asset', 'id'));
  });

  it('returns the already registered asset for the same bytes under another key and never duplicates a row', async () => {
    const id = await uploadCover();
    const sha256 = await putRaw('articles/2026/10/copy.webp', COVER);
    const res = await mcpCall(adminKey, 'media_reconcile', { object_key: 'articles/2026/10/copy.webp', sha256 });
    expect(field(res.result, 'created')).toBe(false);
    expect(field(res.result, 'duplicate_of')).toBe(id);
    const count = d1.raw.query('SELECT COUNT(*) AS n FROM media_assets').get();
    expect(field(count, 'n')).toBe(1);
  });

  it('rejects a wrong hash, wrong size, wrong extension, missing object and unsafe keys without writing rows', async () => {
    const key = 'articles/2026/10/c.webp';
    const sha256 = await putRaw(key, COVER);
    expect((await mcpCall(adminKey, 'media_reconcile', { object_key: key, sha256: 'a'.repeat(64) })).code).toBe('sha256_mismatch');
    expect((await mcpCall(adminKey, 'media_reconcile', { object_key: key, sha256, width: 1920, height: 1080 })).code).toBe('dimensions_mismatch');
    const wrongExt = await putRaw('articles/2026/10/c.png', COVER);
    expect((await mcpCall(adminKey, 'media_reconcile', { object_key: 'articles/2026/10/c.png', sha256: wrongExt })).code).toBe('extension_mismatch');
    expect((await mcpCall(adminKey, 'media_reconcile', { object_key: 'articles/2026/10/none.webp', sha256 })).code).toBe('object_not_found');
    const notImage = await putRaw('articles/2026/10/x.png', Uint8Array.from(ascii('<svg><script>alert(1)</script></svg>')));
    expect((await mcpCall(adminKey, 'media_reconcile', { object_key: 'articles/2026/10/x.png', sha256: notImage })).code).toBe('unsupported_media_type');
    for (const bad of ['courses/private.webp', 'articles/../secrets.webp', '/articles/a.webp', 'articles/a.svg', 'articles//a.webp', 'https://media.zuey.me/articles/a.webp']) {
      const res = await mcpCall(adminKey, 'media_reconcile', { object_key: bad, sha256 });
      expect([bad, res.code]).toEqual([bad, 'invalid_field']);
    }
    expect((await mcpCall(adminKey, 'media_reconcile', { object_key: key, sha256: 'xyz' })).code).toBe('invalid_field');
    expect(field(d1.raw.query('SELECT COUNT(*) AS n FROM media_assets').get(), 'n')).toBe(0);
  });

  it('refuses a key that is registered with different bytes', async () => {
    const key = 'articles/2026/10/c.webp';
    const sha256 = await putRaw(key, COVER);
    await mcpCall(adminKey, 'media_reconcile', { object_key: key, sha256 });
    const other = webp(1672, 941, 9);
    bucket.objects.set(key, { bytes: other });
    const res = await mcpCall(adminKey, 'media_reconcile', { object_key: key, sha256: await sha256Hex(other) });
    expect(res.code).toBe('object_key_conflict');
  });

  it('is admin-only on MCP and REST', async () => {
    const key = 'articles/2026/10/c.webp';
    const sha256 = await putRaw(key, COVER);
    expect((await mcpCall(null, 'media_reconcile', { object_key: key, sha256 })).status).toBe(401);
    expect((await mcpCall(readKey, 'media_reconcile', { object_key: key, sha256 })).status).toBe(403);
    const request = new Request(`${ORIGIN}/api/v1/admin/media/reconcile`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readKey}` }, body: JSON.stringify({ object_key: key, sha256 }),
    });
    const res = await reconcileApi({ request, url: new URL(request.url), params: {}, locals: { runtime: { env: env() } } } as unknown as APIContext);
    expect(res.status).toBe(403);
    expect(field(d1.raw.query('SELECT COUNT(*) AS n FROM media_assets').get(), 'n')).toBe(0);
  });
});

describe('article_cover_set', () => {
  it('sets one managed cover for every edition without touching bodies and with per-locale alt', async () => {
    const revision = await seedArticle();
    const before = await getArticle(d1, 'post');
    const assetId = await uploadCover();
    const res = await mcpCall(adminKey, 'article_cover_set', {
      slug: 'post', expected_revision: revision, asset_id: assetId, alt: 'Alt chung', alts: { vi: 'Ảnh bìa tiếng Việt' },
    });
    expect(res.status).toBe(200);
    const url = String(field(res.result, 'cover', 'url'));
    expect(field(res.result, 'cover')).toMatchObject({ asset_id: assetId, width: 1672, height: 941 });
    expect(field(res.result, 'revision')).toBe(revision + 1);
    expect(field(res.result, 'social_preview')).toEqual({ mode: 'generated_card', asset_id: null, image_url: null });
    expect(field(res.result, 'editions')).toEqual([
      { locale: 'en', published: true, cover_url: url, cover_alt: 'Alt chung' },
      { locale: 'vi', published: true, cover_url: url, cover_alt: 'Ảnh bìa tiếng Việt' },
    ]);
    // Receipt only: no document is echoed.
    expect(JSON.stringify(res.result)).not.toContain('xin chào');

    const vi = await getArticleView(d1, 'post', ANON, { locale: 'vi' });
    const en = await getArticleView(d1, 'post', ANON, { locale: 'en' });
    expect([vi?.cover_url, en?.cover_url]).toEqual([url, url]);
    expect([vi?.cover_asset_id, en?.cover_asset_id]).toEqual([assetId, assetId]);
    expect([vi?.cover_alt, en?.cover_alt]).toEqual(['Ảnh bìa tiếng Việt', 'Alt chung']);
    // Bodies and publication state are untouched.
    const after = await getArticle(d1, 'post');
    expect(after?.draft).toEqual(before?.draft);
    expect(after?.has_unpublished_changes).toBe(false);
    expect(after?.published_revision).toBe(before?.published_revision);
  });

  it('keeps the first body image as cover until a cover is set, and returns to it when the cover is cleared', async () => {
    const revision = await seedArticle();
    expect((await getArticleView(d1, 'post', ANON, { locale: 'vi' }))?.cover_url).toBe('https://media.zuey.me/articles/2026/10/body.png');
    const assetId = await uploadCover();
    const set = await mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: revision, asset_id: assetId });
    const cleared = await mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: Number(field(set.result, 'revision')), asset_id: null });
    expect(field(cleared.result, 'cover')).toBeNull();
    const vi = await getArticleView(d1, 'post', ANON, { locale: 'vi' });
    const en = await getArticleView(d1, 'post', ANON, { locale: 'en' });
    expect([vi?.cover_url, vi?.cover_asset_id, vi?.cover_alt]).toEqual(['https://media.zuey.me/articles/2026/10/body.png', null, '']);
    expect([en?.cover_url, en?.cover_asset_id]).toEqual([null, null]);
  });

  it('applies the managed cover when a draft edition is published later, and a re-publish keeps it', async () => {
    const created = await createArticle(d1, { slug: 'late', title: 'Late', document: doc('x', 'https://media.zuey.me/articles/2026/10/body.png') });
    const assetId = await uploadCover();
    const set = await mcpCall(adminKey, 'article_cover_set', { slug: 'late', expected_revision: created.revision, asset_id: assetId });
    expect(field(set.result, 'editions')).toMatchObject([{ locale: 'vi', published: false, cover_url: null }]);
    const published = await publishArticle(d1, 'late', Number(field(set.result, 'revision')), true, { notify: false });
    expect(published.cover_url).toBe(String(field(set.result, 'cover', 'url')));
    const again = await publishArticle(d1, 'late', published.revision, true, { notify: false });
    expect(again.cover_url).toBe(published.cover_url);
  });

  it('resets alt text when the cover changes without a new alt', async () => {
    const revision = await seedArticle();
    const first = await uploadCover();
    const set = await mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: revision, asset_id: first, alt: 'Cũ' });
    const second = await uploadCover(webp(1672, 941, 3));
    const swapped = await mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: Number(field(set.result, 'revision')), asset_id: second });
    expect((await getArticleView(d1, 'post', ANON, { locale: 'vi' }))?.cover_alt).toBe('');
    // Alt-only edits keep the cover.
    await mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: Number(field(swapped.result, 'revision')), alts: { en: 'Mới' } });
    const en = await getArticleView(d1, 'post', ANON, { locale: 'en' });
    expect([en?.cover_asset_id, en?.cover_alt]).toEqual([second, 'Mới']);
  });

  it('rejects stale revisions, unknown assets and locales, and bad modes without changing anything', async () => {
    const revision = await seedArticle();
    const assetId = await uploadCover();
    const stale = await mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: revision - 1, asset_id: assetId });
    expect(stale.code).toBe('revision_conflict');
    expect((await mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: revision, asset_id: 'med_nope' })).code).toBe('media_not_found');
    expect((await mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: revision, asset_id: assetId, alts: { zz: 'x' } })).code).toBe('invalid_field');
    expect((await mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: revision, asset_id: assetId, alts: { ja: 'x' } })).code).toBe('invalid_field');
    expect((await mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: revision, social_preview: { mode: 'cover' } })).code).toBe('cover_required');
    expect((await mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: revision, social_preview: { mode: 'custom_asset' } })).code).toBe('invalid_field');
    expect((await mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: revision, social_preview: { mode: 'banner' } })).code).toBe('invalid_field');
    expect((await mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: revision })).code).toBe('invalid_field');
    expect((await mcpCall(adminKey, 'article_cover_set', { slug: 'missing', expected_revision: 1, asset_id: assetId })).code).toBe('not_found');
    const art = await getArticle(d1, 'post');
    expect([art?.revision, art?.cover_asset_id]).toEqual([revision, null]);
  });

  it('two concurrent cover updates at one revision: exactly one wins', async () => {
    const revision = await seedArticle();
    const a = await uploadCover();
    const b = await uploadCover(webp(1672, 941, 5));
    const [x, y] = await Promise.all([
      mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: revision, asset_id: a }),
      mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: revision, asset_id: b }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const art = await getArticle(d1, 'post');
    const winner = x.status === 200 ? a : b;
    expect(art?.cover_asset_id).toBe(winner);
    const views = [await getArticleView(d1, 'post', ANON, { locale: 'vi' }), await getArticleView(d1, 'post', ANON, { locale: 'en' })];
    expect(new Set(views.map(v => v?.cover_url)).size).toBe(1);
  });

  it('is admin-only on MCP and REST', async () => {
    const revision = await seedArticle();
    const assetId = await uploadCover();
    expect((await mcpCall(null, 'article_cover_set', { slug: 'post', expected_revision: revision, asset_id: assetId })).status).toBe(401);
    expect((await mcpCall(readKey, 'article_cover_set', { slug: 'post', expected_revision: revision, asset_id: assetId })).status).toBe(403);
    const request = new Request(`${ORIGIN}/api/v1/articles/post/cover`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readKey}` }, body: JSON.stringify({ expected_revision: revision, asset_id: assetId }),
    });
    const res = await coverApi({ request, url: new URL(request.url), params: { slug: 'post' }, locals: { runtime: { env: env() } } } as unknown as APIContext);
    expect(res.status).toBe(403);
    expect((await getArticle(d1, 'post'))?.cover_asset_id).toBeNull();
  });

  it('works over REST for an admin key', async () => {
    const revision = await seedArticle();
    const assetId = await uploadCover();
    const request = new Request(`${ORIGIN}/api/v1/articles/post/cover`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminKey}` },
      body: JSON.stringify({ expected_revision: revision, asset_id: assetId, social_preview: { mode: 'cover' } }),
    });
    const res = await coverApi({ request, url: new URL(request.url), params: { slug: 'post' }, locals: { runtime: { env: env() } } } as unknown as APIContext);
    expect(res.status).toBe(200);
    expect(field(await res.json(), 'data', 'social_preview', 'mode')).toBe('cover');
  });

  it('keeps the asset in use: media_delete is refused while it is a cover or social image', async () => {
    const revision = await seedArticle();
    const cover = await uploadCover();
    const custom = await uploadCover(webp(1200, 630, 2));
    await mcpCall(adminKey, 'article_cover_set', {
      slug: 'post', expected_revision: revision, asset_id: cover, social_preview: { mode: 'custom_asset', asset_id: custom },
    });
    expect((await mcpCall(adminKey, 'media_delete', { id: cover })).code).toBe('media_in_use');
    expect((await mcpCall(adminKey, 'media_delete', { id: custom })).code).toBe('media_in_use');
    const unused = await uploadCover(webp(640, 360, 4));
    expect((await mcpCall(adminKey, 'media_delete', { id: unused })).status).toBe(200);
  });
});

describe('social preview', () => {
  it('stores generated_card by default, and cover / custom_asset independently of the cover itself', async () => {
    const revision = await seedArticle();
    expect((await getArticle(d1, 'post'))?.social_preview).toEqual({ mode: 'generated_card', asset_id: null });
    const cover = await uploadCover();
    const card = await uploadCover(webp(1200, 630, 6));
    const asCover = await mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: revision, asset_id: cover, social_preview: { mode: 'cover' } });
    expect(field(asCover.result, 'social_preview')).toMatchObject({ mode: 'cover', image_url: field(asCover.result, 'cover', 'url') });

    const custom = await mcpCall(adminKey, 'article_cover_set', {
      slug: 'post', expected_revision: Number(field(asCover.result, 'revision')), social_preview: { mode: 'custom_asset', asset_id: card },
    });
    expect(field(custom.result, 'cover', 'asset_id')).toBe(cover);
    expect(field(custom.result, 'social_preview')).toMatchObject({ mode: 'custom_asset', asset_id: card });
    expect(field(custom.result, 'social_preview', 'image_url')).not.toBe(field(custom.result, 'cover', 'url'));

    const back = await mcpCall(adminKey, 'article_cover_set', {
      slug: 'post', expected_revision: Number(field(custom.result, 'revision')), social_preview: { mode: 'generated_card' },
    });
    expect(field(back.result, 'social_preview')).toEqual({ mode: 'generated_card', asset_id: null, image_url: null });
    expect((await getArticleView(d1, 'post', ANON))?.cover_asset_id).toBe(cover);
  });

  it('lists the chosen social image first in JSON-LD and leaves the default unchanged', async () => {
    await seedArticle();
    const view = await getArticleView(d1, 'post', ANON, { locale: 'vi' });
    if (!view) throw new Error('article missing');
    const card = `${ORIGIN}/articles/post/og.png?lang=vi&v=abc`;
    expect(articleJsonLd(view, ORIGIN, card).image).toEqual(['https://media.zuey.me/articles/2026/10/body.png']);
    expect(articleJsonLd({ ...view, cover_url: null }, ORIGIN, card).image).toEqual([card]);
    expect(articleJsonLd(view, ORIGIN, card, 'https://media.zuey.me/articles/2026/10/social.webp').image)
      .toEqual(['https://media.zuey.me/articles/2026/10/social.webp', 'https://media.zuey.me/articles/2026/10/body.png']);
    expect(articleJsonLd({ ...view, cover_url: 'https://media.zuey.me/c.webp' }, ORIGIN, card, 'https://media.zuey.me/c.webp').image).toEqual(['https://media.zuey.me/c.webp']);
  });
});

describe('article_cover_set guards', () => {
  it('refuses AVIF as a share image and alt text without a cover', async () => {
    const revision = await seedArticle();
    const avif = Uint8Array.from([0, 0, 0, 0x1c, ...ascii('ftyp'), ...ascii('avif'), ...pad(16), ...ascii('ispe'), ...pad(4), 0, 0, 7, 128, 0, 0, 4, 56]);
    const avifId = await uploadCover(avif);
    const pngLike = await uploadCover();
    expect((await mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: revision, asset_id: avifId, social_preview: { mode: 'cover' } })).code).toBe('unsupported_social_image');
    expect((await mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: revision, asset_id: pngLike, social_preview: { mode: 'custom_asset', asset_id: avifId } })).code).toBe('unsupported_social_image');
    expect((await mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: revision, alts: { vi: 'x' } })).code).toBe('cover_required');
    // An AVIF cover is fine while the share image stays the generated card.
    expect((await mcpCall(adminKey, 'article_cover_set', { slug: 'post', expected_revision: revision, asset_id: avifId })).status).toBe(200);
  });
});
