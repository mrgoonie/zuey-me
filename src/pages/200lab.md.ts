import type { APIRoute } from 'astro';
import { runtimeWaitUntil } from '../lib/blocks/articles';
import { renderLab200Markdown } from '../lib/lab200/markdown';
import { emptyLab200Catalog, getLab200Catalog } from '../lib/lab200/store';

export const GET: APIRoute = async ({ locals }) => {
  const runtime = locals.runtime;
  const catalog = await getLab200Catalog(runtime?.env?.DB, { waitUntil: runtimeWaitUntil(runtime) })
    .catch(() => emptyLab200Catalog());
  return new Response(renderLab200Markdown(catalog), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
};
