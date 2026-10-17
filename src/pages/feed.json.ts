import type { APIRoute } from 'astro';
import { errorResponse } from '../lib/http';
import { FEED_CONTENT_TYPE, buildJsonFeed, loadFeedPage, parseFeedQuery } from '../lib/feeds/json-feed';

/** Shared-cache lifetime; a new publication reaches partners within this window. */
const CACHE_CONTROL = 'public, max-age=300, s-maxage=300, stale-while-revalidate=60';

async function strongEtag(body: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
  return `"${Array.from(digest.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('')}"`;
}

/** True when an If-None-Match header (list, weak validators, `*`) matches the current ETag. */
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some(v => {
    const t = v.trim();
    return t === '*' || t.replace(/^W\//, '') === etag;
  });
}

/**
 * Public JSON Feed 1.1 of published article summaries (?lang=&category=&tag=&access=&limit=&cursor=).
 * Anonymous and read-only: the output depends only on the explicit query (default lang=vi), never on
 * cookies, credentials or Accept-Language, so shared caches can serve every partner the same bytes.
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const runtimeEnv = locals.runtime?.env ?? {};
  try {
    const url = new URL(request.url);
    const query = parseFeedQuery(url);
    const origin = (runtimeEnv.PUBLIC_SITE_URL || url.origin).replace(/\/$/, '');
    const { items, next } = await loadFeedPage(runtimeEnv.DB, query, origin);
    const body = JSON.stringify(buildJsonFeed(query, origin, items, next));
    const etag = await strongEtag(body);
    const headers = {
      'Cache-Control': CACHE_CONTROL,
      ETag: etag,
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    };
    if (etagMatches(request.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });
    return new Response(body, { status: 200, headers: { ...headers, 'Content-Type': FEED_CONTENT_TYPE } });
  } catch (err) {
    const res = errorResponse(err);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  }
};
