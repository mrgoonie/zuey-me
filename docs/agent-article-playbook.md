# Agent playbook: articles, covers, translations and verification

For AI agents and scripts that edit and publish articles on zuey.me through MCP (`/api/mcp` for admins) or REST (`/api/v1/articles`). It starts from the intent, then lists the exact calls, what each answer means and how to retry. Every tool named here already exists; steps that still need a human are marked.

The server owns state, revision consistency and structure. The agent owns intent, wording and translations: nothing here generates a translation for you.

## Keep the context small

Read the least that answers your question.

| Need | Call | Typical size |
| --- | --- | --- |
| Block format for the blocks you will write | `block_schema {types: ["card","image"], compact: true}` | about 4 KB instead of about 29 KB |
| Whether your cached schema is still valid | `block_schema {known_hash: "<schema_hash>"}` answers `{unchanged: true}` | tens of bytes |
| Title, revisions, locales, size and content hash | `article_get {slug, mode: "summary"}` | about 1 KB |
| Block ids, types and headings | `article_get {slug, mode: "outline"}` | a line per block |
| One block (a card, a section) with its children | `article_get {slug, mode: "section", block_id}` | that block only |
| The strings a translator edits | `article_get {slug, mode: "translatables", limit, cursor}` | prose only; follow `next_cursor` |
| The whole document | `article_get {slug}` (mode `full`, the default) | everything |
| No echo of the saved document | add `response_mode: "summary"` to `article_create`, `article_update`, `article_publish` | `document_blocks` and `content_hash` (the `receipt` is always there) |

- `block_schema` without arguments still returns everything (types, limits, rules, icon allowlist, examples). `types` alone returns schemas, limits and examples for those types; add `include: ["rules","icons"]` when you need them. Valid `include` parts: `schemas`, `rules`, `limits`, `icons`, `examples`. Output is deterministic; `schema_hash` changes exactly when the contract does.
- Every read mode goes through the same paywall as a full read. A reader without the entitlement gets `summary`, `outline` and `translatables` of the free part only, and `section` answers `404 block_not_found` for a withheld block. Admins add `draft: true` to read the draft.
- `translatables` never lists code, Mermaid source, math TeX, widget HTML/CSS/JS, URLs, ids or anchors, and an interactive block contributes only its title and caption. Text inside widget code is not extracted; leave it as is.
- `content_hash` is a hash of the document you were served. The hash from a `response_mode: "summary"` write equals the hash a following draft `summary` read reports, so you can confirm a save without reading it back.
- For documents too large to pass inline, keep using `document_url` (an https URL on `media.zuey.me`) on `article_create` and `article_update`.

The same modes exist on REST: `GET /api/v1/articles/{slug}?mode=outline`, `?mode=section&block_id=…`, `?mode=translatables&limit=100&cursor=…`; writes accept `"response_mode": "summary"` in the JSON body.

## Intent: use a generated image as the cover, translate the other editions, publish and verify

