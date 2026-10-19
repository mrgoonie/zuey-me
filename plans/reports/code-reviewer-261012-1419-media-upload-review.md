# Code Review: c09f72d feat(media) upload article images to media CDN (#161)

## Scope
- Files: migrations/0024_media_assets.sql, src/lib/media/{image-sniff,media-asset-store,media-upload-sources,media-mcp,media-openapi}.ts, src/pages/api/v1/admin/media/{index,[id],upload-url}.ts, src/pages/api/v1/media/uploads/[token].ts, src/lib/csrf-origin-check.ts, src/lib/oauth/tool-access.ts, src/env.d.ts, wrangler.toml, tests/media-upload.test.ts
- LOC: ~990 added
- Checks run: `bun test tests/media-upload.test.ts` 12 pass / 0 fail; `bunx astro check` 0 errors / 0 warnings
- Empirical probe (scratch test, deleted afterwards, worktree clean): two concurrent `storeImage` calls with identical bytes -> one `SQLiteError: UNIQUE constraint failed: media_assets.sha256`; `sniffImage` on a PNG header claiming 4,000,000,000 px wide returns `width: 4000000000`.

## Overall
Auth model is sound: REST uses `requireCan(principal,'admin')` (read keys resolve to `anonymous` in policy.ts:161 so are refused), MCP uses `ctx.requireAdmin()` -> `authenticateAdmin` (rejects role `read`). Ticket claim is a conditional UPDATE with `changes === 1`, so double-spend is safe. Upload body is only read after a valid ticket lookup, so the unauthenticated PUT cannot be used to make the Worker buffer 10 MB. No Node builtins, no `any`, no unchecked casts. Header parsing offsets for PNG/GIF/JPEG SOF/VP8/VP8L/VP8X/ispe verified correct. Issues below are correctness/robustness, none critical.

## Critical
None.

## High
None.

## Medium

### M1. Concurrent identical uploads -> 500 (check-then-insert race on UNIQUE sha256)
- src/lib/media/media-asset-store.ts:107-126
- `SELECT ... WHERE sha256` then `bucket.put` then `INSERT`. Two in-flight requests with the same bytes (MCP client retry after timeout, Studio double-submit, agent calling media_import twice in parallel) both miss the SELECT; the second INSERT throws a raw SQLiteError -> `errorResponse` 500 `internal_error` / MCP "Internal error". Verified empirically. If the upload went through a ticket, the ticket is already burned (media-upload-sources.ts:113-116) so the caller also loses the URL. Across a month boundary the loser also leaves an orphan R2 object under a different `articles/yyyy/mm/` key.
- Fix: `INSERT ... ON CONFLICT(sha256) DO NOTHING`, then `SELECT * FROM media_assets WHERE sha256 = ?` and return `created = (meta.changes === 1)`; if the row's `object_key` differs from the one just written, `bucket.delete(ourKey)`.

### M2. `media_delete` ignores course cover URLs (and other URL columns)
- src/lib/media/media-asset-store.ts:147-156
- Only `article_editions.draft_json/published_json` and `course_lessons.draft_json/published_json` are scanned. `courses.cover_url` is admin-set free-form https (src/lib/courses/course-store.ts:97-100) and is the obvious place an admin will paste a media.zuey.me URL; deleting the asset breaks the course cover with no 409. Same for profile `avatar_url`, links, reads `image`. Tool/OpenAPI text says "refused while a current document uses it", which is true only for block documents.
- Fix: add `SELECT slug FROM courses WHERE cover_url = ?` (at minimum) to `mediaReferences` and return it under a `courses` key; or narrow the description to "article and lesson documents".

### M3. Dimensions are not bounded to the block validator limit; "insert as is" block can be rejected
- src/lib/media/image-sniff.ts:25-28 (`size()`), consumed at media-asset-store.ts:62-66
- Block validator requires `1..LIMITS.imagePixels` (50,000; src/lib/blocks/schema.ts:38, validator-core.ts:97). PNG/AVIF be32 can yield up to 4.29e9 (verified), JPEG/GIF up to 65,535 (a long panorama or full-page screenshot is legitimate). The returned `block` then fails `article_update` validation, contradicting the tool contract, and absurd values are persisted in `media_assets.width/height`.
- Fix: in `size()` return nulls when `width > 50_000 || height > 50_000` (import `LIMITS.imagePixels`), matching the "unreadable header never blocks the upload" policy.

### M4. Multipart path buffers the whole request before the size cap applies
- src/pages/api/v1/admin/media/index.ts:27-31
- `request.formData()` parses and buffers the full body (up to the platform request limit, 100 MB+) before `readBounded(file.stream())` enforces 10 MB, then `readBounded` copies again. A large file from the Studio (admin, so not an attack surface) can blow the 128 MB isolate memory and surface as an opaque 1102/500 rather than 413.
- Fix: reject early on `Number(request.headers.get('content-length')) > MAX_IMAGE_BYTES + 64 KiB` with 413 before `formData()`; use `new Uint8Array(await file.arrayBuffer())` after checking `file.size <= MAX_IMAGE_BYTES` instead of streaming the already-buffered file.

