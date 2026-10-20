# Edge cache for anonymous page HTML

`src/middleware.ts` serves `/`, `/articles`, `/articles/<slug>` and `/pricing` to anonymous visitors from the Cloudflare Cache API of the colo. Without it, every visit renders on the worker and queries D1. The rules live in `src/lib/edge-html-cache.ts`, and `tests/edge-html-cache.test.ts` pins them.

## Who gets cached HTML

- **Served from cache:** only `GET` requests that carry no `Authorization` header and none of the `zuey_member`, `zuey_session` or `zuey_member_oauth` cookies.
- **Always rendered:** signed-in members and admins, plus search (`?q=`) and draft preview (`?preview=`).
- **Ignored for caching:** analytics, referral and locale cookies do not cause a bypass.

## Cache key

The cache key is the URL plus the resolved locale. Locale comes from `?lang`, then the `zuey_locale` cookie, then `Accept-Language`. Tracking parameters (`utm_*`, `fbclid`, `gclid`, `msclkid`, `ref`) are dropped, and the remaining parameters are sorted.

## What is stored

A response is stored only when:
- its status is 200,
- it is HTML,
- it has no `Set-Cookie`,
- its `Cache-Control` is not `private` or `no-store`.

## Freshness, and why there is no purge

- **Fresh:** 60 s (`EDGE_HTML_FRESH_S`). A fresh copy is served as is.
- **Stale:** the next 10 min (`EDGE_HTML_STALE_S`). A stale copy is served immediately and re-rendered in the background (`waitUntil`).
- **Expired:** after that, the page renders again.

Publishing or updating an article does not purge. A Cache API `delete` reaches only the colo that runs it, so the short fresh window is what bounds staleness. An edit is live within about a minute; a colo holding a copy older than that serves it once more while it refreshes.

## Debugging

The `X-Edge-Cache` response header shows `HIT`, `STALE`, `MISS` or `BYPASS` on these routes.

The Cache API works on the custom domain (`zuey.me`) but not on `*.pages.dev` previews. On previews every request shows `MISS`.