1. **Upload the image.** Local file: `media_upload_url`, then `curl --upload-file ./cover.webp '<upload_url>'`. The upload URL is a bearer secret valid for 15 minutes: do not print it in logs or share it. Public URL: `media_import {url}`. Small image: `media_upload {data_base64}`. The answer carries an `image` block with `width` and `height` and a `media.zuey.me` URL. The same file uploaded twice returns the same asset.
2. **Read the source cheaply.** `article_get {slug, draft: true, mode: "summary"}` gives `revision`, `published_revision`, `has_unpublished_changes` and `available_locales`. Use `mode: "outline"` to find the block to change.
3. **Set the cover.** The cover is the first `image` (or first gallery image) of the public part of an edition, so put the image block first in the document, then save with `article_update {slug, locale, document, expected_revision, response_mode: "summary"}`. Cover, in-page hero and social share image are different things: the share image (`og:image`) is generated per edition unless configured otherwise. A metadata-only cover change that avoids rewriting the body is not available yet.
4. **Translate per locale** (the agent writes the text). Page through `article_get {slug, mode: "translatables", locale: "<source>", limit: 100}`. Build the target document from the source document by replacing only those strings by `block_id` and `field_path`; keep every id, URL, code block, widget source and Mermaid edge exactly as in the source. Save with `article_update {slug, locale: "<target>", title, document, expected_revision, response_mode: "summary"}`. A missing edition is created and needs a `title`. There is no server-side merge of translations yet, so the target document is sent whole.
5. **Publish each edition.** `article_publish {slug, locale, expected_revision, confirm: true, notify: false, response_mode: "summary"}`. Publishing is per locale; there is no all-or-nothing release across locales yet, so check every locale in step 6 before telling anyone it is done.
6. **Verify.** `article_verify_public {slug}` (REST: `GET /api/v1/articles/{slug}/verify`). It fetches each published locale as an anonymous visitor and reports, per locale, `ok` and `problems`: HTTP status, title, `html lang`, canonical, the hreflang set, `og:image`, `twitter:image`, the JSON-LD image, whether each image answers 2xx with an image content type (only the site and `media.zuey.me` are requested), the published `content_hash`, and the pending new-article email. `translation_provenance` is `null` until translation provenance is recorded. It proves the page head and images, not that widgets render: for that run `scripts/article-widget-smoke.mjs` (see below).

### curl equivalents

```bash
H=(-H "Authorization: Bearer $ZUEY_API_KEY" -H "Content-Type: application/json")   # admin key
curl -s "${H[@]}" "https://zuey.me/api/v1/articles/$SLUG?draft=1&mode=summary"
curl -s "${H[@]}" "https://zuey.me/api/v1/articles/$SLUG?mode=translatables&limit=100"
curl -s "${H[@]}" -X PUT "https://zuey.me/api/v1/articles/$SLUG" \
  -d '{"locale":"en","title":"…","document":{…},"expected_revision":7,"response_mode":"summary"}'
curl -s "${H[@]}" -X POST "https://zuey.me/api/v1/articles/$SLUG/publish" \
  -d '{"locale":"en","expected_revision":8,"confirm":true,"notify":false,"response_mode":"summary"}'
curl -s "${H[@]}" "https://zuey.me/api/v1/articles/$SLUG/verify"
```

## Reading the answers and retrying

- `status` in a write answer describes the article's public state, not the operation: a published article that you just saved still says `published` while the new draft is unpublished. Read the `receipt` instead. `article_create`, `article_update`, `article_publish`, `article_tags_set` and `article_edition_delete` (REST: `POST /api/v1/articles`, `PUT /api/v1/articles/{slug}`, `POST …/publish`, `PUT …/tags`, `DELETE …/editions`) all return one:

  | Field | Meaning |
  | --- | --- |
  | `operation` | `create`, `update`, `publish`, `tags_set` or `edition_delete` |
  | `locale` | Edition the write is about: the saved, published or deleted one; the primary edition for `tags_set` |
  | `article_revision` | The next `expected_revision`, unless someone else wrote in between |
  | `edition_draft_revision` | Revision at which that edition last changed; lower than `article_revision` after `tags_set`, which leaves the edition alone |
  | `published_revision` | Revision of the public snapshot of that edition; `null` when never published or just deleted |
  | `has_unpublished_changes`, `next_action` | `next_action: "publish"` when the edition's draft differs from what readers see, else `"none"` |
  | `submitted_fields` | Fields present in the request, not a diff (`published_at`/`notify` for publish, `tags` for `tags_set`) |

  After `article_edition_delete` the answer shows the primary edition, while the receipt describes the deleted locale. An idempotent replay of a response stored before receipts shipped on these writers (stored responses are kept for 24 hours) comes back without `receipt`; read `mode: "summary"` instead.
