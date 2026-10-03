import type { APIRoute } from 'astro';
import { errorResponse, jsonOk } from '../../../../lib/http';
import { getWeather, parseWeatherQuery } from '../../../../lib/experience/weather';

/**
 * Current weather from Open-Meteo for ?lat=&lon= (rounded server-side to 1 decimal) or ?city=
 * (+ optional lang). Nothing about the caller is stored; responses are cached for 10 minutes.
 */
export const GET: APIRoute = async ({ request }) => {
  try {
    const query = parseWeatherQuery(new URL(request.url).searchParams);
    return jsonOk(await getWeather(query), 200, { 'Cache-Control': 'public, max-age=600' });
  } catch (err) {
    const res = errorResponse(err);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  }
};
