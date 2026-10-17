import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import { createFakeR2 } from './helpers/r2';
import { createApiKey } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import type { ArticleDocument } from '../src/lib/blocks/schema';
import type { ArticleRecord } from '../src/lib/blocks/articles';
import { createArticle, getArticle, getArticleView, listArticles, publishArticle, setArticleCover, toSummary, updateArticle } from '../src/lib/blocks/articles';
import { articleShareImage } from '../src/lib/blocks/article-cover';
import { articleJsonLd } from '../src/lib/blocks/seo';
import { AppError } from '../src/lib/http';
import { deleteMediaAsset, storeImage } from '../src/lib/media/media-asset-store';
import type { ImageBytes } from '../src/lib/media/media-asset-store';
import { membersRuntime } from '../src/lib/members/runtime';
import { POST as mcpApi } from '../src/pages/api/mcp';
import { PUT as coverApi } from '../src/pages/api/v1/articles/[slug]/cover';

const ORIGIN = 'https://zuey.test';
const T0 = Date.parse('2026-10-17T07:00:00.000Z');
const SLUG = 'tui-dang-xay-cong-cu';
const ANONYMOUS = { isAdmin: false, entitlements: [] };

type TestDb = ReturnType<typeof createTestD1>;
let d1: TestDb;
let bucket: ReturnType<typeof createFakeR2>;
const originalNow = membersRuntime.now;

const env = (): RuntimeEnv => ({ DB: d1, MEDIA: bucket, PUBLIC_SITE_URL: ORIGIN });
const ctx = { env: env() };

/** A WebP header that declares exactly 1672×941 (the generated 16:9 image of the real session), padded like a file. */
function webp1672x941(salt = 0): ImageBytes {
  const ascii = (s: string) => Array.from(s, c => c.charCodeAt(0));
  const header = [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8X'), 10, 0, 0, 0, 0, 0, 0, 0, 0x87, 0x06, 0x00, 0xac, 0x03, 0x00];
  return Uint8Array.from([...header, ...new Array<number>(64).fill(salt)]);
}

function doc(text: string): ArticleDocument {
  return { version: 1, blocks: [{ id: 'p1', type: 'paragraph', text }] };
}

async function upload(salt = 0) {
  return (await storeImage(d1, env(), webp1672x941(salt), { alt: 'Generated 16:9', actor: 'test' })).asset;
}

/** Published article with a Vietnamese (primary) and an English edition. */
async function publishedBilingual(): Promise<ArticleRecord> {
  let rec = await createArticle(d1, { slug: SLUG, title: 'Tui đang xây công cụ', locale: 'vi', document: doc('Xin chào') }, ctx);
  rec = await updateArticle(d1, SLUG, { locale: 'en', title: 'I build tools', document: doc('Hello') }, rec.revision, ctx);
  rec = await publishArticle(d1, SLUG, rec.revision, true, { ...ctx, locale: 'vi', notify: false });
  return publishArticle(d1, SLUG, rec.revision, true, { ...ctx, locale: 'en', notify: false });
}

async function editionRows() {
  const { results } = await d1.prepare('SELECT locale, draft_json, published_json, revision, published_revision, cover_alt FROM article_editions ORDER BY locale').all();
  return results ?? [];
}

async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected an AppError');
}

beforeEach(() => {
  d1 = createTestD1();
  bucket = createFakeR2();
  membersRuntime.now = () => T0;
});

afterEach(() => {
  membersRuntime.now = originalNow;
});