- `read_back: "failed"` on an `article_update` or `article_publish` answer (still `200`) means the write committed but the article could not be read back afterwards (a database error or a concurrent delete). Do not repeat the write; it landed and a retry gets `409`. The edition fields, `revision`, the document and the `receipt` are built from the rows as written; `tags`, `topic_tags`, `category`, `labels`, `available_locales` and other editions are not loaded and come back empty (`editions` lists only the written one), so call `article_get` when you need them. An idempotent replay of that answer repeats the flag; `article_get` shows the current state.
- Every write needs `expected_revision`, and every successful write on the article increments it (all locales share one counter). Writes to several locales are therefore sequential: use the `revision` of the previous answer.
- `409 revision_conflict` with `current_revision`: someone else (or your own earlier call whose answer was lost) saved first. Read `mode: "summary"` and compare `content_hash` with the document you sent: if equal, your save landed, do not repeat it; if not, re-read what changed, merge, retry with `current_revision`. `409 slug_taken` means another article uses that slug.
- `400 invalid_field` names the field; `422 invalid_document` lists `errors: [{path, message}]` for the block tree. Fix the paths, do not retry unchanged.
- Idempotency keys are not available yet. After a timeout, always read before retrying a write.
- `401/403` on a write: the key is read-only or not an admin. Do not retry.

## Code blocks

A `code` block needs only `code` (and usually `language`). Every other field is optional, and a block without them renders exactly as before; `block_schema {types: ["code"]}` returns the schema and a diff example.

| Field | Effect |
| --- | --- |
| `filename` | Caption above the code (one line, no backticks or double quotes, at most 200 characters) |
| `lineNumbers: true` | Line number gutter; numbers are CSS, so they are never selected or copied |
| `highlightLines: "2,4-6"` | Emphasised lines, 1-based; ranges must go upwards and stay within the code's lines, else `422` |
| `diff: true` | Each line starts with `+` (added), `-` (removed) or a space (context). The marker moves to the gutter and `language` still drives highlighting |
| `wrap: true` | Long lines wrap by default instead of scrolling sideways |
| `collapseAfter: 20` | Code longer than 20 lines (3–500) starts collapsed to that height, scrollable, with a button to show it all |

- Readers get a copy button and a wrap toggle on every code block once the page has loaded. Copy puts the code on the clipboard without line numbers or diff markers; for a diff it is the code after the change (added and context lines, removed lines left out).
- Markdown, search and Zuey AI see the file name and the code as written (diff markers included). The `.md` fence carries the options as metadata: ```` ```diff lang="ts" title="src/config.ts" {2} showLineNumbers ````.
- Options are presentation only: `filename` is never listed in `translatables`, and a translation must keep every code field as in the source.

## Data tables

A `table` block needs only `headers` and `rows` (one string per header, at most 20 columns and 200 rows). A table that uses any field below becomes a data table. A table without them renders exactly as before. `block_schema {types: ["table"]}` returns the schema and a `data_table` example.

| Field | Effect |
| --- | --- |
| `columns: [{type, currency?, decimals?, filter?}]` | One entry per header. `type` is `text` (default, inline Markdown), `number`, `currency` (needs a 3-letter `currency` such as `VND`), `percent`, `date`, `boolean`, `link` or `badge`. `decimals` (0–6) applies to the numeric types. `filter: true` adds a column filter: a from/to range for numbers and dates, otherwise a value list |
| `title`, `caption` | One-line plain title above the table (also its accessible name and the CSV file name); inline caption below |
| `sortable: true` | Header buttons sort by value (asc → desc → off) and set `aria-sort`. Empty cells always sort last |
| `search: true` | Search box over every cell. It ignores accents, so `ha noi` finds `Hà Nội` |
| `stickyHeader: true` | The table scrolls inside a box and its header row stays visible |
| `csv: true` | Download button that exports the rows currently shown, in their current order |
| `mobile: "cards"` | On narrow screens each row becomes a card of label/value pairs once the page has loaded (without script it scrolls sideways). The default scrolls sideways |

- Typed cells hold a canonical value, or `""` for empty. A cell with the wrong form fails with `422` at its `rows[i][j]` path:
  - numbers: `1234.5` or `-3`, stored without leading zeros (`00012` is saved as `12`, `-0` as `0`);
  - dates: `2026-01-15`, `2026-01` or `2026`;
  - booleans: `true` or `false`;
  - links: `https://…` or `[label](https://…)`, without a user name or password in the URL;
  - badges: plain text of at most 100 characters.
