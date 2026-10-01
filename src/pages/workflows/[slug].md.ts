import type { APIRoute } from 'astro';
import { AppError } from '../../lib/http';
import { markdownResponse, workflowToMarkdown } from '../../lib/workflows/markdown';
import { getPublicWorkflow } from '../../lib/workflows/store';

export const GET: APIRoute = async ({ params, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  try {
    return markdownResponse(workflowToMarkdown(await getPublicWorkflow(params.slug ?? '', d1)));
  } catch (err) {
    if (err instanceof AppError && (err.status === 404 || err.status === 400)) {
      return markdownResponse('# Workflow not found\n', 404);
    }
    console.error('Workflow markdown failed:', err instanceof Error ? err.message : 'unknown');
    return markdownResponse('# Internal error\n', 500);
  }
};
