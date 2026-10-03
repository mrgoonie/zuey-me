import type { APIRoute } from 'astro';
import { errorResponse, jsonError } from '../../../../../lib/http';
import { adminGuard } from '../../../../../lib/blocks/articles';
import { exportSurveyCsv, locateSurvey } from '../../../../../lib/blocks/survey';

/** Admin-only CSV of individual votes (?article_slug=...). Voter keys are hashed; no IPs exist. */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const d1 = locals.runtime?.env?.DB;
  try {
    const denied = await adminGuard(request, d1);
    if (denied) return denied;
    const slug = new URL(request.url).searchParams.get('article_slug');
    if (!slug) return jsonError(400, 'invalid_request', 'article_slug query parameter is required');
    const blockId = params.blockId ?? '';
    const located = await locateSurvey(d1, slug, blockId, { isAdmin: true, entitlements: [] }, { includeDraft: true });
    const csv = await exportSurveyCsv(d1, located);
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="survey-${slug}-${blockId.replace(/[^\w-]/g, '')}.csv"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
};
