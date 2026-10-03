import type { RuntimeEnv } from '../../env';
import type { Principal } from '../members/policy';
import { searchKnowledge } from '../search';
import { listArticles } from './articles';
import type { ArticleSummary } from './articles';
import type { DiscoveryQuery } from './params';

export interface DiscoveryItem extends ArticleSummary {
  /** Search snippet (only from text this principal may read); present when `q` was given. */
  snippet?: string;
}

export interface DiscoveryResult {
  items: DiscoveryItem[];
  /** True when semantic (vector) ranking contributed; false means BM25 only. */
  semantic: boolean;
}

/**
 * Lists published articles for discovery. With `q`, the authorization-first knowledge search
 * picks and orders the articles; filters (category/tag/label/access) then narrow that list.
 */
export async function discoverArticles(principal: Principal, env: RuntimeEnv, query: DiscoveryQuery): Promise<DiscoveryResult> {
  const { q, ...filters } = query;
  if (!q) return { items: await listArticles(env.DB, filters), semantic: false };
  const search = await searchKnowledge(principal, q, filters.locale ?? null, 50, env);
  const snippets = new Map<string, string>();
  for (const hit of search.results) if (!snippets.has(hit.article_id)) snippets.set(hit.article_id, hit.snippet);
  const ids = [...snippets.keys()];
  if (ids.length === 0) return { items: [], semantic: search.semantic };
  const items = await listArticles(env.DB, { ...filters, ids, sort: filters.sort ?? 'relevance' });
  return { items: items.map(item => ({ ...item, snippet: snippets.get(item.id) })), semantic: search.semantic };
}
