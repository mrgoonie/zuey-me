import { describe, it, expect } from 'bun:test';
import { createTestD1 } from './helpers/d1';
import { createArticle, getArticleView, publishArticle, updateArticle } from '../src/lib/blocks/articles';
import type { ArticleSummary } from '../src/lib/blocks/articles';
import { OG_TEMPLATE_VERSION, articleOgCard, articleOgHash, articleOgPath } from '../src/lib/og/article-og-card';
import type { ArticleOgCard } from '../src/lib/og/article-og-card';
import { articleOgText, titleFontSize } from '../src/lib/og/article-og-template';
import { ensureArticleOgImage, refreshArticleOgImages } from '../src/lib/og/article-og-service';
import { getStoredOgImage } from '../src/lib/og/article-og-store';

const ANON = { isAdmin: false, entitlements: [] };

function summary(over: Partial<ArticleSummary> = {}): ArticleSummary {
  return {
    id: 'art_1', slug: 'agents', locale: 'en', primary_locale: 'en', title: ' Agents of Chaos ', excerpt: 'Why it breaks.',
    tags: [], topic_tags: ['AI', 'Security', 'OpenClaw', 'Extra'].map((name, i) => ({ id: `t${i}`, slug: name.toLowerCase(), name })),
    category: null, labels: [], access: 'knowledges', status: 'published', revision: 2, label_revision: 0, published_revision: 2,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', published_at: '2026-10-01T00:00:00Z',
    has_unpublished_changes: false, available_locales: ['en'], reading_minutes: 9, cover_url: null,
    ...over,
  } as ArticleSummary;
}

/** Stub renderer: records which cards were drawn and returns bytes that identify the title. */
function stubRender() {
  const drawn: ArticleOgCard[] = [];
  return {
    drawn,
    render: async (card: ArticleOgCard) => {
      drawn.push(card);
      return new TextEncoder().encode(`png:${card.locale}:${card.title}`);
    },
  };
}

describe('article share card', () => {
  it('derives the drawn content from the reader-facing summary', () => {
    const card = articleOgCard(summary());
    expect(card.title).toBe('Agents of Chaos');
    expect(card.membersBadge).toBeTruthy();
    expect(card.tags).toEqual(['AI', 'Security', 'OpenClaw']);
    expect(card.readingTime).toBeTruthy();
    const free = articleOgCard(summary({ access: 'free', reading_minutes: 0 }));
    expect(free.membersBadge).toBeNull();
    expect(free.readingTime).toBeNull();
  });

  it('versions the image URL by content and template version', async () => {
    const a = await articleOgHash(articleOgCard(summary()));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await articleOgHash(articleOgCard(summary({ updated_at: '2027-01-01T00:00:00Z' })))).toBe(a);
    expect(await articleOgHash(articleOgCard(summary({ title: 'Other' })))).not.toBe(a);
    expect(OG_TEMPLATE_VERSION).toBeGreaterThan(0);
    expect(articleOgPath('agents', 'vi', a)).toBe(`/articles/agents/og.png?lang=vi&v=${a}`);
  });

  it('shrinks long titles, CJK sooner than Latin', () => {
    expect(titleFontSize('Short title')).toBe(76);
    expect(titleFontSize('x'.repeat(200))).toBe(40);
    expect(titleFontSize('研究者'.repeat(10))).toBeLessThan(titleFontSize('abc'.repeat(10)));
  });

  it('subsets bold text in both cases because pills are uppercased', () => {
    const text = articleOgText(articleOgCard(summary()));
    expect(text.serif).toBe('Agents of Chaos');
    expect(text.sansBold).toContain('#Security');
    expect(text.sansBold).toContain('#SECURITY');
  });
});

describe('article share image storage', () => {
  it('renders each published edition once and re-renders after an edit', async () => {
    const d1 = createTestD1();
    const created = await createArticle(d1, { slug: 'og-test', title: 'First title', excerpt: 'Lead', tags: ['AI'] });
    const published = await publishArticle(d1, 'og-test', created.revision, true);
    const { drawn, render } = stubRender();

    await refreshArticleOgImages(d1, published.id, 'og-test', render);
    expect(drawn.map(c => c.title)).toEqual(['First title']);
    const stored = await getStoredOgImage(d1, published.id, published.locale);
    expect(new TextDecoder().decode(stored?.png)).toBe(`png:${published.locale}:First title`);

    // Unchanged content: nothing is drawn again.
    await refreshArticleOgImages(d1, published.id, 'og-test', render);
    expect(drawn).toHaveLength(1);

    const updated = await updateArticle(d1, 'og-test', { title: 'Second title' }, published.revision);
    await refreshArticleOgImages(d1, updated.id, 'og-test', render);
    expect(drawn.map(c => c.title)).toEqual(['First title', 'Second title']);

    const view = await getArticleView(d1, 'og-test', ANON);
    if (!view) throw new Error('article should be readable');
    const served = await ensureArticleOgImage(d1, view, render);
    expect(new TextDecoder().decode(served.png)).toBe(`png:${published.locale}:Second title`);
    expect(served.hash).toBe(await articleOgHash(articleOgCard(view)));
    expect(drawn).toHaveLength(2);
  });

  it('draws missing images on request and drops images of unpublished articles', async () => {
    const d1 = createTestD1();
    const created = await createArticle(d1, { slug: 'og-lazy', title: 'Lazy', excerpt: '' });
    const published = await publishArticle(d1, 'og-lazy', created.revision, true);
    const { drawn, render } = stubRender();
    const view = await getArticleView(d1, 'og-lazy', ANON);
    if (!view) throw new Error('article should be readable');
    await ensureArticleOgImage(d1, view, render);
    expect(drawn).toHaveLength(1);

    // The slug no longer resolves to this article (deleted): its images are removed.
    await refreshArticleOgImages(d1, published.id, 'missing-slug', render);
    expect(await getStoredOgImage(d1, published.id, published.locale)).toBeNull();
  });
});
