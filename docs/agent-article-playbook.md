# Agent playbook: cover image, translations, publish, verify

Intent-first recipe for an AI agent (MCP tools or REST) that takes an existing article, attaches a generated image,
adds translated editions, publishes and checks the public result. Every tool below is admin-only unless noted.

Keep payloads small: ask for the smallest representation that answers the question, and never echo a document you
just sent. Measured payload sizes are at the end; they are bytes, not model tokens.

## What exists today, and what does not

| Need | Use | Note |
| --- | --- | --- |
| Block format | `block_schema({types, include, compact})` | Without arguments it returns everything (large). `schema_hash` changes only when the schema does: cache by it. |
| Read an article cheaply | `article_get({mode})` | `summary`, `outline`, `translatables`, `section`, `full` (default). |
| Write without an echo | `response_mode: "summary"` on `article_create`, `article_update`, `article_publish` | Returns the article summary plus `document_blocks` and `content_hash`. |
| Check the public result | `article_verify_public({slug, locales?})` | Anonymous fetch of each locale page. |
| Image on the CDN | `media_upload_url` (file on disk), `media_import` (public https URL), `media_upload` (small base64) | Insert the returned `block` as is. |

Not available yet (tracked in the #170 epic): a structural translation manifest with server-side merge, a
cover/social-preview setting that is separate from the first in-body image, bulk release and idempotency keys.
Until they land, `article_get({mode: "translatables"})` lists the visible text of an edition but you still send each
translated edition as a full `document` through `article_update`, and each locale is saved and published separately.
`article_verify_public` reports `not_tracked` for translation provenance and for OG/index side effects.

## Recipe: use a generated image as the cover and add translated editions

The cover of an article is its first in-body image (`cover_url` is the first image of the public part), so "set the
cover" means "make that image block the first image of every edition".

1. **Learn the format once, small.** `block_schema({"types": ["image","section","card","paragraph","heading"], "compact": true})`.
2. **Upload the image.** `media_upload_url` → run the returned `curl --upload-file <path> <upload_url>`. The response
   holds an image block with `width` and `height`. The upload URL is valid for 15 minutes and is a credential: never
   paste it into logs or tickets.
3. **Read the source cheaply.** `article_get({"slug": S, "mode": "outline", "draft": true})` for structure, then
   `article_get({"slug": S, "mode": "translatables", "draft": true})` for the text to translate. Page with `cursor` /
   `limit` when `next_cursor` is not null. Each item has `block_id`, `field_path`, `text` and `source_hash`.
   Code, URLs, ids, CSS/JS and Mermaid sources are never listed: copy those from the source document unchanged.
   Mermaid labels are not extracted yet; translate them by hand if needed.
4. **Fetch one block when you only need one.** `article_get({"slug": S, "mode": "section", "section_id": "<block id>"})`.
5. **Save each edition.** `article_update({slug, locale, title, document, expected_revision, response_mode: "summary"})`.
   Use the `revision` from the previous receipt as the next `expected_revision`. A `409 revision_conflict` means
   someone else saved: re-read with `mode: "summary"` and retry with the new revision. For large documents pass
   `document_url` (an https URL on `media.zuey.me`) instead of an inline `document`.
6. **Publish each edition.** `article_publish({slug, locale, expected_revision, confirm: true, notify: false, response_mode: "summary"})`.
   Always pass `notify` explicitly: the first publish of an article schedules an email to verified members 30 minutes
   later unless `notify: false`. Translations of an already published article do not email again by default.
7. **Verify.** `article_verify_public({"slug": S})` and require `ok: true`.

### Reading the receipt

An `article_update` response keeps `status` of the article as it is publicly (`published` stays `published`) and
carries `revision`, `published_revision` and `has_unpublished_changes`. After saving a published article,
`has_unpublished_changes: true` with `status: "published"` is expected: the draft is committed and the public edition
is the previous one until you publish.

### Reading the verification

`article_verify_public` returns, per locale: `http_status`, `title`, `html_lang`, `canonical`, `hreflang`, `access`,
`paywall_marker`, `cover_url`, `og_image` and `cover_image` (reachability probes), `twitter_image`, `json_ld_image`,
`published_revision` and `document_hash`, plus `failed_checks` (names of failed checks) and `ok`. The article-level
`email_notification` shows whether an email is scheduled, sent, skipped or cancelled. Checks cover status 200, page
title, `<html lang>`, canonical, the full hreflang set, an `og:image` that is reachable and an in-body cover that is
reachable. It does not prove that interactive widgets run or that translated labels are complete; look at the page
for that. Only the site origin and `media.zuey.me` are requested.

## REST equivalents

```bash
BASE=https://zuey.me; H='Content-Type: application/json'   # add your admin auth header

# compact outline of a draft edition
curl -s "$BASE/api/v1/articles/$SLUG?draft=1&lang=en&mode=outline" -H "$AUTH"

# save without echoing the document
curl -s -X PUT "$BASE/api/v1/articles/$SLUG" -H "$AUTH" -H "$H" \
  -d '{"expected_revision": 7, "locale": "en", "title": "…", "document": {…}, "response_mode": "summary"}'

# publish one edition, no email
curl -s -X POST "$BASE/api/v1/articles/$SLUG/publish" -H "$AUTH" -H "$H" \
  -d '{"expected_revision": 8, "confirm": true, "locale": "en", "notify": false, "response_mode": "summary"}'

# verify every published locale (or ?locales=en,vi)
curl -s "$BASE/api/v1/articles/$SLUG/verify" -H "$AUTH"
```

Scripted `POST`/`PUT` calls must send `Content-Type: application/json`.

## Errors and retries

| Code | Meaning | What to do |
| --- | --- | --- |
| `revision_conflict` (409) | `expected_revision` is stale | Re-read `mode: "summary"`, retry once with the new revision. |
| `invalid_document` (422) | The document failed validation | Fix the listed paths; nothing was written. |
| `invalid_field` (400) | Bad argument (`mode`, `types`, `cursor`, `response_mode`, …) | The message lists valid values; nothing was written. |
| `section_not_found` (404) | No block with that id in this edition | Take ids from `mode: "outline"`. |
| `not_found` (404) | Unknown slug (or no published edition) | Check the slug and locale. |

A timed-out write may have committed. Before retrying, read `mode: "summary"` and compare `content_hash` with the hash
you expect; resend only when it differs. Idempotency keys are not available yet.

## Paywall

`article_get` modes never reveal more than `full` does for the same caller. Readers without the `read_full`
entitlement get the free part only in every mode; `translatables` and `outline` are built from that same cut.
Admins reading drafts (`draft: true`) see everything.

## Measured payload (frozen fixture, bytes)

`tests/article-agent-reads.test.ts` prints the sizes for one run on its fixture (8 top-level blocks, 14 translatable
fields): the legacy pair `block_schema` + `article_get` is 30,510 bytes; the targeted pair
`block_schema({types, compact})` + `article_get({mode: "translatables"})` is 8,287 bytes (73% smaller). This is
response size only: it is not a token count, not an end-to-end task benchmark, and says nothing about round trips or
cost. Those need a recorded agent run against the frozen legacy baseline and are not claimed here.
