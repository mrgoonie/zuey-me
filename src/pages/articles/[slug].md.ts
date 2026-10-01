import type { APIRoute } from 'astro';
import { getArticleView, resolveReader } from '../../lib/blocks/articles';
import { documentToMarkdown } from '../../lib/blocks/markdown';
import { readerCacheControl } from '../../lib/blocks/paywall';

const MD_HEADERS = { 'Content-Type': 'text/markdown; charset=utf-8' };

/** Markdown version of a published article; the paid remainder is withheld exactly as on the HTML page. */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  const d1 = env.DB;
  try {
    const { viewer, principal } = await resolveReader(request, d1, env);
    if (principal.credentialError) {
      return new Response(`# ${principal.credentialError.message}\n`, { status: principal.credentialError.status, headers: MD_HEADERS });
    }
    const view = await getArticleView(d1, params.slug ?? '', viewer);
    if (!view) return new Response('# Not found\n', { status: 404, headers: MD_HEADERS });
    const origin = new URL(request.url).origin;
    const url = `${origin}/articles/${view.slug}`;
    let md = `# ${view.title}\n\n`;
    if (view.excerpt) md += `> ${view.excerpt}\n\n`;
    md += documentToMarkdown(view.document, { articleUrl: url }) + '\n';
    if (view.truncated) {
      md += `\n---\n\n*Phần còn lại dành cho thành viên có quyền đọc toàn bài (Knowledges, Kết hợp, Cộng đồng) — see plans at ${origin}/pricing*\n`;
    }
    return new Response(md, {
      headers: {
        ...MD_HEADERS,
        // Entitled readers see full text; never let a shared cache store a personalised response.
        'Cache-Control': readerCacheControl(viewer),
        Vary: 'Cookie, Authorization',
      },
    });
  } catch (err) {
    console.error('Article markdown error:', err instanceof Error ? err.message : 'unknown');
    return new Response('# Error\n', { status: 500, headers: MD_HEADERS });
  }
};
