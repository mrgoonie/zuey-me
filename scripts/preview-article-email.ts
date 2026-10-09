/**
 * Renders the new-article email of a published article to HTML files for a visual check.
 * Usage: bun scripts/preview-article-email.ts <slug> <outDir> [siteUrl]
 * Reads the public article API (full text only for free articles), so the teaser is exact and "full" mirrors what
 * readers with read_full would see for free articles.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderArticleEmail, withFooter } from '../src/lib/notifications/article-email-render';
import type { ArticleDocument } from '../src/lib/blocks/schema';

const [slug, outDir, site = 'https://zuey.me'] = process.argv.slice(2);
if (!slug || !outDir) {
  console.error('Usage: bun scripts/preview-article-email.ts <slug> <outDir> [siteUrl]');
  process.exit(1);
}

const res = await fetch(`${site}/api/v1/articles/${encodeURIComponent(slug)}`);
const body = (await res.json()) as { data?: { title: string; excerpt: string; access: 'free' | 'knowledges'; cover_url: string | null; locale: string; document: ArticleDocument } };
if (!res.ok || !body.data) throw new Error(`Article ${slug} not readable: HTTP ${res.status}`);
const a = body.data;
mkdirSync(outDir, { recursive: true });
for (const mode of ['full', 'teaser'] as const) {
  const email = renderArticleEmail({
    locale: a.locale, title: a.title, excerpt: a.excerpt, access: mode === 'teaser' ? 'knowledges' : a.access, coverUrl: a.cover_url,
    document: a.document, articleUrl: `${site}/articles/${slug}`, pricingUrl: `${site}/pricing`, siteUrl: site, mode,
  });
  const { html, text } = withFooter(email, a.locale, `${site}/unsubscribe?token=preview`);
  writeFileSync(path.join(outDir, `${slug}-${mode}.html`), html);
  writeFileSync(path.join(outDir, `${slug}-${mode}.txt`), text);
  console.log(`${mode}: ${html.length} bytes HTML, ${text.length} chars text`);
}
