import type { APIRoute } from 'astro';
import { AppError, errorResponse, jsonOk, readJsonObject } from '../../../../lib/http';
import { requireWorkflowAdmin, wantsDrafts } from '../../../../lib/workflows/access';
import { createWorkflow, listAdminWorkflows, listPublicWorkflows } from '../../../../lib/workflows/store';


export const GET: APIRoute = async ({ request, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  try {
    if (wantsDrafts(new URL(request.url))) {
      await requireWorkflowAdmin(request, d1);
      return jsonOk(await listAdminWorkflows(d1));
    }
    return jsonOk(await listPublicWorkflows(d1));
  } catch (err) {
    return errorResponse(err);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  try {
    const actor = await requireWorkflowAdmin(request, d1);
    const body = await readJsonObject(request);
    if (!body) throw new AppError(400, 'invalid_body', 'Expected a JSON object body');
    return jsonOk(await createWorkflow(body, actor, d1), 201);
  } catch (err) {
    return errorResponse(err);
  }
};
