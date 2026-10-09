import type { APIRoute } from 'astro';
import { renderCatalogMarkdown } from '../lib/courses/course-markdown';

export const GET: APIRoute = async ({ locals, request }) => {
  const env = locals.runtime?.env ?? {};
  const origin = (env.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
  const body = env.DB ? await renderCatalogMarkdown(env.DB, env, origin) : '# Khoá học — Zuey\n\n_Tạm thời không tải được danh sách khoá học._\n';
  return new Response(body, {
    status: env.DB ? 200 : 503,
    headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
};
