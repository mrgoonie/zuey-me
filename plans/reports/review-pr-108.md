## Review of PR #108 (closes #102), isolated reviewer

**Verdict: APPROVE.** Nothing blocks the merge. One medium follow-up is listed below, and it is not a regression.

Reviewed: `origin/fix/102-stored-block-parsing` @ 15736f3, compared with `origin/main`.

### Findings, most severe first

1. **Medium (follow-up, not a regression): a Studio save still persists whatever the lenient read recovered.**
   - `src/components/studio/ArticleEditor.tsx:1039` always sends `document: d.doc`. The editor loads the recovered draft from `getArticle` (`src/lib/blocks/articles.ts:437`).
   - So any Studio save, even one that only changes the title, writes the recovered document. Invalid blocks are dropped, and an all-invalid draft is saved as `blocks: []`. The 409 guard never fires for Studio because a document is sent.
   - The admin view carries no recovery signal, so neither the admin nor the server can tell that this happened.
   - This matches the PR's stated contract ("unless the caller sent one"), and it is better than `main`, which loaded an empty document.
   - Suggested follow-up issue: expose recovery counts (dropped and degraded) in the admin article view. Studio should then warn, and refuse to save an unreadable draft unless the admin confirms.
2. **Low: the metadata-only update refusal is stricter than it needs to be.**
   - `src/lib/blocks/articles.ts:676`: the raw `draft_json` is now kept byte for byte and snapshotted raw, so a metadata-only update can no longer blank anything.
   - The 409 still blocks access, tag, slug and title changes on an article whose draft is unreadable, until a full document is sent.
   - This is a defensible, documented trade-off. Raising it only for awareness.
3. **Nit: ids of nested children stay reserved when their parent is dropped.**
   - `src/lib/blocks/validate.ts:141` frees only the rejected block's own id. Ids of children that were parsed before their parent was rejected stay reserved.
   - A probe confirmed it: a dropped toggle whose child is `c1`, followed by a valid top-level `c1`, drops both.
   - This is unreachable for documents that passed strict validation when written, because their ids were unique.
4. **Nit: no unit test covers an invalid block nested inside a `layout`.** Only the toggle case is tested. I verified the layout case by probe and live (below).

### Security
- An embed whose provider is not in the enum, or does not match its URL, is degraded to `generic`.
- A `generic` embed cannot produce an iframe: `embedSrc` returns null unless `detectProvider(url) === provider`, and the `generic` case returns null. The probe also covered `https://evil.example` stored with provider `youtube`, and an unknown provider string.
- A dropped nested block leaves its parent valid. A layout keeps the same number of children, and a child's `blocks` may become `[]`, which strict validation already allows. The recovered document passes strict `validateDocument`.
- SSR rendered with no iframe and no `youtube-nocookie`.
- Warnings contain only counts, never document content.

### Data safety (write paths that read stored JSON)
- **Publish:** `published_json = draft_json` (raw). The revision snapshot is `edition.draftJson`. A 409 is returned before the revision bump.
- **Update without a document:** a 409 is returned before the revision bump. Otherwise `draft_json` is written back raw.
- **`delete_edition`:** snapshots raw.
- **Revert:** this is Studio-side only. It views a revision, then saves, which sends a document. See finding 1.
- **Label and taxonomy audit:** they only read (`blockExists`, candidate text). They write labels, never documents.
- **Search indexer and AI context:** read only.
- **Lessons:** untouched. They are envelope-only and copy raw JSON.

### Changed tests (`tests/social-embeds.test.ts`)
Both changes are legitimate, and both are stronger than before:
- The noscript test now asserts no `href` inside the noscript and exactly one "Mở bài gốc".
- The opt-out test now asserts `disabled` plus `visibility:hidden`.

The DOM tests add hydration visibility, the provider options and hint, and a `flatMap` list replacement.

### Gates
- `bun install --frozen-lockfile`: OK.
- `bun test`: **857 pass, 0 fail** (47 files).
- `bun run build`: astro check gives **0 errors, 0 warnings**, 63 hints. The build completed. The only Vite `[WARN]` is the pre-existing `block-icons.tsx` chunk note.

### Live check
Setup: local D1 (migrations applied with `--local`), dev server on port 4440, Chromium through playwright-core.

**Public page `r108-recovered`**, seeded with a YouTube URL stored as `vimeo`, a heading with level 9 inside a layout column, a bad-host embed inside the layout, and valid paragraphs:
- JS off and JS on: status 200, no page errors.
- The intro, the paragraph inside the layout and the outro all render.
- The invalid heading is absent.
- **0 iframes.** Both embeds render as "Mở liên kết" links.
- The layout renders.

**Admin API** (local admin key from `createApiKey`, never printed):
- Publishing the all-invalid draft returns **409 `stored_document_unreadable`**.
- A metadata-only update of the same article also returns 409.
- Afterwards the revision is still 1, `published_json` is still NULL and the stored draft is unchanged.
- A metadata-only update of `r108-meta` (whose draft contains the degraded document) returns 200 at revision 2. The stored `draft_json` is **byte-identical** to the seed, and so is the `save` revision snapshot.

### Cleanup
- The dev server process tree was stopped (astro.exe → node and its children).
- No remote D1, secrets or deploys were touched.
