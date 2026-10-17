import { describe, it, expect } from 'bun:test';
import { createTestD1 } from './helpers/d1';
import { createSession } from '../src/db/store';
import { createArticle, deleteArticle, deleteEdition, publishArticle, updateArticle } from '../src/lib/blocks/articles';
import type { ArticleInput } from '../src/lib/blocks/articles';
import type { ArticleDocument } from '../src/lib/blocks/schema';
import { createCategory } from '../src/lib/taxonomy/categories';
import { decodeCursor, encodeCursor, feedImage } from '../src/lib/feeds/json-feed';
import type { JsonFeed } from '../src/lib/feeds/json-feed';
import { GET as feedRoute } from '../src/pages/feed.json';
import type { APIRoute } from 'astro';

type Db = ReturnType<typeof createTestD1>;

const doc = (text: string): ArticleDocument => ({ version: 1, blocks: [{ id: 'p1', type: 'paragraph', text }] });

async function get(d1: Db | undefined, qs = '', headers: Record<string, string> = {}): Promise<Response> {
  const request = new Request(`https://zuey.test/feed.json${qs}`, { headers });
  const context = { request, params: {}, url: new URL(request.url), locals: { runtime: { env: d1 ? { DB: d1 } : {} } } };
  return (feedRoute as APIRoute)(context as unknown as Parameters<APIRoute>[0]);
}

async function feedOf(d1: Db, qs = ''): Promise<JsonFeed> {
  const res = await get(d1, qs);
  expect(res.status).toBe(200);
  return (await res.json()) as JsonFeed;
}

async function publish(d1: Db, input: ArticleInput & { publishedAt?: string }): Promise<{ slug: string; revision: number; id: string }> {
  const { publishedAt, ...rest } = input;
  const rec = await createArticle(d1, { document: doc(`Body of ${input.slug}`), ...rest });
  const out = await publishArticle(d1, rec.slug, rec.revision, true, { locale: input.locale, publishedAt });
  return { slug: out.slug, revision: out.revision, id: out.id };
}

