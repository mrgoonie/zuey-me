import { jsonOk } from '../../../../lib/http';
import { isLocale, resolveLocale } from '../../../../lib/i18n/locales';
import { memberRoute } from '../../../../lib/members/account';
import { activeNoticesFor } from '../../../../lib/experience/notices';

/** Public: notices live now for this visitor (targeting uses the session, if any). ?lang=en|vi|zh|ko|ja */
export const GET = memberRoute(async ({ request }, { d1, principal }) => {
  const lang = new URL(request.url).searchParams.get('lang');
  const locale = isLocale(lang) ? lang : resolveLocale(request);
  const notices = await activeNoticesFor(d1, principal, locale);
  // The audience depends on the session cookie, so shared caches must not store it.
  return jsonOk({ locale, notices }, 200, { 'Cache-Control': 'private, no-store', Vary: 'Cookie' });
});
