/** Site-wide locale contract shared by the homepage shell, articles, chat and Markdown routes. */
export const LOCALES = ['en', 'vi', 'zh', 'ko', 'ja'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'vi';

/** Cookie that stores the visitor's chosen locale (readable by client islands). */
export const LOCALE_COOKIE = 'zuey_locale';

export const LOCALE_LABELS: Record<Locale, { native: string; english: string; htmlLang: string }> = {
  en: { native: 'English', english: 'English', htmlLang: 'en' },
  vi: { native: 'Tiếng Việt', english: 'Vietnamese', htmlLang: 'vi' },
  zh: { native: '中文', english: 'Chinese', htmlLang: 'zh' },
  ko: { native: '한국어', english: 'Korean', htmlLang: 'ko' },
  ja: { native: '日本語', english: 'Japanese', htmlLang: 'ja' },
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

function cookieLocale(cookieHeader: string): Locale | null {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`));
  const value = match ? decodeURIComponent(match[1]) : null;
  return isLocale(value) ? value : null;
}

function acceptLanguageLocale(header: string): Locale | null {
  for (const part of header.split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase().slice(0, 2);
    if (isLocale(tag)) return tag;
  }
  return null;
}

/** Resolution order: `?lang=` query, locale cookie, Accept-Language, default. */
export function resolveLocale(request: Request): Locale {
  const query = new URL(request.url).searchParams.get('lang');
  if (isLocale(query)) return query;
  return cookieLocale(request.headers.get('cookie') || '')
    ?? acceptLanguageLocale(request.headers.get('accept-language') || '')
    ?? DEFAULT_LOCALE;
}

/** Client-side: persist the chosen locale for one year. */
export function localeCookieValue(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
