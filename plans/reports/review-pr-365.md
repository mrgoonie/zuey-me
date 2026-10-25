# Review: PR #365 (fixes #363), head f1b600f

Isolated review. I checked out the head in a separate worktree and confirmed the author's claims by reading the code and running probes.

## Gates

| Gate | Result |
| --- | --- |
| Diff vs `origin/main` | 5 files, +187 / -27 (3 taxonomy sources, 1 new test file, 1 test edit). Matches the claim. |
| Fail-on-main (main's `categories.ts`, `common.ts`, `tags.ts` + new test file) | 9 fail / 4 pass of 13. These fail: crash at the read, the clear/unassign and the audit for both terms; the post-commit crash for both; and the "one batch" spy. The crash-at-mark and stale-revision cases pass on main as expected. |
| Focused (`taxonomy-*`, `knowledge`, `article-*`, 14 files) | 334 pass / 0 fail |
| Full `bun test` | 2245 pass / 0 fail, 120 files |
| `bun run build` | `astro check`: 930 files, 0 errors, 0 warnings, 93 hints (hints are in tracked `plans/` demo JS that predates this PR). Build complete. |
| `gh pr checks 365` | Test & Build: pass (2m57s). Mergeable, CLEAN. |
| Reviewer probes (deleted afterwards) | 2/2 pass. (a) Tag delete, then restore through `createTag` with the same slug (same id), reassign, then a stale pre-restore-revision delete: 409, assignment kept. Then a fresh delete: unassigned, 2 `tag.delete` audit rows, legacy `articles.tags` = `[]`. (b) Repeating a category delete: 404, still 1 audit row. |

## Claims verified

- **Category delete** (`src/lib/taxonomy/categories.ts:126-138`): one `db.batch` of 4 statements: mark, `SELECT id FROM articles`, guarded clear, guarded audit. A stale revision gives 409 and writes nothing (tested). The reindex runs after commit over `attached.results`. It still returns `void`, so the API responses are unchanged.
- **Tag delete** (`src/lib/taxonomy/tags.ts:216-232`): mark, read, guarded `DELETE FROM article_tags` and guarded audit run in one batch. `mirrorLegacyTags` and the reindex run after commit.
- **Label delete**: untouched. It refuses with `409 label_in_use` while any article uses the label (`labels.ts:235`), so it has no detach step to make atomic.
- **Helpers** (`common.ts:145`, `:161`): `auditLogStatement` turns `INSERT ... VALUES` into `INSERT ... SELECT ... WHERE 1` when no condition is given, which inserts exactly one row as before. `writeAuditLog` (13 other call sites) behaves the same. `SqlCondition` already exists in `src/db/store.ts`.
- **Tests**: the new file covers a crash at each batch statement, a post-commit crash, the shape of the single batch, and a 409. The `category: null` test in `article-update-atomic.test.ts` is meaningful, because the `post` fixture starts in category `guides`.

## Judged points

1. **The `softDeletedAt` guard** checks `revision = expected + 1 AND deleted_at = <this call's now>`. A D1 batch is one serialized transaction, so the only state the guard can see is the one left by the batch's own first statement or by an earlier commit.
   - Repeated delete: `getCategory`/`getTag` filter `deleted_at IS NULL`, so the call is a 404 before any batch runs (probe b).
   - Delete, restore, re-delete: restore bumps the revision and nulls `deleted_at`, so a re-delete with the new revision works. A stale pre-restore revision fails both the mark and the guard (probe a).
   - Delete racing a restore: they are serialized. If the restore commits first, the mark fails on revision and the guard fails too. If the delete commits first, the restore applies to a fully detached tag, the same as sequential execution.
   - The only false positive: two deletes with the same expected revision whose `nowIso()` lands in the same millisecond. The losing call's guard matches the winner's row, so it writes a second audit row and re-runs a no-op clear, then returns 409. See L1.
2. **In-batch read**: it is index 1, after the mark and before the clear, so it captures the ids before they are nulled. Destructuring `[mark, attached]` matches D1's in-order results. Taking `.meta.changes` from index 0 is right. The read runs even on conflict, but its result is ignored (cheap).
3. **Stale `articles.tags` after a crash**: real but low impact. Pages, lists, filters and receipts read `article_tags` via `tagsForArticles` and skip deleted tags. The one live reader of the text column is AI chat retrieval (`src/lib/ai/context.ts:202`), where a deleted tag name can still add tag-term weight to an article's score until its next write. It cannot be seen on the page and it is not a regression: main also mirrored after the deletes, outside any transaction.
4. **Old callers expecting audit rows on no-op**: none. On main the 409 was thrown before `writeAuditLog`, and the 404 path is unchanged. No test or caller expects an audit row for a delete that did not apply.

## Findings

- **Low (L1)** `src/lib/taxonomy/common.ts:161`: the guard keys on a millisecond timestamp rather than "this statement changed a row". Two concurrent deletes in the same millisecond with the same expected revision write a duplicate `*.delete` audit row for the losing 409 call. Data is unaffected. Possible hardening: give `deleted_at` a per-call unique token, or accept the risk. Not blocking.
- **Low (L2)** `src/lib/taxonomy/tags.ts:229`: a crash between commit and `mirrorLegacyTags` leaves a deleted tag's name in `articles.tags`. Only AI retrieval ranking reads it (see point 3). This predates the PR. It could be tracked separately if the legacy column is kept long term.
- **Low (L3)** `tests/taxonomy-delete-atomic.test.ts`: no test covers restore followed by re-delete. My probe passes, so this is a coverage gap only.

No High or Medium findings.

## Verdict

**MERGE.** It fixes #363 as specified, fails on main (9/13), and is green locally (334 focused, 2245 full, build 0/0) and in CI.
