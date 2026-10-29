# Review: PR #330 (Closes #320), head ff63093

fix(taxonomy): return 409 tag_conflict when a rename takes a deleted tag's slug

## Verdict: MERGE

The fix is correct and narrow. A rename onto a soft-deleted tag's slug now returns `409 tag_conflict` with that tag's `tag_id`, over both REST and MCP. A rename that loses a race is mapped to the same 409. Only the `topic_tags.slug` violation is mapped. The create path and PR #311's reuse semantics are unchanged. No finding blocks the merge.

## Gates (temp worktree `%TEMP%\rv330` at ff63093)

| Gate | Result |
| --- | --- |
| `git diff --stat origin/main...ff63093` | 4 files: `openapi.ts` (+5/-1), `tags.ts` (+25/-6), `knowledge.test.ts` (+28), `tag-create-concurrent.test.ts` (+44/-1). Scope OK |
| `bun install --frozen-lockfile` | ok, 744 packages |
| `bun test tests/knowledge.test.ts tests/tag-create-concurrent.test.ts` | 76 pass, 0 fail |
| Same tests with `main`'s `tags.ts` | 74 pass, 2 fail. Both new conflict tests fail with a raw `UNIQUE constraint failed: topic_tags.slug`; the REST test logs `Unhandled API error`, which is the 500 |
| `bun test` | 2079 pass, 0 fail (117 files) |
| `bun run build` | astro check 0 errors, 0 warnings (76 hints); build complete |
| `gh pr checks 330` | Test & Build: pass (1m56s) |

## Verification

### 1. Rename pre-check (`src/lib/taxonomy/tags.ts:186-190`, `:103-106`)
- `slugOwner` runs `SELECT id FROM topic_tags WHERE slug = ? AND id <> ?` with no `deleted_at` filter. It therefore finds both deleted and live owners and excludes the tag being renamed. The id it returns is the row that holds the unique slug, which is the real owner.
- **No-op rename:** `next.slug === tag.slug` skips the check. The test covers this: the call returns 200 with the same slug.
- **Stale revision:** if the slug is free, or only the names change, the pre-checks pass. The UPDATE then matches 0 rows and returns `revision_conflict` with `current_revision`. The test covers both cases.
- A stale revision combined with a rename onto a taken slug returns `tag_conflict` before `revision_conflict`. That order is the same one `assertNoCollision` already used for live clashes on main, so it is not a regression.

### 2. Error mapping (`tags.ts:113-115`, `:197`)
- `slug TEXT NOT NULL UNIQUE` is the only unique constraint on `topic_tags`, besides the `id` primary key (`migrations/0009_knowledge_taxonomy.sql:88-98`). No later migration touches `topic_tags`.
- Probe on bun:sqlite with the same column shape: the UPDATE throws exactly `UNIQUE constraint failed: topic_tags.slug`.
- The regex `/UNIQUE constraint failed: topic_tags\.slug\b/i` is not anchored, so the D1 wrapper still matches. Probes:
  - `D1_ERROR: UNIQUE constraint failed: topic_tags.slug: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)` gives true. `\b` holds before the `:`.
  - `...topic_tags.slugx` gives false.
  - `...topic_tags.id` gives false.
- Every other error is rethrown unchanged. A test proves that a `topic_tags.id` violation is not mapped.
- The other matchers in the repo, at lines 93, 148 and 839, still match any `UNIQUE constraint failed`. This one is stricter, as intended.

### 3. Shared helpers and the create path (`tags.ts:153`, `:165-176`)
- `createTag` still runs `assertNoCollision`, then `writeTagRow`, and the `ON CONFLICT(slug) DO NOTHING` upsert and deleted-tag restore are untouched. Only the 409 builder moved into `slugConflict`.
- `ensureTag` still keys on `err.code === 'tag_conflict'`, and it decides reuse with `getTag` plus `tagKeys`, not with `error.tag_id`. The concurrent same-name reuse rule and the `C#` versus `C++` rule from #311 hold. All `tag-create-concurrent` tests pass, including the ones from #311.

### 4. OpenAPI (`src/lib/taxonomy/openapi.ts:22-26`)
- `PUT /tags/{id}` now states that a deleted tag keeps its slug reserved, so renaming onto it conflicts. That is accurate.
- `POST` is correctly left alone, because create restores the deleted tag instead of conflicting.

### 5. Tests
- `knowledge.test.ts`: the REST and MCP tests cover a live owner and a deleted owner, and each asserts the owner's `tag_id`. They also cover the no-op rename and a stale revision with and without a rename.
- `tag-create-concurrent.test.ts`: `intercept` with `beforeRun` on the UPDATE inserts a deleted owner after the pre-checks pass. This hits the `.catch` path for real on SQLite.
- Both conflict tests fail on main, as shown in the gates table. The negative mapping test passes on main as well, as expected, because it is a guard.

## Findings

### 1. Low: `error.tag_id` can name a deleted tag that the API cannot fetch
`tags.ts:188-189` and `:197`; also `:153` on create.

**Scenario:**
1. Delete tag A.
2. Rename tag B to A's slug. The request returns 409 with `tag_id = A.id`.
3. `GET /tags/{A.id}` returns 404, because `getTag` filters `deleted_at IS NULL`.

The message `Slug "x" is already used by another tag` does not say that the owner is deleted. Issue #320 asks for the owner's `tag_id`, so the behaviour is correct, but a client cannot act on the id. Restoring A means calling create with the same slug.

**Optional follow-up:** say "a deleted tag" in the message, or note in OpenAPI that `tag_id` may refer to a deleted tag. This does not block the merge.

### 2. Info: small behaviour change on the create race path
`tags.ts:153`. When `writeTagRow` returns false, main called `getTag`, which sees live tags only. If the racing row was already soft-deleted, the 409 carried no `tag_id`. Now `slugOwner` returns that deleted row's id. This case needs a concurrent insert and then a delete, so it is rare and harmless. `ensureTag` does not read `tag_id`, so #311's semantics are unaffected. The PR body says create behaviour is "unchanged", which is true apart from this edge.

### 3. Info: the race path may return 409 without `tag_id`
`tags.ts:197`. If the racing owner renames away before `slugOwner` re-reads the slug, the 409 has empty `extra`. This mirrors the accepted create-path edge noted in the #311 review.

## Cleanup
- The temp worktree `%TEMP%\rv330` was removed, together with its `node_modules`, `dist` and `.wrangler`. `git worktree prune` was run.
- Main's `tags.ts` was swapped in only for the fail-on-main run, inside that temp worktree, and then restored.
- Nothing was pushed. No comments or labels were changed.

Status: DONE
Summary: MERGE. Gates green: focused tests 76/0, full suite 2079/0, build 0 errors and 0 warnings. CI Test & Build passes.
