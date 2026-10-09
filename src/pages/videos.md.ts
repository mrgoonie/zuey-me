import type { APIRoute } from 'astro';
import { renderVideosMarkdown } from '../lib/videos/markdown';
import { listVideos } from '../lib/videos/store';

export const GET: APIRoute = async ({ locals, request }) => {
  const env = locals.runtime?.env ?? {};
  const origin = (env.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
  const items = env.DB ? (await listVideos(env.DB, { limit: 200 })).items : [];
  return new Response(renderVideosMarkdown(items, origin), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
};
