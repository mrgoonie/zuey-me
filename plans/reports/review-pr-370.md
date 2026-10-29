# Review: PR #370 — fix(taxonomy): update legacy article tag names in the tag delete batch

Closes #367. Head `f5cb568`, base `56720a6`. Files: `src/lib/taxonomy/tags.ts`, `tests/taxonomy-delete-atomic.test.ts`.
Reviewed in an isolated worktree (`%TEMP%\rv370`) by a reviewer that did not write the change.

## Evidence

| Check | Result |
| --- | --- |
| New tests against `main`'s `tags.ts` | 3 fail, 15 pass: the in-batch crash, the post-commit reindex crash, and the one-batch check. The restore/re-delete tests pass on main too, so they only add coverage, as the issue says. |
| `bun test tests/taxonomy-delete-atomic.test.ts tests/tag-create-concurrent.test.ts` (PR head) | 28 pass, 0 fail |
| `bun test` (PR head) | 2253 pass, 0 fail, 120 files |
| `bun run build` | exit 0; astro check 0 errors, 0 warnings, 97 hints |
| `gh pr checks 370` | Test & Build: pass |
| Mergeability | CLEAN. `main` has moved on by #368, which touches only course files and does not conflict. |

### Old JS vs new SQL probe

I wrote a throwaway test and removed it afterwards. It ran `main`'s JS `mirrorLegacyTags` logic and the new SQL statement on the same rows and compared the stored strings byte for byte:
- 29 `names` shapes: valid, `{}`, invalid JSON, arrays, a bare JSON string or number, `null`, non-string values, nested objects, escaped quotes and backslashes, `\u` escapes, JSON-looking strings, padded text, emoji, JSON5 or trailing-comma text, an uppercase key, an empty string, whitespace-only values, duplicate keys.
- Article locales `vi`, `en`, `ja`, `ko`, `zh`, `xx`, `''` and `EN`.
- Reversed and gapped positions, two soft-deleted tags, an article with one tag and an article with none.

What matched exactly:
- Every reachable shape.
- Order by `position`.
- Removal of deleted tags.
- An article with no tags stores `[]` (not NULL), the same as before.
- Escaping and non-ASCII output are byte-identical to `JSON.stringify`.

The only differences are the two edge cases in Low 1.

**Query plan for the delete-path statement:**
- The `IN` list uses `idx_article_tags_tag`.
- The correlated subquery uses the `article_tags` primary key, then the `topic_tags` primary key.
- The ordered subquery runs as a CO-ROUTINE with a TEMP B-TREE for its ORDER BY.

So the delete path is one indexed statement where it used to be 3 round trips per article. Performance is better.

## Findings

### High
None.

### Medium
None.

### Low

1. **The SQL differs from `parseNames` for whitespace-only names and duplicate JSON keys** (`src/lib/taxonomy/tags.ts:266`).
   - SQLite's `trim()` strips only U+0020. JS `.trim()` strips all Unicode whitespace.
   - Probe results:
     - `{"en":"\t"}` gave slug `t18` before and `"\t"` now.
     - With article locale `en`, `{"en":" ","vi":"v"}` gave `"v"` before and `" "` now. U+3000 and `\n` behave the same way.
     - `{"en":"a","en":"b"}` gave `"b"` before (JS keeps the last key) and `"a"` now (SQLite keeps the first).
   - None of these can come in through the API. `safeText` trims with JS `trim`, rejects control characters and empty values, and names are written with `JSON.stringify`, so keys are never duplicated.
   - They can come in through the `0009` backfill, which used SQL `trim`, so a legacy tag made only of NBSP would be kept. Manual D1 edits can also introduce them.
   - Effect: in that rare case a whitespace-only string goes into a column that only AI ranking reads. The code comment calls the SQL a "twin" of `localizedName`, which is not quite true. Optionally, pass the extra whitespace characters to `trim()` (for example `trim(x, char(32,9,10,13,160,12288))`) or narrow the comment. This does not block the merge.

2. **The tag order depends on SQLite not flattening the subquery** (`src/lib/taxonomy/tags.ts:283`).
   - `json_group_array` reads an `ORDER BY at.position` subquery. SQLite does not formally guarantee the order in which an aggregate consumes rows.
   - The flattener does refuse to merge an ordered subquery into an aggregate outer query. The query plan above confirms the ORDER BY runs first, and every probe kept the order.
   - The documented alternative is `json_group_array(name ORDER BY at.position)`. It needs SQLite 3.44 or later, and D1's version is not pinned in this repo, so the current form is the more compatible choice. For information only.

3. **The rewrite runs even when the delete returns 409, and a failure in it now fails the whole tag delete** (`src/lib/taxonomy/tags.ts:225`).
   - On a stale revision the statement still rewrites the matched article rows. It is idempotent, so the values stay the same unless the column was already stale, in which case it repairs it. The existing 409 test checks that the legacy list is unchanged.
   - Before, the mirror was best-effort after the commit. Now it shares the transaction, so an error in it (for example a trigger, as `article-create-atomic.test.ts` injects for create) blocks the delete.
   - That is the atomicity #367 asked for, and the statement is deterministic. For information only.

4. **Test style** (`tests/taxonomy-delete-atomic.test.ts`, new `legacy()` helper and the locale test).
   - These add inline casts such as `(d1.raw.query(...).get(id) as { tags: string }).tags`, which the AGENTS.md TypeScript rules forbid.
   - The same file already used this pattern for its `state()` helpers before this PR, and `astro check` passes. Nit.

### Checked and fine
- **Batch order:** mark, then the read of assigned articles, then the legacy rewrite, then the unassign, then the audit row.
- **Batch results:** the legacy rewrite sits after the `assigned` SELECT, so the `[mark, assigned]` destructuring is unaffected.
- **Deleted tag excluded:** the rewrite runs after the mark has set `deleted_at`, so the deleted tag is filtered out while `article_tags` still identifies the affected articles.
- **Other callers keep the same result format and signature:** the article create, update and set-tags paths in `src/lib/blocks/articles.ts:943,1027,1187` (after commit), `refreshTagged` in `tags.ts:127`, and the after-commit trigger-failure tests all still pass.
- **Missing article:** `mirrorLegacyTags` on an article that does not exist is still a no-op.
- **SQL injection:** only fixed `LOCALES` constants and an internal `where` literal are interpolated. The function is not exported.
- **Unused import:** removing `isLocale` from `tags.ts` is correct, since nothing else in the file uses it.
- **D1 support:** `json_valid`, `json_type`, `json_extract`, `json_group_array`, `trim` and `COALESCE` are all core JSON1 functions that D1 supports. Nothing needs SQLite 3.44 or later.
- **Restore and re-delete tests:** the tag test restores through `createTag` with the same slug, and the id stays stable. In both tests the stale revision gets a 409, the current revision deletes, and the audit count ends at 2.
- **Out of scope:** the tag-rename crash gap is tracked in #371 and is not counted here.

Verdict: MERGE
