import type { APIRoute } from 'astro';
import { errorResponse, jsonOk } from '../../../../lib/http';
import { getGithubActivity } from '../../../../lib/experience/github-activity';

/**
 * Public GitHub events of mrgoonie (up to 300, roughly the last 90 days): cached for 15 minutes,
 * ETag-revalidated, and served stale with an `error` field when GitHub is rate limited or down.
 */
export const GET: APIRoute = async () => {
  try {
    const result = await getGithubActivity();
    const cache = result.error ? 'public, max-age=60' : 'public, max-age=300, stale-while-revalidate=600';
    return jsonOk(result, 200, { 'Cache-Control': cache });
  } catch (err) {
    const res = errorResponse(err);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  }
};
