import type { APIRoute } from 'astro';
import { renderReadsMarkdown } from '../lib/reads/markdown';
import { getLastSyncedAt, listReads, MAX_READS_LIMIT } from '../lib/reads/store';

export const GET: APIRoute = async ({ locals }) => {
  const d1 = locals.runtime?.env?.DB;
  const { items } = await listReads(d1, { limit: MAX_READS_LIMIT });
  return new Response(renderReadsMarkdown(items, await getLastSyncedAt(d1)), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
};