describe('article cover', () => {
  it('shares one 1672×941 WebP across editions with per-locale alt and no document rewrite', async () => {
    const asset = await upload();
    expect([asset.width, asset.height, asset.mime]).toEqual([1672, 941, 'image/webp']);
    const published = await publishedBilingual();
    const before = await editionRows();

    const rec = await setArticleCover(d1, SLUG, { cover_asset_id: asset.id, alt: { vi: 'Ảnh bìa', en: 'Cover image' } }, published.revision);

    expect(rec.revision).toBe(published.revision + 1);
    expect(rec.cover).toEqual({ asset_id: asset.id, url: asset.url, width: 1672, height: 941, mime: 'image/webp', alt: 'Ảnh bìa' });
    expect(rec.cover_url).toBe(asset.url);
    expect((await getArticle(d1, SLUG, { locale: 'en' }))?.cover).toMatchObject({ asset_id: asset.id, alt: 'Cover image' });
    // Documents, publish state and edition revisions are byte-equal: only cover metadata changed.
    const after = await editionRows();
    expect(after.map(r => ({ ...r, cover_alt: '' }))).toEqual(before.map(r => ({ ...r, cover_alt: '' })));
    expect(after.map(r => r.cover_alt)).toEqual(['Cover image', 'Ảnh bìa']);
    expect(bucket.objects.size).toBe(1);
  });

  it('shows the managed cover in listings and public views, and falls back to the first body image otherwise', async () => {
    const asset = await upload();
    const published = await publishedBilingual();
    await setArticleCover(d1, SLUG, { cover_asset_id: asset.id }, published.revision);

    expect((await listArticles(d1, { locale: 'en' }))[0]?.cover_url).toBe(asset.url);
    expect((await listArticles(d1, { locale: 'vi' }))[0]?.cover?.asset_id).toBe(asset.id);
    const view = await getArticleView(d1, SLUG, ANONYMOUS, { locale: 'en' });
    expect(view?.cover?.alt).toBe('Generated 16:9');

    const other = await setArticleCover(d1, SLUG, { cover_asset_id: null }, published.revision + 1);
    expect(other.cover).toBeNull();
    expect(other.cover_url).toBeNull();
  });

  it('rejects a stale revision without writing anything', async () => {
    const asset = await upload();
    const published = await publishedBilingual();
    const err = await failure(setArticleCover(d1, SLUG, { cover_asset_id: asset.id, alt: 'x' }, published.revision - 1));
    expect([err.status, err.code, err.extra]).toEqual([409, 'revision_conflict', { current_revision: published.revision }]);
    const rec = await getArticle(d1, SLUG);
    expect(rec?.cover).toBeNull();
    expect(rec?.revision).toBe(published.revision);
    expect((await editionRows()).map(r => r.cover_alt)).toEqual(['', '']);
  });

  it('rolls the whole change back when a write fails', async () => {
    const asset = await upload();
    const published = await publishedBilingual();
    d1.raw.run("CREATE TRIGGER fail_cover BEFORE UPDATE OF cover_asset_id ON articles BEGIN SELECT RAISE(ABORT, 'boom'); END");
    await expect(setArticleCover(d1, SLUG, { cover_asset_id: asset.id, alt: 'x' }, published.revision)).rejects.toThrow('boom');
    expect((await editionRows()).map(r => r.cover_alt)).toEqual(['', '']);
    expect((await getArticle(d1, SLUG))?.revision).toBe(published.revision);
  });

  it('accepts only managed assets, known locales and well-formed fields', async () => {
    const asset = await upload();
    const published = await publishedBilingual();
    const rev = published.revision;
    const code = async (body: Record<string, unknown>) => (await failure(setArticleCover(d1, SLUG, body, rev))).code;

    expect(await code({ cover_asset_id: 'med_missing' })).toBe('media_not_found');
    expect(await code({ cover_asset_id: 'https://media.zuey.me/articles/2026/10/x.webp' })).toBe('media_not_found');
    expect(await code({ cover_asset_id: '' })).toBe('invalid_field');
    expect(await code({})).toBe('invalid_field');
    expect(await code({ cover_asset_id: asset.id, alt: { fr: 'x' } })).toBe('invalid_field');
    expect(await code({ cover_asset_id: asset.id, alt: { zh: 'x' } })).toBe('invalid_field');
    expect(await code({ cover_asset_id: asset.id, alt: { en: 3 } })).toBe('invalid_field');
    expect(await code({ cover_asset_id: asset.id, alt: 3 })).toBe('invalid_field');
    expect((await getArticle(d1, SLUG))?.revision).toBe(rev);
  });

  it('applies one alt string to every edition', async () => {
    const asset = await upload();
    const published = await publishedBilingual();
    await setArticleCover(d1, SLUG, { cover_asset_id: asset.id, alt: '  Chung  ' }, published.revision);
    expect((await editionRows()).map(r => r.cover_alt)).toEqual(['Chung', 'Chung']);
  });

  it('blocks deleting an asset while it is a cover or social image, then allows it', async () => {
    const cover = await upload(1);
    const custom = await upload(2);
    const published = await publishedBilingual();
    await setArticleCover(d1, SLUG, { cover_asset_id: cover.id, social_preview: { mode: 'custom_asset', asset_id: custom.id } }, published.revision);

    for (const id of [cover.id, custom.id]) {
      const err = await failure(deleteMediaAsset(d1, env(), id));
      expect([err.status, err.code, err.extra]).toEqual([409, 'media_in_use', { articles: [SLUG], lessons: [], courses: [] }]);
    }
    await setArticleCover(d1, SLUG, { cover_asset_id: null, social_preview: null }, published.revision + 1);
    expect((await deleteMediaAsset(d1, env(), cover.id)).deleted).toBe(true);
    expect((await deleteMediaAsset(d1, env(), custom.id)).deleted).toBe(true);
  });
});

