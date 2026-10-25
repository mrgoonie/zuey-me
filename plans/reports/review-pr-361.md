# Review: PR #361 (fixes #359) — do not restore a category deleted during an update

Head reviewed: `096a2cf03f36d6ca47463f37b27d3af561bbcbd2` (merge base = current `origin/main` `36043f3`).
Reviewer: isolated agent, detached worktree `%TEMP%\rv361`.

## Verdict: MERGE

No High or Medium findings. All the author's claims checked out.

## Gates

| Gate | Result |
| --- | --- |
| Diff scope | 2 files: `src/lib/blocks/articles.ts` (+28/-12), `tests/article-update-atomic.test.ts` (+66/-3) |
| Fail-on-main (main's `articles.ts` + PR tests) | 77 pass / **7 fail** (the tightened #358 test fails for both update writers; the new tests fail for leave-alone and same-category updates, normal and fallback each, and for the create case). This matches the PR body |
| Focused `tests/article-update-atomic.test.ts` | 84 pass / 0 fail |
| All 12 `tests/article*.test.ts` files | 251 pass / 0 fail |
| Full `bun test` | 2221 pass / 0 fail (118 files) |
| `bun run build` | astro check 0 errors, 0 warnings, 90 hints (already on main); build complete |
| `gh pr checks 361` | Test & Build: pass (3m9s) |
| Probe (temporary test, deleted) | `category: null` clears the stored column to NULL; a move to another live category is stored and read back; an update that leaves the category alone keeps the live category; a create without a category stores NULL. All pass |

## Claim verification

- **LIVE_CATEGORY in both writers, inside the batch.** `articles.ts:782` defines `CASE WHEN EXISTS (SELECT 1 FROM knowledge_categories WHERE id = ? AND deleted_at IS NULL) THEN ? ELSE NULL END`. It is used in the create insert (`articles.ts:921-923`) and the update bump (`articles.ts:1012-1014`). Both run in the same `db.batch` as the other writes.
- **Bind order is correct.** Create binds `(id, slug, title, excerpt, access, docJson, categoryId, categoryId, now, now)`, which matches `VALUES (?, ?, ?, ?, ?, '[]', ?, 'draft', ?, 1, CASE…?…?, ?, ?)`. Update binds `(nextSlug, primary, access, categoryId, categoryId, now, art.id, expected)`, which matches `slug, locale, access, CASE(?,?), updated_at, WHERE id, revision`. Both CASE placeholders take the same value, so even a swap would be harmless. The probe and the move test confirm the right id is stored.
- **`category = null`.** `id = NULL` is never true, so `EXISTS` is false and the CASE yields NULL. The probe confirms this.
- **Delete order (`categories.ts:126-130`).** The delete runs the soft-delete `UPDATE knowledge_categories SET deleted_at` (126), then `SELECT id FROM articles WHERE category_id = ?` (129), then `UPDATE articles SET category_id = NULL` (130). These are **separate statements, not one batch**. The order still covers every interleaving, because each article write is one atomic batch:
  - commit before 126: the category is still live, so the id is stored, and 130 then clears it;
  - commit after 126: `EXISTS` is false, so NULL is stored;
  - commit between 129 and 130: NULL is stored, and the article reindexes itself after its commit.
- **Already-deleted category returns 400.** `getCategory` filters `deleted_at IS NULL` (`categories.ts:67`), so `resolveCategoryRef` throws `400 unknown_category`. A new test covers this for both update and create.
- **Mid-flight delete clears silently.** The read-back helpers (normal read-back and fallback) report `category_id: null` and `category: null`. Tests cover both paths.
- **Helper extraction.** `unrevisionedRead`/`unrevisionedFields` (`articles.ts:829-839`) are a mechanical split of the old inline code in `commitAtRevision`. The conflict check still indexes `results[writes.length]` (the bump), and the read is still the last statement. No other behaviour changed. In create, `unrevisionedRead` is also the last batch statement (after the tag inserts), so `unrevisionedFields` reads the right result. The fallback `art` spreads `...committed` last, so it reports the committed `categoryId`/`labelRevision`.
- **The #358 in-batch read-back still sees the committed value.** The read is last in the same batch, so it reflects the CASE result. The tightened #358 test now asserts `category_id: null` in both the fallback and the stored row.
- **Other writers.** Searching `src` for `category_id =` and `INSERT … category_id` finds only `articles.ts:921` and `:1012` plus the delete's clear. Publish, edition delete and tags set never write the column. Categories have no undelete path; only tags have one, at `tags.ts:143`.
- **No API or doc change.** No endpoint, OpenAPI or docs file was touched. The `category` contract ("id or slug; null clears") is unchanged.

## Findings

- **Low — no regression test for explicit `category: null` under the new expression.** `tests/article-update-atomic.test.ts`. The probe proves it works, but nothing in the suite pins it now that the column goes through a CASE. A one-line assertion would lock it in. Optional.
- **Low (already on main, out of scope) — the category delete is not atomic.** `src/lib/taxonomy/categories.ts:126-130`: soft-delete, select and clear are three separate round trips. If the clear fails after the soft-delete, articles keep a dangling id. With this PR, the next update or create self-heals it to NULL, which is an improvement. Batching 126 and 130 would remove the window entirely; worth a separate issue if wanted.
- **Low (design note, acceptable) — silent null vs. error.** When a request explicitly names category X and X is deleted mid-flight, the save succeeds as uncategorized instead of failing. The response honestly reports `category_id: null`. The outcome is the same as the delete committing just after the save, which it would also clear. An error would need a guard on every statement in the batch (edition and history rows are guarded only by revision). The trade-off is sound.
- **Nit:** the test file still has no trailing newline (already the case on main).

## Cleanup

Probe test deleted; `dist/`, `.wrangler/` removed; worktree `%TEMP%\rv361` removed.