## Low

### L1. Ticket burned before store; any store failure strands the upload
- src/lib/media/media-upload-sources.ts:113-117
- Claim happens before `storeImage`. R2 put failure or M1's UNIQUE error -> ticket `used_at` set, no `asset_id`, caller gets 500 and must request a new URL. Acceptable trade-off for single-use semantics, but if M1 is fixed via upsert the main trigger disappears. Optionally reset `used_at = NULL` in a catch when `storeImage` throws.

### L2. Delete order leaves a dangling row on partial failure; CDN cache persists
- src/lib/media/media-asset-store.ts:167-168
- R2 object deleted before the D1 row; if the DELETE statement fails the row points at a missing object and future same-bytes uploads dedupe to a dead URL (storeImage returns the existing row without checking R2). Swap the order (row first; an orphan object is harmless). Separately, objects are served `public, max-age=31536000, immutable`, so a "deleted" image remains served from Cloudflare edge/browser caches; if delete is ever used for takedown, a cache purge is needed. Document this in the tool description at minimum.

### L3. AVIF: major-brand-only detection and first-`ispe` heuristic
- src/lib/media/image-sniff.ts:57-65, 77-80
- Files whose major brand is `mif1`/`miaf` with `avif` only in compatible brands (several encoders/converters do this) are rejected with 415. The first `ispe` box found is not necessarily the primary item's (alpha/thumbnail/grid tile properties may come first), giving wrong dimensions. Fix: scan compatible brands in the `ftyp` box (bytes 16..boxSize) for `avif`/`avis`; for sizes, prefer the largest `ispe` or resolve via `ipma` for the `pitm` item (or accept nulls).

### L4. JPEG EXIF orientation not applied to width/height
- src/lib/media/image-sniff.ts:30-44
- Phone photos with Orientation 5-8 report SOF dimensions swapped versus what browsers render (`image-orientation: from-image`). Block gets wrong aspect ratio -> placeholder/CLS mismatch. Fix: parse APP1 Exif Orientation tag and swap when 5-8, or document.

### L5. Machine CORS for the upload path omits PUT
- src/lib/csrf-origin-check.ts:23 + src/middleware.ts:12,34-37
- Adding `/api/v1/media/uploads/` to machine endpoints moves it to `setMachineCors`, whose `Access-Control-Allow-Methods` is `GET, POST, DELETE, OPTIONS`. Any browser-based uploader (e.g. a future Studio drag-drop using the ticket URL) fails preflight. curl is unaffected. Add PUT to the machine allow-methods list or special-case this path.

## Verified non-issues
- SSRF (media_import): https-only, no credentials, `redirect: 'manual'` (3xx -> 502), 20 s timeout covers body, bounded read, admin-only. Workers fetch cannot reach RFC1918/metadata. Acceptable for an admin tool.
- SVG/XSS: bytes sniffed by magic, content type set from sniff, served from separate cookie-less origin media.zuey.me. Polyglots served as image/* are not rendered as HTML. Consider `X-Content-Type-Options: nosniff` via R2 custom-domain transform rule (defence in depth, optional).
- Token: 32 random bytes base64url, SHA-256 stored, 15 min TTL, conditional single-use claim. CSRF exemption safe: endpoint honours no cookies.
- Read-only keys: refused on REST (policy.ts:161 -> anonymous) and MCP (`authenticateAdmin`); covered by tests at tests/media-upload.test.ts:137, 222.
- `decodeBase64Image` length bound applied before `atob` (~2.8 MB string max).
- Markdown alt: `[`/`]` stripped; URL is server-generated.

## Recommended actions
1. M1: upsert on sha256 (also removes main L1 trigger).
2. M3: clamp sniffed dimensions to `LIMITS.imagePixels`.
3. M2: include `courses.cover_url` in reference check (or narrow the contract text).
4. M4: Content-Length precheck before `formData()`.
5. Low items as follow-up issues per AGENTS.md (do not widen the PR unless trivial).

## Metrics
- Type check: 0 errors, 0 warnings (astro check)
- Tests: 12/12 pass for media; no test for concurrent dedupe, oversize dimensions, course-cover reference, or multipart path
- Lint suppressions / `any`: none found

## Unresolved questions
- Is the upload URL intended for browser clients ever (affects L5)?
- Is `media_delete` meant as a takedown mechanism (affects L2 cache purge)?

Status: DONE_WITH_CONCERNS
Summary: No critical/security defects; auth, token burn and SSRF posture verified. Four medium issues (concurrent duplicate upload 500 verified empirically, delete ignores course covers, unbounded dimensions break the returned block, multipart buffers before size cap) should be fixed before marking done.
