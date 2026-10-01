import type { APIRoute } from 'astro';
import { AppError, errorResponse, jsonOk, readJsonObject } from '../../../../lib/http';
import { requireWorkflowAdmin, wantsDrafts } from '../../../../lib/workflows/access';
import { deleteWorkflow, getAdminWorkflow, getPublicWorkflow, updateWorkflow } from '../../../../lib/workflows/store';

export const GET: APIRoute = async ({ request, params, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  try {
    const slug = params.slug ?? '';
    if (wantsDrafts(new URL(request.url))) {
      await requireWorkflowAdmin(request, d1);
      return jsonOk(await getAdminWorkflow(slug, d1));
    }
    return jsonOk(await getPublicWorkflow(slug, d1));
  } catch (err) {
    return errorResponse(err);
  }
};

export const PUT: APIRoute = async ({ request, params, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  try {
    const actor = await requireWorkflowAdmin(request, d1);
    const body = await readJsonObject(request);
    if (!body) throw new AppError(400, 'invalid_body', 'Expected a JSON object body');
    return jsonOk(await updateWorkflow(params.slug ?? '', body, actor, d1));
  } catch (err) {
    return errorResponse(err);
  }
};

export const DELETE: APIRoute = async ({ request, params, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  try {
    const actor = await requireWorkflowAdmin(request, d1);
    const fromQuery = new URL(request.url).searchParams.get('expected_revision');
    const body = fromQuery === null ? await readJsonObject(request) : null;
    const expected = fromQuery ?? body?.expected_revision;
    return jsonOk(await deleteWorkflow(params.slug ?? '', expected, actor, d1));
  } catch (err) {
    return errorResponse(err);
  }
};
