/**
 * Maps where a visitor is to a presence activity category. Pure and allowlist-based: only the first
 * path segment (or the focused ZueyOS app id on the desktop) is inspected, and only a category from
 * the closed contract list ever leaves the browser, never the path, query or title.
 */
import type { ActivityCategory } from './contract';

/** First path segment → category, for the real top-level routes in src/pages. */
const ROUTE_CATEGORIES: Readonly<Record<string, ActivityCategory>> = {
  articles: 'reading',
  videos: 'zueytube',
  reads: 'reads',
  chat: 'ai',
  courses: 'courses',
  certificates: 'courses',
};

/** Focused ZueyOS window (app ids from src/components/os/apps.ts) → category on the `/` desktop. */
const APP_CATEGORIES: Readonly<Record<string, ActivityCategory>> = {
  knowledges: 'reading',
  zueytube: 'zueytube',
  reads: 'reads',
  ai: 'ai',
};

function firstSegment(pathname: string): string {
  const trimmed = pathname.replace(/^\/+/, '');
  const end = trimmed.search(/[/?#.]/);
  return (end < 0 ? trimmed : trimmed.slice(0, end)).toLowerCase();
}

/**
 * `/` is the ZueyOS desktop: the focused app decides (no or another app → `exploring`). Any other route
 * maps by its first segment (`/articles/x` → `reading`); unknown routes are `other`.
 */
export function categoryFor(pathname: string, focusedApp: string | null): ActivityCategory {
  const segment = firstSegment(pathname);
  if (segment === '') {
    if (focusedApp === null) return 'exploring';
    return Object.hasOwn(APP_CATEGORIES, focusedApp) ? APP_CATEGORIES[focusedApp] : 'exploring';
  }
  return Object.hasOwn(ROUTE_CATEGORIES, segment) ? ROUTE_CATEGORIES[segment] : 'other';
}
