import type { APIRoute } from 'astro';
import { AppError, errorResponse, jsonOk } from '../../../../../lib/http';
import { isLocale } from '../../../../../lib/i18n/locales';
import type { Locale } from '../../../../../lib/i18n/locales';
import { verifyPublic } from '../../../../../lib/blocks/verify-public';
import { requireAdminActor } from '../../../../../lib/taxonomy/admin';

/** Admin: reads the article's public pages anonymously and reports status, metadata and image reachability per locale (?locales=en,vi). */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    await requireAdminActor(request, env);
    const url = new URL(request.url);
    const raw = url.searchParams.get('locales');
    const requested = raw ? raw.split(',').map(l => l.trim()).filter(Boolean) : undefined;
    const bad = requested?.find(l => !isLocale(l));
    if (bad !== undefined) throw new AppError(400, 'invalid_locale', `Unknown locale "${bad}"`, { field: 'locales' });
    const origin = (env.PUBLIC_SITE_URL || url.origin).replace(/\/$/, '');
    return jsonOk(await verifyPublic(env.DB, params.slug ?? '', { origin, locales: requested as Locale[] | undefined }), 200, { 'Cache-Control': 'private, no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};
