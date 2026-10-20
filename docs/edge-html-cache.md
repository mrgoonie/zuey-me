# Edge cache for anonymous page HTML

`src/middleware.ts` serves `/`, `/articles`, `/articles/<slug>` and `/pricing` to anonymous visitors from the Cloudflare Cache API of the colo. Without it, every visit renders on the worker and queries D1. The rules live in `src/lib/edge-html-cache.ts`, and `tests/edge-html-cache.test.ts` pins them.

## Who gets cached HTML

- **Served from cache:** only `GET` requests that carry no `Authorization` or `X-API-Key` header and none of the `zuey_member`, `zuey_session` or `zuey_member_oauth` cookies.
- **Always rendered:** signed-in members and admins, plus search (`?q=`) and draft preview (`?preview=`).
- **Ignored for caching:** analytics, referral and locale cookies do not cause a bypass.

## Cache key

The cache key is the URL plus the resolved locale. Locale comes from `?lang`, then the `zuey_locale` cookie, then `Accept-Language`. Tracking parameters (`utm_*`, `fbclid`, `gclid`, `msclkid`, `ref`) are dropped, and the remaining parameters are sorted.

## What is stored

A response is stored only when:
- its status is 200,
- it is HTML,
- it has no `Set-Cookie`, including cookies a page sets through `Astro.cookies` (the adapter adds those after the middleware, so the middleware checks `context.cookies` itself),
- its `Cache-Control` is not `private` or `no-store`.

The stored copy carries `Cache-Control: public, max-age=660` so the Cache API keeps it for the fresh and stale windows. Clients never see that value: on `HIT` and `STALE` the page's own `Cache-Control` is restored and the internal `X-Edge-*` headers are removed.

Storing happens after the response is returned (`waitUntil`), so the page still streams, and a failed write only means the next visitor renders again.

## Freshness, and why there is no purge

- **Fresh:** 60 s (`EDGE_HTML_FRESH_S`). A fresh copy is served as is.
- **Stale:** the next 10 min (`EDGE_HTML_STALE_S`). A stale copy is served immediately and re-rendered in the background (`waitUntil`).
- **Expired:** after that, the page renders again.

Publishing or updating an article does not purge. A Cache API `delete` reaches only the colo that runs it, so the short windows bound staleness instead. A colo that already holds a copy serves it unchanged for up to 60 s, then serves it once more while it re-renders. A colo whose copy is near the end of the stale window can therefore serve the old page for up to 11 minutes (60 s + 10 min) after a change. In practice an edit shows within about a minute on busy pages.

Within one worker isolate, concurrent `STALE` hits on the same key start one background render, not one each. Other isolates and colos may still refresh the same key; that costs a render, not correctness.

The same bound applies to HTML-level settings. After `IMAGE_TRANSFORMS=off`, cached pages keep their `/cdn-cgi/image` URLs for up to 11 minutes, so wait that long before turning off the zone's `image_resizing` setting.

## Debugging

The `X-Edge-Cache` response header shows `HIT`, `STALE`, `MISS` or `BYPASS` on these routes.

The Cache API works on the custom domain (`zuey.me`) but not on `*.pages.dev` previews. On previews every request shows `MISS`.