describe('social preview', () => {
  const generated = `${ORIGIN}/articles/${SLUG}/og.png?lang=vi&v=abc`;

  async function setup() {
    const cover = await upload(1);
    const custom = await upload(2);
    const published = await publishedBilingual();
    return { cover, custom, rev: published.revision };
  }

  async function announced(locale: 'vi' | 'en') {
    const view = await getArticleView(d1, SLUG, ANONYMOUS, { locale });
    if (!view) throw new Error('article not public');
    const image = articleShareImage(view, generated);
    const jsonLd = articleJsonLd(view, ORIGIN, generated);
    return { image, jsonLdImage: jsonLd.image };
  }

  it('keeps the earlier behaviour until configured', async () => {
    const { cover, rev } = await setup();
    expect(await announced('vi')).toEqual({ image: { url: generated, type: 'image/png', width: 1200, height: 630, alt: 'Tui đang xây công cụ' }, jsonLdImage: [generated] });
    const rec = await setArticleCover(d1, SLUG, { cover_asset_id: cover.id }, rev);
    expect(rec.social_preview).toEqual({ mode: null, asset_id: null, image: null });
    // og:image stays the generated card; JSON-LD has always announced the cover.
    expect((await announced('vi')).image.url).toBe(generated);
    expect((await announced('vi')).jsonLdImage).toEqual([cover.url]);
  });

  it('generated_card keeps the card everywhere even with a cover', async () => {
    const { cover, rev } = await setup();
    await setArticleCover(d1, SLUG, { cover_asset_id: cover.id, social_preview: { mode: 'generated_card' } }, rev);
    const out = await announced('en');
    expect(out.image.url).toBe(generated);
    expect(out.jsonLdImage).toEqual([generated]);
  });

  it('cover mode announces the cover with its real type, size and per-locale alt', async () => {
    const { cover, rev } = await setup();
    const rec = await setArticleCover(d1, SLUG, { cover_asset_id: cover.id, alt: { vi: 'Bìa', en: 'Cover' }, social_preview: { mode: 'cover' } }, rev);
    expect(rec.social_preview).toMatchObject({ mode: 'cover', asset_id: null, image: { asset_id: cover.id } });
    expect(await announced('vi')).toEqual({ image: { url: cover.url, type: 'image/webp', width: 1672, height: 941, alt: 'Bìa' }, jsonLdImage: [cover.url] });
    expect((await announced('en')).image.alt).toBe('Cover');
  });

  it('custom_asset announces another asset independently of the cover', async () => {
    const { cover, custom, rev } = await setup();
    await setArticleCover(d1, SLUG, { cover_asset_id: cover.id, social_preview: { mode: 'custom_asset', asset_id: custom.id } }, rev);
    const out = await announced('vi');
    expect(out.image).toMatchObject({ url: custom.url, type: 'image/webp', width: 1672, height: 941 });
    expect(out.jsonLdImage).toEqual([custom.url]);
    expect((await getArticle(d1, SLUG))?.cover_url).toBe(cover.url);
  });

  it('refuses inconsistent settings and null restores the default', async () => {
    const { cover, custom, rev } = await setup();
    const code = async (body: Record<string, unknown>, revision = rev) => (await failure(setArticleCover(d1, SLUG, body, revision))).code;
    expect(await code({ social_preview: { mode: 'cover' } })).toBe('cover_required');
    expect(await code({ social_preview: { mode: 'custom_asset' } })).toBe('invalid_field');
    expect(await code({ social_preview: { mode: 'cover', asset_id: custom.id } })).toBe('invalid_field');
    expect(await code({ social_preview: { mode: 'nope' } })).toBe('invalid_field');
    expect(await code({ social_preview: 'cover' })).toBe('invalid_field');
    expect(await code({ social_preview: { mode: 'custom_asset', asset_id: 'med_missing' } })).toBe('media_not_found');

    const set = await setArticleCover(d1, SLUG, { cover_asset_id: cover.id, social_preview: { mode: 'cover' } }, rev);
    expect(await code({ cover_asset_id: null }, set.revision)).toBe('cover_required');
    const reset = await setArticleCover(d1, SLUG, { cover_asset_id: null, social_preview: null }, set.revision);
    expect(reset.social_preview.mode).toBeNull();
    expect(reset.cover).toBeNull();
  });
});

