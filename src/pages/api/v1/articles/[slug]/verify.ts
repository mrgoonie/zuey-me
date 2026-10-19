import type { APIRoute } from 'astro';
import { AppError, errorResponse, jsonOk } from '../../../../../lib/http';
import { isLocale } from '../../../../../lib/i18n/locales';
import type { Locale } from '../../../../../lib/i18n/locales';
import { verifyPublicArticle } from '../../../../../lib/blocks/verify-public';
import { requireAdminActor } from '../../../../../lib/taxonomy/admin';

/**
 * Admin: reads the live public pages of every published edition (or ?lang=, repeatable) without
 * credentials and compares them with the stored editions. ?images=0 skips the image requests.
 */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    await requireAdminActor(request, env);
    const url = new URL(request.url);
    const locales: Locale[] = url.searchParams.getAll('lang').map(lang => {
      if (!isLocale(lang)) throw new AppError(400, 'invalid_field', `Unsupported locale ${lang}`, { field: 'lang' });
      return lang;
    });
    const origin = (env.PUBLIC_SITE_URL || url.origin).replace(/\/$/, '');
    const result = await verifyPublicArticle(env.DB, params.slug ?? '', { origin, locales: locales.length ? locales : undefined, checkImages: url.searchParams.get('images') !== '0' });
    return jsonOk(result, 200, { 'Cache-Control': 'private, no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};
