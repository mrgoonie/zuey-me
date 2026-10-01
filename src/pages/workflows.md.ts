import type { APIRoute } from 'astro';
import { markdownResponse, workflowsIndexMarkdown } from '../lib/workflows/markdown';
import { listPublicWorkflows } from '../lib/workflows/store';

export const GET: APIRoute = async ({ locals }) => {
  try {
    return markdownResponse(workflowsIndexMarkdown(await listPublicWorkflows(locals.runtime?.env?.DB)));
  } catch (err) {
    console.error('Workflows markdown failed:', err instanceof Error ? err.message : 'unknown');
    return markdownResponse('# Internal error\n', 500);
  }
};
