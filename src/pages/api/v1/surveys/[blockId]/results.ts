import type { APIRoute } from 'astro';
import { errorResponse, jsonError, jsonOk } from '../../../../../lib/http';
import { resolveViewer } from '../../../../../lib/blocks/articles';
import { locateSurvey, resolveVoter, surveyResults } from '../../../../../lib/blocks/survey';

/** Public aggregated results for a visible survey (?article_slug=...), plus whether this voter voted. */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env;
  const d1 = env?.DB;
  try {
    const slug = new URL(request.url).searchParams.get('article_slug');
    if (!slug) return jsonError(400, 'invalid_request', 'article_slug query parameter is required');
    const viewer = await resolveViewer(request, d1);
    const located = await locateSurvey(d1, slug, params.blockId ?? '', viewer, { includeDraft: viewer.isAdmin });
    const voter = await resolveVoter(request, viewer, env?.SURVEY_HASH_SALT, false);
    return jsonOk(await surveyResults(d1, located, voter.voterKey), 200, { 'Cache-Control': 'private, no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};
