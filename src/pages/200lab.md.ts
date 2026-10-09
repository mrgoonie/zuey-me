import type { APIRoute } from 'astro';
import { runtimeWaitUntil } from '../lib/blocks/articles';
import { renderLab200Markdown } from '../lib/lab200/markdown';
import { getLab200Snapshot } from '../lib/lab200/store';

export const GET: APIRoute = async ({ locals }) => {
  const runtime = locals.runtime;
  const snapshot = await getLab200Snapshot(runtime?.env?.DB, { waitUntil: runtimeWaitUntil(runtime) })
    .catch(() => ({ courses: [], syncedAt: null }));
  return new Response(renderLab200Markdown(snapshot), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
};
