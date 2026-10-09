import type { APIRoute } from 'astro';
import { AppError } from '../../lib/http';
import { renderCourseMarkdown } from '../../lib/courses/course-markdown';

const MD_HEADERS = { 'Content-Type': 'text/markdown; charset=utf-8' };

/** Outline and trial lessons of a published course; paid lesson text is never included. */
export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = locals.runtime?.env ?? {};
  if (!env.DB) return new Response('# Khoá học\n\n_Tạm thời không tải được khoá học._\n', { status: 503, headers: MD_HEADERS });
  const origin = (env.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
  try {
    const body = await renderCourseMarkdown(env.DB, env, origin, params.slug ?? '');
    return new Response(body, { headers: { ...MD_HEADERS, 'Cache-Control': 'public, max-age=300' } });
  } catch (err) {
    if (err instanceof AppError && err.status === 404) return new Response('# Không tìm thấy khoá học\n', { status: 404, headers: MD_HEADERS });
    throw err;
  }
};
