import type { APIRoute } from 'astro';
import { errorResponse, jsonOk } from '../../../../lib/http';
import { getContributionCalendar } from '../../../../lib/experience/github-calendar';

/**
 * Public GitHub contribution calendar of mrgoonie (last 53 weeks, scraped from the public
 * contributions page): cached for 6 hours and served stale with an `error` field when GitHub fails.
 */
export const GET: APIRoute = async () => {
  try {
    const calendar = await getContributionCalendar();
    const cache = calendar.error ? 'public, max-age=60' : 'public, max-age=3600, stale-while-revalidate=21600';
    return jsonOk(calendar, 200, { 'Cache-Control': cache });
  } catch (err) {
    const res = errorResponse(err);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  }
};
