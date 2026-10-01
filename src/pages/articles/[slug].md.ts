import type { APIRoute } from 'astro';
import { getArticleView, resolveViewer } from '../../lib/blocks/articles';
import { documentToMarkdown } from '../../lib/blocks/markdown';

/** Markdown version of a published article; the paid remainder is withheld exactly as on the HTML page. */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  try {
    const viewer = await resolveViewer(request, d1);
    const view = await getArticleView(d1, params.slug ?? '', viewer);
    if (!view) return new Response('# Not found\n', { status: 404, headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
    const url = `${new URL(request.url).origin}/articles/${view.slug}`;
    let md = `# ${view.title}\n\n`;
    if (view.excerpt) md += `> ${view.excerpt}\n\n`;
    md += documentToMarkdown(view.document, { articleUrl: url }) + '\n';
    if (view.truncated) md += `\n---\n\n*Phần còn lại dành cho thành viên Knowledges — read the full article at ${url}*\n`;
    return new Response(md, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        // Admins see full text; never let a shared cache store a personalised response.
        'Cache-Control': viewer.isAdmin ? 'private, no-store' : 'public, max-age=300',
        Vary: 'Cookie, Authorization',
      },
    });
  } catch (err) {
    console.error('Article markdown error:', err instanceof Error ? err.message : 'unknown');
    return new Response('# Error\n', { status: 500, headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
  }
};
