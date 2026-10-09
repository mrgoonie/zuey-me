import type { APIRoute } from 'astro';
import { listArticles } from '../lib/blocks/articles';
import { articleAlternates, articleUrl } from '../lib/blocks/seo';
import { LOCALES } from '../lib/i18n/locales';

const STATIC_PATHS = ['/', '/articles', '/pricing', '/business', '/reads', '/200lab', '/courses', '/terms', '/policy', '/docs'];

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * XML sitemap: public pages plus every published article edition with its hreflang alternates
 * (paid articles are listed too — their public part and paywall markup are indexable).
 */
export const GET: APIRoute = async ({ locals, url }) => {
  const env = locals.runtime?.env ?? {};
  const origin = (env.PUBLIC_SITE_URL || url.origin).replace(/\/$/, '');
  const entries: string[] = STATIC_PATHS.map(p => `  <url><loc>${esc(origin + p)}</loc></url>`);
  try {
    const seen = new Set<string>();
    for (const locale of LOCALES) {
      // listArticles with a locale returns that edition where it exists; collect each published edition once.
      for (const a of await listArticles(env.DB, { locale })) {
        if (a.locale !== locale || seen.has(`${a.id}|${locale}`)) continue;
        seen.add(`${a.id}|${locale}`);
        const alternates = articleAlternates(origin, a.slug, a.available_locales)
          .map(alt => `    <xhtml:link rel="alternate" hreflang="${esc(alt.hreflang)}" href="${esc(alt.href)}"/>`).join('\n');
        const lastmod = a.updated_at ? `<lastmod>${esc(a.updated_at.slice(0, 10))}</lastmod>` : '';
        entries.push(`  <url>\n    <loc>${esc(articleUrl(origin, a.slug, locale))}</loc>${lastmod}\n${alternates}\n  </url>`);
      }
    }
  } catch (err) {
    console.error('Sitemap article listing failed:', err instanceof Error ? err.message : 'unknown');
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries.join('\n')}\n</urlset>\n`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=900' } });
};
