# Public JSON Feed for partners

`GET https://zuey.me/feed.json` is a read-only [JSON Feed 1.1](https://www.jsonfeed.org/version/1.1/) of published Zuey article **summaries**. Partner sites link readers to zuey.me for the full text. No key or login is needed, and no mode returns paid article bodies.

## Query parameters

| Parameter | Meaning |
| --- | --- |
| `lang` | `vi` (default), `en`, `zh`, `ko`, `ja`. Only editions published in exactly that locale are returned; there is no fallback to another locale. |
| `category` | Category slug or id. |
| `tag` | Topic tag slug or id. |
| `access` | `free` or `knowledges`. A filter only: `knowledges` items still carry the public excerpt and metadata, never the body. |
| `limit` | 1–100, default 20. |
| `cursor` | Opaque; use the `next_url` the feed returns instead of building it. |

Invalid `lang`, `access`, `limit` or `cursor` returns `400` with the usual `{ success: false, error: { code, message } }` body. A missing database returns `503`, never an empty feed.

## Response

`Content-Type: application/feed+json; charset=utf-8`. Top level: `version`, `title`, `home_page_url`, `feed_url`, `language`, `authors`, `items`, and `next_url` while older items exist (follow it until it disappears).

Each item has:

- `id`: `urn:zuey:article:{articleId}:{locale}`. It survives slug changes and republishing, so use it as your dedupe key.
- `url`: canonical `https://zuey.me/articles/{slug}?lang={locale}`.
- `title`, `summary` and `content_text` (the public excerpt, or the title when there is none), `image` (public https image or the site card), `language`, `tags`.
- `date_published`: the original publish date. `date_modified`: the last **publication**, so saving a draft changes nothing until an admin republishes.
- `_zuey`: `access` (`free` | `knowledges`), `category`, `reading_minutes`, `available_locales`, `content_mode` (always `"summary"`) and `markdown_url`.

Items are ordered newest published first. Drafts, deleted editions and scheduled (future) posts never appear.

## Caching and polling

The output depends only on the query string (not on cookies, credentials or `Accept-Language`). Responses carry `Cache-Control: public, max-age=300, s-maxage=300, stale-while-revalidate=60` and a strong `ETag`. Poll no more than every 5 minutes and send `If-None-Match`; a `304` means nothing changed.

```js
let etag;
async function poll() {
  const res = await fetch('https://zuey.me/feed.json?lang=en&limit=20', { headers: etag ? { 'If-None-Match': etag } : {} });
  if (res.status === 304) return;
  etag = res.headers.get('ETag');
  const feed = await res.json();
  for (const item of feed.items) upsert(item.id, item); // item.url is where readers read the full article
}
```

## Notes for maintainers

- Published-state fields live in `article_editions.published_title`, `published_excerpt` and `published_modified_at`, written only by `publishArticle` (migration `0027_article_published_metadata.sql`). Category, tags and access are article-level and take effect as soon as they are saved, as on the article pages.
- The endpoint is in the OpenAPI spec (`/api/openapi.json`, Scalar `/docs`) and advertised in every page head.
- Follow-ups intentionally out of scope: RSS/Atom, per-partner keys, full-text licensing, webhooks, tombstone sync, partner analytics.
- Rollout: apply migration `0027` immediately before the code deploy and avoid publishing in between (a publish by the old code leaves stale snapshot columns; the backfill `UPDATE` is idempotent and can be re-run). Editions published before migration `0009` have no publish revision, so their snapshot is backfilled from the current title/excerpt; confirm they have no unsaved draft edits or republish them.
- `image` comes from the public part at publish time; switching an article to paid without republishing keeps the old image URL (never body text).