- Readers see formatted values in the style of the edition. A `vi` edition shows `490.000 ₫`, `12,5%`, `15/01/2026` and `Có`/`Không`. Other editions show `490,000 ₫`, `12.5%`, `Jan 15, 2026` and `Yes`/`No`, with English control labels. Emails follow the same rule.
- Markdown and Zuey AI get the canonical values (`490000`, `2026-01-15`, `true`), with the unit added to the header (`Giá (VND)`). Site search indexes both forms, so `490000` and `490.000` both find the row.
- Data table cells are capped at 1,000 characters each and 100,000 in total.
- The server renders every row, so readers without script and search engines see the full table. The controls appear once the page loads and are fetched only for pages that have a data table.
- The CSV holds plain text for text cells, the URL for links and the canonical value for other cells. It is UTF-8 with a BOM, so spreadsheets open it correctly. A cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return (also their full-width forms, or after zero-width characters) gets a leading `'`, so a spreadsheet will not run it as a formula. Numbers in numeric columns are exempt, so `-12.5` stays a number.
- `translatables` lists the title, the caption and the text and badge cells. Typed cells are data and must stay as in the source.

## Math blocks

- `math.tex` is TeX for KaTeX without surrounding `$` or `$$`. Pages typeset it on the server (HTML plus MathML) and link the self-hosted KaTeX stylesheet only when the document has math; the source stays readable and copyable. `mode: "inline"` sets it at text size, `numbered: true` (display only) adds an equation number in document order. `block_schema {types: ["math"]}` returns the schema and an example.
- One equation sequence runs through the document: `numbered` formulas get `(n)`, and `equation`/`align`/`gather` continue the same count with KaTeX's own numbers. A formula with its own numbering or a `\tag` never gets a second number, even when `numbered` is set.
- Typesetting is bounded so a page cannot burn server CPU: macro definitions (`\def`, `\newcommand`, `\let`, …), nesting deeper than 40 groups, TeX over 2,000 characters, and formulas past the per-page budget (about 8,000 TeX characters plus 100 per formula, so roughly 50 typical formulas; 1.5 MB of markup) show as source. Split long derivations into several blocks.
- KaTeX runs with `trust: false`: `\href`, `\url`, `\includegraphics` and `\html*` render as plain red command names, never as links, images or attributes. Malformed TeX is saved as written (validation does not parse TeX) and readers see its source under an error note, so check the rendered page after a write.

## Paywall and notifications

- An article with `access: "knowledges"` shows readers without the entitlement the free part only. Anonymous verification therefore sees the free part, and `article_verify_public` fails a paid edition whose anonymous page lacks the members-only notice (`paywall.expected` without `paywall.present`), since that means the paid part may be public. Use `draft: true` as admin to read everything.
- **The first publish of an article emails verified members 30 minutes later** unless `notify: false` (backdated `published_at` defaults to no email). Pass `notify` explicitly. `article_verify_public` reports the pending email under `pending_side_effects`.
- A publish whose email step fails after the edition is published still returns `200` with `email_notification.reason: "notification_update_failed"`. Its `status` is the stored email state (for example still `scheduled` when a `notify: false` cancel failed, so members will be emailed), or `failed` when nothing could be read back. The edition is live; republish at the new `expected_revision` with an explicit `notify` to apply the email decision again, then check `pending_side_effects`.
- Share images are re-rendered in the background after writes; a just-published page can take a moment to show its final `og:image`.

