import type { APIRoute } from 'astro';
import { AppError, errorResponse, jsonOk, readJsonObject } from '../../../../../lib/http';
import { requireWorkflowAdmin } from '../../../../../lib/workflows/access';
import { publishWorkflow } from '../../../../../lib/workflows/store';

export const POST: APIRoute = async ({ request, params, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  try {
    const actor = await requireWorkflowAdmin(request, d1);
    const body = await readJsonObject(request);
    if (!body) throw new AppError(400, 'invalid_body', 'Expected a JSON object body');
    return jsonOk(await publishWorkflow(params.slug ?? '', body, actor, d1));
  } catch (err) {
    return errorResponse(err);
  }
};
