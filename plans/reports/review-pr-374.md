# Review: PR #374, fix(taxonomy): update legacy article tag names in the tag rename batch

Closes #371. Reviewed head `2f2e6b1` on base `9198b18` (current `origin/main`) in an isolated worktree. Date: 2026-10-25 (Asia/Saigon).

## Summary

The rename `UPDATE topic_tags` and the legacy `articles.tags` rebuild now run in one `db.batch`, with the rename first, so the rebuild reads the new names inside the same transaction. The SQL name resolver now matches `localizedName(parseNames(...))` on every input I probed, with one exception that cannot occur in practice (lone surrogates). The test casts are gone. I found no High or Medium issues.

## Verification

| Check | Result |
| --- | --- |
| New tests against `main`'s `tags.ts` | 6 fail / 27 pass: the 4 new regressions, plus the 2 race tests, which now hook `db.batch` (expected) |
| Focused (`taxonomy-delete-atomic`, `tag-create-concurrent`) on PR | 33 pass, 0 fail |
| `bun test` | 2272 pass, 0 fail (121 files) |
| `bun run build` | astro check 0 errors, 0 warnings; build complete |
| `gh pr checks 374` | Test & Build: pass |

### SQL vs JS parity probe (bun:sqlite 3.53.2)

I tagged one article with 94 tag name shapes and ran `mirrorLegacyTags` for the locales vi, en, ja and xx, then compared the result with `localizedName(parseNames(names), locale, slug)`. The shapes:
- every JS-trim whitespace character, alone and padding a value
- characters trim keeps: U+180E, U+0085, U+200B/C/D, U+2060, NUL, U+001C, U+001F
- escaped keys (`"en"`) and escaped values
- duplicate keys: 3 copies, a duplicate set to null, an object or a blank, an escaped duplicate (`{"en":"A","en":"B"}`)
- nested objects and arrays, and a nested `en` key under another key
- non-object roots: array, number, string, null, `''`
- invalid JSON, JSON5 (`{en:'Five'}`), a trailing comma
- booleans and numbers, unknown locales only, `__proto__`, padded values, whitespace around the document

Only one shape differed: a lone surrogate (`"\ud800"`). JS keeps the lone surrogate; SQLite stores U+FFFD. UTF-8 storage cannot hold that character anyway, and `UNSAFE_TEXT_RE` plus `safeText` keep it out of API input. Not a finding.

The probe confirmed:
- `json_each` returns every duplicate key in document order. `ORDER BY j.id DESC` picks the last one (since 3.45 `j.id` is the JSONB byte offset, so ids increase through the document).
- `json_each` returns unescaped keys.
- `json_valid` rejects JSON5.

### Performance probe

I set up 3000 articles with 20 tags each and called `updateTag` with a stale revision. It runs the pre-checks and the full batch, including the rebuild, then returns 409 before reindexing. Total time was about 196 ms. One statement replaces the old per-article loop, so this is faster than `main`.

## Findings

### High
None.

### Medium
None.

### Low

1. **The audit row is still written outside the transaction** (`src/lib/taxonomy/tags.ts:207`). A crash after the batch commits leaves a renamed tag with no `tag.update` audit row. The new test "a crash after the commit…" records this behaviour without flagging it. This is not a regression: `main` also wrote the audit after the rename, and `createTag` does the same (`tags.ts:157`). `deleteTag` already audits inside its batch via `auditLogStatement` with a guard. Doing the same here would need a guard on "this batch's update applied", for example `revision = expected + 1 AND updated_at = now`. That belongs in a separate issue, not this PR.

2. **A stale-revision 409 now writes `articles.tags` for every tagged article** (`tags.ts:195-204`). The rename is a no-op, but the rebuild still runs, recomputing from current state and rewriting the same values. The data stays correct and there are no triggers on `articles` (I checked `migrations/*.sql`), so this costs only D1 write units, roughly N row writes per rejected rename. `deleteTag` already accepts the same cost. One more effect: if an earlier article-side `afterCommit` mirror had failed, this path quietly repairs the column. That is harmless.

3. **The comment in the PR body and at `tags.ts:194` is slightly too strong.** "When the rename does not apply, the rebuild leaves the column as it was" holds only if the column was already consistent; otherwise the rebuild normalizes it. Wording only.

4. **Can't confirm the D1 engine version locally.** Parity relies on `json_valid(X)` rejecting JSON5 and on `json_each` ids increasing in document order. Both hold on SQLite 3.45 and later; production D1 runs a newer version, but I could not check it from here. `trim(X, Y)` with multi-byte characters, `char(...)` and `json_each` are core SQLite functions and work in D1.

5. **Out of scope, already on `main`:**
   - `tests/tag-create-concurrent.test.ts:101` still has `ctx as unknown as Parameters<APIRoute>[0]`. AGENTS.md forbids `as unknown` casts, but this line is not in the diff.
   - The article-side legacy mirrors (`src/lib/blocks/articles.ts:943,1027,1187`) still run in `afterCommit`, outside their tag-assignment write. That is the same class of gap as #371, on the article path, and worth its own issue if one does not already exist.

## Checks on specific concerns

- **Atomicity and order.** The rename comes first, the rebuild second, in one batch. The crash-at-rename and crash-at-rebuild tests both leave the tag unrenamed and the legacy column intact. The single-batch test asserts that no `UPDATE topic_tags` or `SET tags` statement runs outside the batch.
- **Stale revision.** The result is `409 revision_conflict` with `current_revision`. `res?.meta?.changes` reads the rename's own result (index 0). The legacy column is unchanged, and the test covers this.
- **Unique-violation mapping inside a batch.** Both the test helper and D1 surface a failed batch statement as a rejected batch whose message contains `UNIQUE constraint failed: topic_tags.slug`, so `isSlugViolation` and `slugOwner` still apply. Errors from other indexes pass through raw.
- **Race tests.** The first test still inserts a real conflicting row between the pre-checks and the batch, so SQLite raises a genuine UNIQUE violation inside the transaction. The second test was simulated before and is simulated now. Neither test is weaker than before. Moving the hook to `beforeBatch` is required because the rename no longer calls `.run()`.
- **TS rules.** The `src` diff has no `any` and no casts. In `taxonomy-delete-atomic.test.ts`, every inline cast is gone: rows go through `isObj`, `str`, `strOrNull`, `num` and `parseStringArray`, and `rowOf` returns `{}` when there is no row. The `intercept` additions are typed.

Verdict: MERGE
