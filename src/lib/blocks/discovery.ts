import type { RuntimeEnv } from '../../env';
import type { Principal } from '../members/policy';
import { searchKnowledge } from '../search';
import { listArticles } from './articles';
import type { ArticleSummary } from './articles';
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

/**
 * Lists published articles for discovery. With `q`, the authorization-first knowledge search
 * picks and orders the articles; filters (category/tag/label/access) then narrow that list.
 * `window` picks the slice to return (default: from `page`/`limit` in the query); `total` counts every match.
 */
export async function discoverArticles(
  principal: Principal, env: RuntimeEnv, query: DiscoveryQuery, window: ListWindow = queryWindow(query),
): Promise<DiscoveryResult> {
  const { q, page: _page, limit: _limit, ...filters } = query;
  if (!q) return { ...applyWindow(await listArticles(env.DB, filters), window), semantic: false };
  const search = await searchKnowledge(principal, q, filters.locale ?? null, 50, env);
  const snippets = new Map<string, string>();
  for (const hit of search.results) if (!snippets.has(hit.article_id)) snippets.set(hit.article_id, hit.snippet);
  const ids = [...snippets.keys()];
  if (ids.length === 0) return { items: [], total: 0, hasMore: false, semantic: search.semantic };
  const all = await listArticles(env.DB, { ...filters, ids, sort: filters.sort ?? 'relevance' });
  const page = applyWindow(all, window);
  return { ...page, items: page.items.map(item => ({ ...item, snippet: snippets.get(item.id) })), semantic: search.semantic };
}