## Widgets and embeds on reader pages

- **Interactive widgets** (`interactive` blocks) are first-party code from the article. Published article and lesson pages start each one automatically when it comes within 200 px of the viewport, one start every 150 ms at most, once per page view (scrolling away keeps it running; a frame the watchdog halted waits for **Run**). At most 6 auto-started widgets run at once per page; a widget that reaches the viewport while 6 run stays click-to-run and says so (the reader can still press **Run**, and nothing is stopped for it). A running widget has a **Stop** button that returns it to its placeholder; a stopped widget does not start again by itself during that page view. A widget inside a closed toggle starts when the toggle is opened. Widgets stay click-to-run with `prefers-reduced-motion: reduce`, when the reader saved "do not auto-load embeds on this device" (`zuey:embeds=click`), for well-known crawler user agents (headless browsers are not treated as crawlers), and without `IntersectionObserver`. Auto-start changes nothing about isolation: `sandbox="allow-scripts"` without `allow-same-origin`, the CSP with `connect-src 'none'`, network only through `zuey.fetch` and the allowlisted proxy (50 requests per run, 4 at a time), the 10 s ready watchdog and heartbeat. Studio previews, `?preview=1` article drafts and unpublished lessons opened by an admin never start a widget without a click, and the paywall removes withheld widgets from the page before anything can run them.
- **Social embeds** (`embed` blocks) are third-party frames from allowlisted provider hosts. They load within 200 px of the viewport unless the reader chose "do not auto-load embeds on this device" (`zuey:embeds=click` in local storage), which is always honoured. Studio previews keep them click-to-load.

## Browser smoke for widgets

```bash
bunx --bun -p playwright-core node scripts/article-widget-smoke.mjs \
  --base https://zuey.me --slug "$SLUG" --locales vi,en,zh,ko,ja --expect-widgets 1
```

Loads each locale at 390 px and 1280 px, opens every toggle and scrolls through the page so every widget reaches the viewport. It fails on page or console errors, horizontal scrolling, fewer widgets than `--expect-widgets`, a widget that did not start or was halted by the watchdog, and a widget that ran under reduced motion. Only widget frames (`.zif iframe`) count as widgets; social embeds are reported separately, and widgets past the cap of 6 must show the click-to-run note. The screenshot comes from a second page with `prefers-reduced-motion: reduce` and the click-to-load choice saved, so no live widget or embed output reaches it, and is compared with the stored baseline in `.smoke/<slug>/` (exact bytes; `--update` accepts the current pages as the new baseline and a differing page writes `*.changed.png` next to it). Set `CHROMIUM_PATH` when Chromium is not at `/opt/pw-browsers/chromium`.

## Measured payload sizes

`tests/article-agent-reads.test.ts` measures the response sizes of one translation round on a fixture of ten sections with nested cards, a Mermaid diagram, an interactive widget, a table and a chart. Run `bun test tests/article-agent-reads.test.ts` to print the table. These are JSON characters of tool answers (characters ÷ 4 is only a rough token estimate), not end-to-end model tokens, round trips, elapsed time or cost; those have not been measured.

| Step | Legacy answer | With the options above |
| --- | --- | --- |
| Learn the block format | `block_schema {}` 30,705 | `block_schema {types: [paragraph, heading, card], compact: true}` 4,523 |
| Read what to translate | `article_get` 16,024 | `article_get {mode: "translatables", limit: 500}` 12,300 |
| Save the translated edition | `article_update` echo 16,401 | `response_mode: "summary"` 1,001 |
| Total | 63,130 | 17,824 (−72%) |

The fixture's read step saves less than the others because it is mostly prose; documents with large widget code or diagrams save more, since `translatables` leaves those out.
