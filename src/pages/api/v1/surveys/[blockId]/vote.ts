import type { APIRoute } from 'astro';
import { errorResponse, getString, jsonError, jsonOk, readJsonObject } from '../../../../../lib/http';
import { resolveViewer } from '../../../../../lib/blocks/articles';
import { castVote, clientIp, locateSurvey, resolveVoter } from '../../../../../lib/blocks/survey';

/** Cast one vote. Body: { article_slug, option_ids }. One vote per voter per survey block. */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env;
  const d1 = env?.DB;
  const salt = env?.SURVEY_HASH_SALT;
  let setCookie: string | undefined;
  const withCookie = (res: Response): Response => {
    if (setCookie) res.headers.append('Set-Cookie', setCookie);
    return res;
  };
  try {
    if (!salt) return jsonError(503, 'survey_unconfigured', 'Voting is unavailable: SURVEY_HASH_SALT is not configured');
    const body = await readJsonObject(request);
    const slug = body ? getString(body, 'article_slug') : undefined;
    if (!body || !slug) return jsonError(400, 'invalid_request', 'Body must be { article_slug, option_ids }');
    const viewer = await resolveViewer(request, d1);
    const located = await locateSurvey(d1, slug, params.blockId ?? '', viewer);
    const voter = await resolveVoter(request, viewer, salt, true);
    setCookie = voter.setCookie;
    if (!voter.voterKey) return withCookie(jsonError(503, 'survey_unconfigured', 'Voting is unavailable'));
    const results = await castVote(d1, located, body.option_ids, voter.voterKey, clientIp(request), salt);
    return withCookie(jsonOk(results, 201));
  } catch (err) {
    return withCookie(errorResponse(err));
  }
};
