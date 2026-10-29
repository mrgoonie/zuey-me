# Review: PR #358 (fixes #297)

Head `9ecb1b41e9811972a8097d948796b2f454b36e58`, base `origin/main` 5e122a4. Isolated reviewer, worktree `%TEMP%\rv358`.

## Gates

| Gate | Result |
| --- | --- |
| Diff stat | 4 files, +130 / -17 (`src/db/store.ts`, `src/lib/blocks/articles.ts`, `tests/article-update-atomic.test.ts`, `tests/helpers/d1.ts`) |
| Fail-on-main (main's `articles.ts` + `store.ts`, new tests kept) | 10 fail / 67 pass: the 5 pipelined-409 and 5 label/category cases fail; the 5 three-edition fallback cases pass on main (expected) |
| Focused (12 `tests/article*.test.ts` files) | 244 pass, 0 fail |
| Full `bun test` | 2192 pass, 0 fail, 118 files |
| `bun run build` | astro check 0 errors, 0 warnings, 83 hints; build Complete |
| `gh pr checks` | Test & Build: pass |

## Claims verified

- **Early 409.** `requireReadAtExpected` (`src/lib/blocks/articles.ts:832`) runs right after `loadArticleRow` in update (948), publish (1055), edition delete (1113) and tags set (1164). It runs before any write, uses the shared `revisionConflict` envelope and puts the revision it read in `current_revision`.
- **Race consistency.** After the pre-check, `art.revision === expected`. If a save lands between the check and the commit, the bump guard (`revision = expected`) still loses and `conflict()` re-reads the current revision. Both paths give the same 409 shape with a fresh `current_revision`. The pipelined test shows the concurrent hook never fires (`concurrent === false`) and the stored row is unchanged.
- **In-batch SELECT placement.** `commitAtRevision` (814-825) adds the SELECT after writes, bump and derived statements. D1 runs a batch's statements in order inside one transaction, so the SELECT sees the committed values. The bump index `results[writes.length]` does not change. When the bump loses, `conflict()` throws first and the SELECT result is never used.
- **All fallbacks covered.** Update (1019), publish (1096) and edition delete / tags set (both through `unchangedEditionShown`, 1135) merge `committed`. Create (928) writes `label_revision: 0` and `categoryId` in its own batch, so it is exact without the SELECT. `article-cover.ts` has its own revisioned writer but no read-back fallback, so it is outside #297.
- **D1 semantics.** Cloudflare D1 `batch()` returns `D1Result[]`, and each result carries `results` (rows for a SELECT), `success` and `meta`. The optional `results` on `D1RunResultLike` matches this. The helper now returns `.all()` rows for SELECT statements in `runSync`. That path also serves `run()`, which matches D1's `run()` (it returns `results` too). The full suite stays green, so the helper change does not affect other tests.
- **Edition filter.** `editions.filter(e => e.locale !== locale)` is equivalent to the old identity filter and more robust.
- **No doc/OpenAPI/MCP change needed.** Agreed. See error precedence below.

## Error precedence (behaviour change)

A stale `expected_revision` now returns 409 before other validation: missing-title-for-new-edition 400, `slug_taken`, bad `primary_locale` 400, `primary_edition` 409, missing edition 404, unknown tags. Publish still checks `confirm` and `expected_revision` shape (400) first, and a missing article is still 404 first.

I found no documented precedence between `revision_conflict` and validation errors in `docs/agent-article-playbook.md`, `docs/idempotency-keys.md`, `src/lib/blocks/mcp.ts` or the OpenAPI fragments. The playbook already tells clients to reload on 409, and any validation error sent with a stale revision would have 409'd on the corrected retry anyway. **Acceptable.**

## Findings

### High
None.

### Medium
- **Pre-existing, not introduced here: `updateArticle` writes back a deleted category id. Confirmed by probe.** At `src/lib/blocks/articles.ts:969`, `categoryId` is resolved before the commit: `art.categoryId` when the request leaves category alone, or `resolveCategoryRef` (which checks the category is live) when it sets one. The bump at 996-998 writes `category_id = ?` unconditionally. `deleteCategory` (`src/lib/taxonomy/categories.ts:126-130`) soft-deletes the category and then nulls `articles.category_id` without bumping the article revision, so the revision guard does not catch it. There is no FK (`migrations/0009_knowledge_taxonomy.sql:10`) and the delete is soft anyway. Probe results, on both PR head and main:
  - Request does not change category, category deleted between read and commit: stored `category_id` is the deleted category's id (`knowledge_categories.deleted_at` set). Normal `getArticle` returns it too.
  - Request sets `category: 'guides'`, category deleted between resolve and commit: the same write-back.
  Worth its own issue. A possible fix is to write `category_id` only when it is still live, for example `category_id = (SELECT id FROM knowledge_categories WHERE id = ? AND deleted_at IS NULL)`, or to have category delete bump the revision of affected articles.

### Low
- **The new test hides that bug for update writers.** `tests/article-update-atomic.test.ts` (case "...after a label write and a category delete in between") asserts `label_revision: 1` and that the fallback equals the stored row. It never asserts `category_id` is null. For the two update writers both sides hold the resurrected id, so the test passes while encoding the bug. When the follow-up issue is fixed, add `category_id: null` to the `storedArticle()` expectation.
- **Helper SELECT detection is narrow.** `tests/helpers/d1.ts:33` matches `^\s*SELECT` only. `WITH ... SELECT`, a leading SQL comment or `... RETURNING` would get no rows, while real D1 returns them. No current caller is affected.
- **Cast in the helper.** `rows as Record<string, unknown>[]` (`tests/helpers/d1.ts:35`) is a whole-array cast, not a member-access cast, and mirrors the existing `rows as T[]` in `all()`. It is a test helper. Nit only.

## Verdict

**MERGE.** It fixes #297 items 1-3 as claimed. Gates are green and fail-on-main is proven (10 fail). The category write-back is real but already exists on main and is outside this PR, so it should get its own issue.
