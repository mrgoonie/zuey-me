import type { RuntimeEnv } from '../../env';
import type { Principal } from '../members/policy';
import { searchKnowledge } from '../search';
import { listArticles } from './articles';
import type { ArticleSummary, ListOptions } from './articles';
import type { DiscoveryQuery } from './params';
import { applyWindow, queryWindow } from './pagination';
import type { ListWindow } from './pagination';

export interface DiscoveryItem extends ArticleSummary {
  /** Search snippet (only from text this principal may read); present when `q` was given. */
  snippet?: string;
}

export interface DiscoveryResult {
  items: DiscoveryItem[];
  /** Matching articles before windowing. */
  total: number;
  /** True when more matching articles follow this window. */
  hasMore: boolean;
  /** True when semantic (vector) ranking contributed; false means BM25 only. */
  semantic: boolean;
}

/** True when `filters` ask for the plain published list a caller may have loaded already (`listArticles(db, { locale })`). */
function isCatalogQuery(filters: ListOptions): boolean {
  const { locale: _locale, sort, ...rest } = filters;
  return (sort === undefined || sort === 'new') && Object.values(rest).every(v => v === undefined);
}

/**
 * Lists published articles for discovery. Pass `catalog` (the unfiltered `listArticles(db, { locale })` result for
 * the same locale) to skip a second D1 load when the query adds no filter. With `q`, the authorization-first knowledge search
 * picks and orders the articles; filters (category/tag/label/access) then narrow that list.
 * `window` picks the slice to return (default: from `page`/`limit` in the query); `total` counts every match.
 */
export async function discoverArticles(
  principal: Principal, env: RuntimeEnv, query: DiscoveryQuery, window: ListWindow = queryWindow(query),
  catalog?: ArticleSummary[],
): Promise<DiscoveryResult> {
  const { q, page: _page, limit: _limit, ...filters } = query;
  if (!q) {
    const list = catalog && isCatalogQuery(filters) ? catalog : await listArticles(env.DB, filters);
    return { ...applyWindow(list, window), semantic: false };
  }
  const search = await searchKnowledge(principal, q, filters.locale ?? null, 50, env);
  const snippets = new Map<string, string>();
  for (const hit of search.results) if (!snippets.has(hit.article_id)) snippets.set(hit.article_id, hit.snippet);
  const ids = [...snippets.keys()];
  if (ids.length === 0) return { items: [], total: 0, hasMore: false, semantic: search.semantic };
  const all = await listArticles(env.DB, { ...filters, ids, sort: filters.sort ?? 'relevance' });
  const page = applyWindow(all, window);
  return { ...page, items: page.items.map(item => ({ ...item, snippet: snippets.get(item.id) })), semantic: search.semantic };
}