describe('article cover API', () => {
  async function mcp(key: string | null, name: string, args: Record<string, unknown>) {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (key) headers.set('Authorization', `Bearer ${key}`);
    const request = new Request(`${ORIGIN}/api/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const res = await mcpApi({ request, url: new URL(request.url), params: {}, locals: { runtime: { env: env() } } } as unknown as APIContext);
    return { status: res.status, body: await res.text() };
  }

  async function rest(key: string | null, body: unknown) {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (key) headers.set('Authorization', `Bearer ${key}`);
    const request = new Request(`${ORIGIN}/api/v1/articles/${SLUG}/cover`, { method: 'PUT', headers, body: JSON.stringify(body) });
    const res = await coverApi({ request, url: new URL(request.url), params: { slug: SLUG }, locals: { runtime: { env: env() } } } as unknown as APIContext);
    return { status: res.status, body: await res.json() as { data?: ReturnType<typeof toSummary>; error?: { code: string } } };
  }

  it('sets the cover over REST for admins only', async () => {
    const asset = await upload();
    const published = await publishedBilingual();
    const admin = (await createApiKey('ops', 'admin', d1)).key;
    const reader = (await createApiKey('viewer', 'read', d1)).key;

    expect((await rest(null, { expected_revision: published.revision, cover_asset_id: asset.id })).status).toBe(401);
    expect((await rest(reader, { expected_revision: published.revision, cover_asset_id: asset.id })).status).toBe(403);
    expect((await getArticle(d1, SLUG))?.cover).toBeNull();

    const ok = await rest(admin, { expected_revision: published.revision, cover_asset_id: asset.id, alt: 'Bìa', social_preview: { mode: 'cover' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ revision: published.revision + 1, cover: { asset_id: asset.id, alt: 'Bìa' }, social_preview: { mode: 'cover' } });

    const stale = await rest(admin, { expected_revision: published.revision, alt: 'x' });
    expect([stale.status, stale.body.error?.code]).toEqual([409, 'revision_conflict']);
  });

  it('exposes the MCP tool to admins only', async () => {
    const asset = await upload();
    const published = await publishedBilingual();
    const admin = (await createApiKey('ops', 'admin', d1)).key;
    const reader = (await createApiKey('viewer', 'read', d1)).key;
    const args = { slug: SLUG, expected_revision: published.revision, cover_asset_id: asset.id };

    expect((await mcp(reader, 'article_cover_set', args)).status).toBe(403);
    const ok = await mcp(admin, 'article_cover_set', args);
    expect(ok.status).toBe(200);
    expect(ok.body).toContain(asset.id);
    expect((await getArticle(d1, SLUG))?.cover?.asset_id).toBe(asset.id);
  });
});
