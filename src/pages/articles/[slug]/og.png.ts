import type { APIRoute } from 'astro';
import { getArticleView, runtimeWaitUntil } from '../../../lib/blocks/articles';
import { isLocale } from '../../../lib/i18n/locales';
import { articleOgImage, ensureArticleOgImage } from '../../../lib/og/article-og-service';
import { renderArticleOgPng } from '../../../lib/og/og-renderer';

/** Shown when a card cannot be rendered (e.g. fonts unreachable), so shares still get a picture. */
const FALLBACK_IMAGE = '/og.png';
/** A `v` that matches the content never changes meaning: social networks and browsers may keep it forever. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Unversioned or outdated URLs always serve the current card, so they must be re-checked soon. */
const SHORT = 'public, max-age=300';

interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/** `caches.default` exists only on Cloudflare Workers. */
function edgeCache(): EdgeCache | null {
  const def: unknown = typeof caches === 'object' && caches ? Reflect.get(caches, 'default') : null;
  return def && typeof def === 'object' && 'match' in def && 'put' in def ? def as EdgeCache : null;
}

/**
 * Social share image (1200×630 PNG) of one published edition: /articles/{slug}/og.png?lang=xx&v=hash.
 * Rendered from what anonymous readers see, stored in D1 per edition and refreshed whenever the
 * article changes (writes pre-render it in the background; a stale or missing image renders here).
 */
export const GET: APIRoute = async ({ params, url, locals }) => {
  const env = locals.runtime?.env ?? {};
  const db = env.DB;
  const lang = url.searchParams.get('lang');
  const locale = lang && isLocale(lang) ? lang : undefined;
  const view = db ? await getArticleView(db, params.slug ?? '', { isAdmin: false, entitlements: [] }, { locale }) : null;
  if (!db || !view || (locale && view.locale_fallback)) return new Response('Not found', { status: 404 });

  const { hash } = await articleOgImage(view);
  const current = url.searchParams.get('v') === hash;
  const cache = current ? edgeCache() : null;
  const cacheKey = new Request(url.toString());
  const hit = await cache?.match(cacheKey).catch(() => undefined);
  if (hit) return hit;

  try {
    const { png } = await ensureArticleOgImage(db, view, card => renderArticleOgPng(card));
    const response = new Response(png as Uint8Array<ArrayBuffer>, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': current ? IMMUTABLE : SHORT,
        'X-Content-Type-Options': 'nosniff',
      },
    });
    if (cache) runtimeWaitUntil(locals.runtime)?.(cache.put(cacheKey, response.clone()).catch(() => undefined));
    return response;
  } catch (err) {
    console.error('Share image render failed:', err instanceof Error ? err.message : 'unknown');
    return new Response(null, { status: 302, headers: { Location: FALLBACK_IMAGE, 'Cache-Control': 'no-store' } });
  }
};
