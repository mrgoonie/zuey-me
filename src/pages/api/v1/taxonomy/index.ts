import type { APIRoute } from 'astro';
import { errorResponse, jsonOk } from '../../../../lib/http';
import { localeParam } from '../../../../lib/blocks/params';
import { DEFAULT_LOCALE } from '../../../../lib/i18n/locales';
import { publicTaxonomy } from '../../../../lib/taxonomy/public';

/** Public discovery facets (?lang=): tags, categories and approved labels used by published articles. */
export const GET: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    const locale = localeParam(new URL(request.url)) ?? DEFAULT_LOCALE;
    return jsonOk({ locale, ...(await publicTaxonomy(env.DB, locale)) }, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch (err) {
    return errorResponse(err);
  }
};
