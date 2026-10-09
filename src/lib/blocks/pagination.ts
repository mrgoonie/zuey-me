import type { DiscoveryQuery } from './params';

/** Articles per page on /articles and the default REST/MCP page size when `page` is given. */
export const ARTICLE_PAGE_SIZE = 20;
/**
 * Highest page number accepted. `listArticles` reads at most 500 rows, so 25 pages of 20 reach every
 * article it can return; /articles?page=N renders pages 1..N, so this also caps that page's size.
 */
export const MAX_ARTICLE_PAGE = 25;

/** A contiguous window of a sorted list: skip `offset`, keep at most `limit` (all when absent). */
export interface ListWindow {
  offset: number;
  limit?: number;
}

export interface WindowedList<T> {
  items: T[];
  /** Length of the whole list before windowing. */
  total: number;
  /** True when items exist after this window. */
  hasMore: boolean;
}

export function applyWindow<T>(all: T[], window: ListWindow = { offset: 0 }): WindowedList<T> {
  const start = Math.max(0, window.offset);
  const end = window.limit === undefined ? all.length : start + window.limit;
  return { items: all.slice(start, end), total: all.length, hasMore: end < all.length };
}

/** Window for one page (1-based) of `size` items. */
export function pageWindow(page: number, size = ARTICLE_PAGE_SIZE): ListWindow {
  return { offset: (page - 1) * size, limit: size };
}

/** Window for pages 1..page together (what /articles?page=N shows after a reload or a Back). */
export function throughPageWindow(page: number, size = ARTICLE_PAGE_SIZE): ListWindow {
  return { offset: 0, limit: page * size };
}

/** REST/MCP window: `page` pages by `limit` (default 20); without `page`, `limit` alone caps the list. */
export function queryWindow(query: Pick<DiscoveryQuery, 'page' | 'limit'>): ListWindow {
  if (query.page) return pageWindow(query.page, query.limit ?? ARTICLE_PAGE_SIZE);
  return { offset: 0, limit: query.limit };
}