describe('GET /feed.json basics', () => {
  it('serves an empty but valid JSON Feed 1.1 with the feed+json content type', async () => {
    const d1 = createTestD1();
    const res = await get(d1);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/feed+json; charset=utf-8');
    expect(res.headers.get('cache-control')).toContain('public');
    const feed = (await res.json()) as JsonFeed;
    expect(feed.version).toBe('https://jsonfeed.org/version/1.1');
    expect(feed.items).toEqual([]);
    expect(feed.next_url).toBeUndefined();
    expect(feed.feed_url).toBe('https://zuey.test/feed.json');
    expect(feed.language).toBe('vi');
    expect(feed.authors[0].name).toBe('Duy Nguyen');
  });

  it('answers 503, not an empty feed, when D1 is missing', async () => {
    const res = await get(undefined);
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('db_unavailable');
  });

  it('rejects invalid parameters with a 400', async () => {
    const d1 = createTestD1();
    for (const qs of ['?lang=xx', '?limit=0', '?limit=101', '?limit=abc', '?limit=1.5', '?access=paid', '?cursor=not-a-cursor', `?cursor=${encodeCursor({ publishedAt: 'x', articleId: 'y' })}`]) {
      const res = await get(d1, qs);
      expect([qs, res.status]).toEqual([qs, 400]);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('round-trips cursors', () => {
    const c = { publishedAt: '2026-01-02T03:04:05.678Z', articleId: 'art_abc123' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
});

describe('items', () => {
  it('describe each edition with stable ids, canonical urls, summary only and public metadata', async () => {
    const d1 = createTestD1();
    await createCategory(d1, { slug: 'ai', names: { vi: 'Trí tuệ nhân tạo', en: 'AI' } }, 'test');
    const a = await publish(d1, {
      slug: 'hello-feed', title: 'Hello "feed" <b>', excerpt: 'Public excerpt', tags: ['Agents'], category: 'ai',
      publishedAt: '2026-03-01T00:00:00.000Z',
    });
    const feed = await feedOf(d1);
    expect(feed.items).toHaveLength(1);
    const item = feed.items[0];
    expect(item.id).toBe(`urn:zuey:article:${a.id}:vi`);
    expect(item.url).toBe('https://zuey.test/articles/hello-feed?lang=vi');
    expect(item.title).toBe('Hello "feed" <b>');
    expect(item.summary).toBe('Public excerpt');
    expect(item.content_text).toBe('Public excerpt');
    expect(item.language).toBe('vi');
    expect(item.date_published).toBe('2026-03-01T00:00:00.000Z');
    expect(item.tags).toEqual(['Agents']);
    expect(item.image).toBe('https://zuey.test/og.png');
    expect(item._zuey).toMatchObject({
      access: 'free', category: { slug: 'ai', name: 'Trí tuệ nhân tạo' }, content_mode: 'summary', available_locales: ['vi'],
      markdown_url: 'https://zuey.test/articles/hello-feed.md?lang=vi',
    });
    expect(JSON.stringify(feed)).not.toContain('Body of hello-feed');
  });

  it('falls back to the title when the excerpt is empty so content_text is never blank', async () => {
    const d1 = createTestD1();
    await publish(d1, { slug: 'no-excerpt', title: 'Only a title', excerpt: '' });
    const [item] = (await feedOf(d1)).items;
    expect(item.content_text).toBe('Only a title');
  });

  it('keeps the id when the slug changes and points url at the new slug', async () => {
    const d1 = createTestD1();
    const a = await publish(d1, { slug: 'old-slug', title: 'T', excerpt: 'E' });
    const before = (await feedOf(d1)).items[0];
    await updateArticle(d1, 'old-slug', { slug: 'new-slug' }, a.revision);
    const after = (await feedOf(d1)).items[0];
    expect(after.id).toBe(before.id);
    expect(after.url).toBe('https://zuey.test/articles/new-slug?lang=vi');
  });
});

describe('published snapshot', () => {
  it('ignores draft saves and shows the new snapshot only after an explicit republish', async () => {
    const d1 = createTestD1();
    const a = await publish(d1, { slug: 'snap', title: 'Published title', excerpt: 'Published excerpt', publishedAt: '2026-01-01T00:00:00.000Z' });
    const first = (await feedOf(d1)).items[0];
    expect(first.date_published).toBe('2026-01-01T00:00:00.000Z');

    const saved = await updateArticle(d1, 'snap', { title: 'Draft title', excerpt: 'Draft excerpt', document: doc('draft body') }, a.revision);
    const duringDraft = (await feedOf(d1)).items[0];
    expect(duringDraft.title).toBe('Published title');
    expect(duringDraft.summary).toBe('Published excerpt');
    expect(duringDraft.date_modified).toBe(first.date_modified);
    expect(JSON.stringify(duringDraft)).not.toContain('Draft');

    await new Promise(r => setTimeout(r, 5));
    await publishArticle(d1, 'snap', saved.revision, true);
    const after = (await feedOf(d1)).items[0];
    expect(after.title).toBe('Draft title');
    expect(after.summary).toBe('Draft excerpt');
    expect(after.date_published).toBe('2026-01-01T00:00:00.000Z');
    expect(after.date_modified > first.date_modified).toBe(true);
  });

  it('never lists drafts, never-published editions, scheduled posts or deleted content', async () => {
    const d1 = createTestD1();
    await createArticle(d1, { slug: 'only-draft', title: 'Draft', document: doc('x') });
    await publish(d1, { slug: 'visible', title: 'Visible' });
    await publish(d1, { slug: 'future', title: 'Future' });
    d1.raw.query("UPDATE article_editions SET published_at = '2999-01-01T00:00:00.000Z' WHERE article_id = (SELECT id FROM articles WHERE slug = 'future')").run();
    await publish(d1, { slug: 'gone', title: 'Gone' });
    await deleteArticle(d1, 'gone');
    expect((await feedOf(d1)).items.map(i => i.title)).toEqual(['Visible']);
  });

  it('backfills snapshot columns for editions published before they existed', () => {
    const d1 = createTestD1();
    // Simulates a pre-migration row: published, but the snapshot columns are NULL.
    d1.raw.query(`INSERT INTO articles (id, slug, locale, title, excerpt, draft_json, published_json, created_at, updated_at, published_at, status)
      VALUES ('art_legacy', 'legacy', 'vi', 'Live title', 'Live excerpt', '{}', '{}', 'c', 'u', '2026-01-01T00:00:00.000Z', 'published')`).run();
    d1.raw.query(`INSERT INTO article_editions (id, article_id, locale, title, excerpt, draft_json, published_json, created_at, updated_at, published_at, status)
      VALUES ('ed_legacy', 'art_legacy', 'vi', 'Live title', 'Live excerpt', '{}', '{}', 'c', 'u', '2026-01-01T00:00:00.000Z', 'published')`).run();
    return feedOf(d1).then(feed => {
      expect(feed.items[0].title).toBe('Live title');
      expect(feed.items[0].date_modified).toBe('2026-01-01T00:00:00.000Z');
    });
  });
});

describe('locale', () => {
  it('returns exactly the requested published locale and never falls back', async () => {
    const d1 = createTestD1();
    await publish(d1, { slug: 'vi-only', title: 'Chỉ tiếng Việt' });
    const bi = await publish(d1, { slug: 'bilingual', title: 'Song ngữ' });
    const upd = await updateArticle(d1, 'bilingual', { locale: 'en', title: 'Bilingual', excerpt: 'English excerpt', document: doc('en body') }, bi.revision);
    const published = await publishArticle(d1, 'bilingual', upd.revision, true, { locale: 'en' });

    expect((await feedOf(d1)).items.map(i => i.title).sort()).toEqual(['Chỉ tiếng Việt', 'Song ngữ']);
    const enFeed = await feedOf(d1, '?lang=en');
    expect(enFeed.language).toBe('en');
    expect(enFeed.items.map(i => i.title)).toEqual(['Bilingual']);
    expect(enFeed.items[0].url).toBe('https://zuey.test/articles/bilingual?lang=en');
    expect(enFeed.items[0]._zuey.available_locales).toEqual(['en', 'vi']);
    expect((await feedOf(d1, '?lang=ja')).items).toEqual([]);

    const afterDelete = await deleteEdition(d1, 'bilingual', 'en', published.revision);
    expect(afterDelete.available_locales).toEqual(['vi']);
    expect((await feedOf(d1, '?lang=en')).items).toEqual([]);
  });
});

describe('paid articles', () => {
  it('expose only the public excerpt and metadata, identically for anonymous and admin requests', async () => {
    const d1 = createTestD1();
    await publish(d1, {
      slug: 'premium', title: 'Premium piece', excerpt: 'Public teaser', access: 'knowledges',
      document: { version: 1, blocks: [{ id: 'p1', type: 'paragraph', text: 'Free intro' }, { id: 'h1', type: 'heading', level: 2, text: 'PREMIUM-HEADING-SECRET' }, { id: 'p2', type: 'paragraph', text: 'PREMIUM-BODY-SECRET' }] },
    });
    const admin = `zuey_session=${await createSession('admin@zuey.me', d1)}`;
    const anon = await get(d1);
    const authed = await get(d1, '', { cookie: admin, authorization: 'Bearer nope', 'accept-language': 'en' });
    const [a, b] = [await anon.text(), await authed.text()];
    expect(a).toBe(b);
    expect(anon.headers.get('etag')).toBe(authed.headers.get('etag'));
    expect(a).not.toContain('PREMIUM-');
    const [item] = (JSON.parse(a) as JsonFeed).items;
    expect(item._zuey.access).toBe('knowledges');
    expect(item.summary).toBe('Public teaser');
    expect((await feedOf(d1, '?access=free')).items).toEqual([]);
    expect((await feedOf(d1, '?access=knowledges')).items).toHaveLength(1);
  });
});

describe('filters', () => {
  it('filter by category and tag', async () => {
    const d1 = createTestD1();
    await createCategory(d1, { slug: 'ops', names: { vi: 'Vận hành' } }, 'test');
    await publish(d1, { slug: 'a', title: 'A', category: 'ops', tags: ['alpha'] });
    await publish(d1, { slug: 'b', title: 'B', tags: ['beta'] });
    expect((await feedOf(d1, '?category=ops')).items.map(i => i.title)).toEqual(['A']);
    expect((await feedOf(d1, '?tag=beta')).items.map(i => i.title)).toEqual(['B']);
    expect((await feedOf(d1, '?category=missing')).items).toEqual([]);
    const f = await feedOf(d1, '?category=ops&limit=5&access=free');
    expect(f.feed_url).toBe('https://zuey.test/feed.json?category=ops&access=free&limit=5');
  });
});

describe('pagination', () => {
  it('walks every published article past 500 rows via next_url without loss or duplicates', async () => {
    const d1 = createTestD1();
    const TOTAL = 523;
    const art = d1.raw.prepare(`INSERT INTO articles (id, slug, locale, title, excerpt, draft_json, published_json, created_at, updated_at, published_at, status)
      VALUES (?, ?, 'vi', ?, '', '{}', '{}', 'c', 'u', ?, 'published')`);
    const ed = d1.raw.prepare(`INSERT INTO article_editions (id, article_id, locale, title, excerpt, draft_json, published_json, created_at, updated_at, published_at, published_title, published_excerpt, published_modified_at, status)
      VALUES (?, ?, 'vi', ?, '', '{}', '{}', 'c', 'u', ?, ?, '', ?, 'published')`);
    d1.raw.transaction(() => {
      for (let i = 0; i < TOTAL; i++) {
        // Groups of 3 share a timestamp so the id tie-breaker is exercised.
        const at = new Date(Date.UTC(2025, 0, 1) + Math.floor(i / 3) * 60_000).toISOString();
        const id = `bulk${String(i).padStart(4, '0')}`;
        art.run(id, `s-${id}`, `T ${id}`, at);
        ed.run(`ed_${id}`, id, `T ${id}`, at, `T ${id}`, at);
      }
    })();

    const seen: string[] = [];
    let url: string | undefined = 'https://zuey.test/feed.json?limit=100';
    let pages = 0;
    while (url) {
      const res: Response = await get(d1, new URL(url).search);
      const feed = (await res.json()) as JsonFeed;
      expect(feed.feed_url.startsWith('https://zuey.test/feed.json')).toBe(true);
      seen.push(...feed.items.map(i => i.id));
      url = feed.next_url;
      pages++;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(6);
    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
    const stamps = (await feedOf(d1, '?limit=100')).items.map(i => i.date_published);
    expect([...stamps].sort().reverse()).toEqual(stamps);
  });
});

describe('caching', () => {
  it('supports ETag and answers 304 to a matching If-None-Match', async () => {
    const d1 = createTestD1();
    await publish(d1, { slug: 'cached', title: 'Cached' });
    const first = await get(d1);
    const etag = first.headers.get('etag') ?? '';
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const hit = await get(d1, '', { 'if-none-match': etag });
    expect(hit.status).toBe(304);
    expect(await hit.text()).toBe('');
    expect(hit.headers.get('etag')).toBe(etag);
    expect((await get(d1, '', { 'if-none-match': `W/${etag}, "other"` })).status).toBe(304);
    expect((await get(d1, '', { 'if-none-match': '"stale"' })).status).toBe(200);
    await publish(d1, { slug: 'second', title: 'Second' });
    expect((await get(d1, '', { 'if-none-match': etag })).status).toBe(200);
  });
});

describe('feedImage', () => {
  it('accepts https and site paths, and otherwise uses the site card', () => {
    const o = 'https://zuey.me';
    expect(feedImage('https://media.zuey.me/a.png', o)).toBe('https://media.zuey.me/a.png');
    expect(feedImage('/img/a.png', o)).toBe('https://zuey.me/img/a.png');
    for (const bad of ['http://x.test/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'https://u:p@x.test/a.png', '', null, undefined]) {
      expect(feedImage(bad, o)).toBe('https://zuey.me/og.png');
    }
  });
});
