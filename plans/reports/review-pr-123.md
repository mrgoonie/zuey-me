# Review: PR #123, warn and confirm before saving recovered drafts (closes #112)

Head `8b8e1e25a2a0243226e24d88e74e180e1b58e3cb`. The reviewer did not write this change.

## Verdict

**Approve.** No blocking or medium findings. Two low-severity notes are listed below. Neither needs to block the merge.

## Gates (head merged locally with origin/main, no conflicts)

- `bun install --frozen-lockfile`: OK.
- `bun test`: 920 pass, 0 fail.
- `bun run build`: 0 errors, 0 warnings (64 hints, all pre-existing).
- **New tests against main source:** both new test files were copied onto origin/main and run there. Result: 1 pass, 9 fail, 1 error (`recovered-draft` module missing). The tests catch the bug.
- No `any` or `as any` in the diff.
- **Browser check:** the author's `check-i112.mjs`, copied to port 4449, with two extra checks added. Run against local `astro dev` and local D1 only (migrations applied with `--local`, then seeded with `seed-i112.ts`).
  - **Lossy draft:** the banner shows. The save button and Ctrl+S both ask for confirmation. Dismissing either one keeps revision 1. Accepting saves revision 2 with blocks `p1, e1`, then `recovery: null` and the banner is gone.
  - **Unreadable draft:** the banner shows. The button and Ctrl+S both ask. Cancelling writes nothing.
  - **History restore of a lossy r1:** the history panel and the editor both show the warning. Cancelling keeps `p0` at revision 1. Accepting saves revision 2 and the warning clears.
  - **Clean draft:** after editing and pressing Ctrl+S, 0 dialogs and the save goes through (revision 3). No extra prompts for clean drafts.
  - No page errors.
  - The dev server was stopped (my process tree only).

## Claims checked

- **No leak to non-admins.**
  - In `getArticleView` (`src/lib/blocks/articles.ts:563-579`), `recovery` is added only in the `draft` branch, and that branch requires `viewer.isAdmin`. The reader branch builds its object explicitly.
  - `toSummary` (`articles.ts:360`) strips `draft_recovery`, so write responses (create, update, edition delete, AI attach) never carry it.
  - MCP `article_get` refuses `draft` for non-admins. The revisions REST route calls `requireAdminActor`.
  - The SSR `/articles/[slug]` page passes `draft` only when previewing as an admin. `.md` never does.
  - Tests cover the reader REST, the admin published view and the MCP reader.
- **Counts match the lenient parse.**
  - `readStoredDocWithRecovery` (`articles.ts:175-185`) maps `readStoredDocument` (`validate.ts:552`) directly: `dropped` becomes `dropped_blocks` and `degraded` becomes `degraded_embeds`.
  - `unreadable` follows the same rule that `requireStoredDraft` already uses: bad JSON, or blocks were dropped and none are left.
  - The display result is unchanged from `parseStoredDoc` (`doc ?? emptyDocument()`).
- **Every Studio path that writes the document is covered.**
  - `save()` (`ArticleEditor.tsx:1051-1059`) is the only Studio call that sends the document (PUT or POST). The button, Ctrl+S (`:1096`, through `saveRef`) and the conflict "overwrite" path (`:1109`) all go through it.
  - There is no autosave. The `#111` `ImageSizeProbe` `onSize` callback only changes local state, which marks the draft dirty. It never saves.
  - Publish (`articles.ts:793`) copies the raw `draft_json` to `published_json` on the server, so publishing loses nothing.
  - Creating a new language edition uses the fallback, which never inherits recovery (`ArticleEditor.tsx:849`). That is correct, because the save writes a new edition and overwrites nothing.
- **OpenAPI and MCP docs are accurate.** The spec is 3.1.0, so `type: ['object','null']` and `$ref` with a sibling `description` are both valid. The draft view and the revision document both reference `DocumentRecovery`, and both MCP tool descriptions explain the field.
- **Vietnamese copy is correct.** Diacritics in the banners, the confirm questions and the cancel status ("Chưa lưu: bản nháp đã lưu được giữ nguyên.") were checked in the rendered UI.

## Findings

### Low

1. **Conflict overwrite uses a stale `recovery`** (`src/components/studio/ArticleEditor.tsx:1103-1110`). `overwrite()` re-reads the latest draft only to get its revision. Then `save()` asks the confirm question using the recovery state of the draft that was originally loaded.
   - If the draft saved elsewhere has a different recovery state, the question can be wrong:
     - It may be asked when nothing would now be lost.
     - Worse, it may be skipped when the newer stored draft is the one that needs recovery. The user has already confirmed the overwrite in its own dialog, so this exposure is small.
   - Suggested fix: in `overwrite()`, update `editing.recovery` from `parseDraftRecovery(res.data.recovery)` before calling `save`.
2. **Out of scope, pre-existing: attaching a Zuey AI artifact to an article writes the recovered draft without warning** (`src/lib/ai/admin-chat.ts:56-61`). The attach flow builds `[...article.draft.blocks, newBlock]` from the recovered draft and saves it with `updateArticle`. That makes the drop permanent, with no warning or confirmation.
   - This is a server path, not the Studio editor that #112 covers. It should get its own follow-up issue (for example: refuse or warn when `article.draft_recovery` is not null). It should not widen this PR.

## Cleanup

- The temporary main worktree, the `rv123` worktree (including its `.wrangler` and `dist`) and the dev log were all removed.
- No remote D1, secrets, deploys, pushes, merges or label changes.
