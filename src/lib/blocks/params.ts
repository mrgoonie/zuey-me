import { AppError } from '../http';
import { LOCALES, isLocale } from '../i18n/locales';
import type { Locale } from '../i18n/locales';
import type { ArticleAccess } from './schema';
import { SORTS } from './articles';
import type { ArticleSort, ListOptions } from './articles';

/** Optional `?lang=` (or another name) query parameter; an unknown value is a 400, not a silent fallback. */
export function localeParam(url: URL, name = 'lang'): Locale | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return undefined;
  if (!isLocale(raw)) throw new AppError(400, 'invalid_locale', `${name} must be one of ${LOCALES.join(', ')}`, { field: name });
  return raw;
}

/** Optional locale in a JSON body field. */
export function localeField(body: Record<string, unknown>, name = 'locale'): Locale | undefined {
  const raw = body[name];
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (!isLocale(raw)) throw new AppError(400, 'invalid_locale', `${name} must be one of ${LOCALES.join(', ')}`, { field: name });
  return raw;
}

function shortParam(url: URL, name: string, max = 80): string | undefined {
  const raw = url.searchParams.get(name)?.trim();
  if (!raw) return undefined;
  if (raw.length > max) throw new AppError(400, 'invalid_field', `${name} is too long`, { field: name });
  return raw;
}

export interface DiscoveryQuery extends ListOptions {
  q?: string;
}

/** Shared parsing of discovery filters for the REST list, the /articles page and MCP. */
export function parseDiscoveryQuery(url: URL): DiscoveryQuery {
  const sortRaw = url.searchParams.get('sort');
  let sort: ArticleSort | undefined;
  if (sortRaw) {
    if (!(SORTS as readonly string[]).includes(sortRaw)) throw new AppError(400, 'invalid_field', `sort must be one of ${SORTS.join(', ')}`, { field: 'sort' });
    sort = SORTS.find(s => s === sortRaw);
  }
  const accessRaw = url.searchParams.get('access');
  let access: ArticleAccess | undefined;
  if (accessRaw) {
    if (accessRaw !== 'free' && accessRaw !== 'knowledges') throw new AppError(400, 'invalid_field', "access must be 'free' or 'knowledges'", { field: 'access' });
    access = accessRaw;
  }
  const limitRaw = url.searchParams.get('limit');
  let limit: number | undefined;
  if (limitRaw) {
    const v = Number(limitRaw);
    if (!Number.isInteger(v) || v < 1 || v > 100) throw new AppError(400, 'invalid_field', 'limit must be an integer 1–100', { field: 'limit' });
    limit = v;
  }
  return {
    q: shortParam(url, 'q', 200),
    locale: localeParam(url),
    category: shortParam(url, 'category'),
    tag: shortParam(url, 'tag'),
    label: shortParam(url, 'label'),
    access,
    sort,
    limit,
  };
}
