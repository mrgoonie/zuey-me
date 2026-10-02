import type { APIRoute } from 'astro';
import { getArticleView, resolveReader } from '../../lib/blocks/articles';
import type { ArticleView } from '../../lib/blocks/articles';
import { documentToMarkdown } from '../../lib/blocks/markdown';
import { readerCacheControl } from '../../lib/blocks/paywall';
import { articleAlternates, articleUrl, linkHeader } from '../../lib/blocks/seo';
import { LOCALE_LABELS, isLocale, resolveLocale } from '../../lib/i18n/locales';

const MD_HEADERS = { 'Content-Type': 'text/markdown; charset=utf-8' };

/** YAML front matter with public metadata only (tags/labels/category are public for every reader). */
function frontMatter(view: ArticleView, url: string, origin: string): string {
  const q = (v: string) => JSON.stringify(v);
  const lines = [
    '---',
    `title: ${q(view.title)}`,
    `url: ${q(url)}`,
    `locale: ${view.locale}`,
    `access: ${view.access === 'knowledges' ? 'members' : 'free'}`,
    `full_text: ${!view.truncated}`,
  ];
  if (view.published_at) lines.push(`published_at: ${q(view.published_at)}`);
  if (view.category) lines.push(`category: ${q(view.category.name)}`);
  if (view.topic_tags.length) lines.push(`tags: [${view.topic_tags.map(t => q(t.name)).join(', ')}]`);
  if (view.labels.length) lines.push(`labels: [${view.labels.map(l => q(`${l.kind}:${l.slug}`)).join(', ')}]`);
  const others = view.available_locales.filter(l => l !== view.locale);
  if (others.length) {
    lines.push('translations:');
    for (const l of others) lines.push(`  ${l}: ${q(articleUrl(origin, view.slug, l, true))}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

/**
 * Markdown edition of a published article (/articles/{slug}.md?lang=xx); the paid remainder is withheld
 * exactly as on the HTML page. Without ?lang the reader's locale picks an edition, else the primary one.
 */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  const d1 = env.DB;
  try {
    const { viewer, principal } = await resolveReader(request, d1, env);
    if (principal.credentialError) {
      return new Response(`# ${principal.credentialError.message}\n`, { status: principal.credentialError.status, headers: MD_HEADERS });
    }
    const langParam = new URL(request.url).searchParams.get('lang');
    const locale = isLocale(langParam) ? langParam : resolveLocale(request);
    const view = await getArticleView(d1, params.slug ?? '', viewer, { locale });
    if (!view) return new Response('# Not found\n', { status: 404, headers: MD_HEADERS });
    const origin = (env.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
    const url = articleUrl(origin, view.slug, view.locale);
    let md = frontMatter(view, url, origin);
    md += `# ${view.title}\n\n`;
    if (view.excerpt) md += `> ${view.excerpt}\n\n`;
    md += documentToMarkdown(view.document, { articleUrl: url }) + '\n';
    if (view.truncated) {
      md += `\n---\n\n*Phần còn lại dành cho thành viên có quyền đọc toàn bài (Knowledges, Kết hợp, Cộng đồng) — see plans at ${origin}/pricing*\n`;
    }
    // canonical points at the HTML edition; alternates list the Markdown of each published edition.
    const alternates = articleAlternates(origin, view.slug, view.available_locales).map(a => ({
      ...a, href: a.hreflang === 'x-default' ? articleUrl(origin, view.slug, undefined, true) : `${a.href.replace('?lang=', '.md?lang=')}`,
    }));
    return new Response(md, {
      headers: {
        ...MD_HEADERS,
        'Content-Language': LOCALE_LABELS[view.locale].htmlLang,
        Link: linkHeader(url, alternates),
        // Entitled readers see full text; never let a shared cache store a personalised response.
        'Cache-Control': readerCacheControl(viewer),
        Vary: 'Cookie, Authorization, Accept-Language',
      },
    });
  } catch (err) {
    console.error('Article markdown error:', err instanceof Error ? err.message : 'unknown');
    return new Response('# Error\n', { status: 500, headers: MD_HEADERS });
  }
};
