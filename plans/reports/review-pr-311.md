# Review: PR #311 (Closes #304), head 348f7ce

fix(taxonomy): reuse a tag that a concurrent write created with the same slug

## Verdict: CHANGES

The race fix works and the admin contract still holds. But the new `ensureTag` fallback reuses any live tag whose slug equals the derived slug. Because `slugify` is lossy, an article tag like `C#` now silently attaches to an unrelated existing tag `C++`. Before this PR, that input got `409 tag_conflict`. A probe on real SQLite reproduced it.

## Gates (temp worktree at 348f7ce)

| Gate | Result |
| --- | --- |
| `git diff --stat origin/main...348f7ce` | 2 files: `src/lib/taxonomy/tags.ts` (+40/-11), `tests/tag-create-concurrent.test.ts` (+175). Scope OK |
| `bun test tests/tag-create-concurrent.test.ts` | 6 pass, 0 fail |
| Same tests on `main`'s `tags.ts` | 3 pass, 4 fail (`UNIQUE constraint failed: topic_tags.slug`). The barriers really race |
| `bun test` | 2010 pass, 0 fail (115 files) |
| `bun run build` | astro check 0 errors, 0 warnings (72 hints, none in touched files); build complete |
| `gh pr checks 311` | Test & Build: pass |

## Findings

### 1. High (blocking): lossy slug match silently attaches an unrelated tag
`src/lib/taxonomy/tags.ts:152-160` (`ensureTag`), called from `:223`.

`slugify` (`src/lib/taxonomy/common.ts:110`) turns every non-letter/digit run into `-` and trims it. So `C++`, `C#` and `C` all become `c`, `.NET` becomes `net`, and `Go!` becomes `go`. `resolveTagRefs` reaches `ensureTag` only when the raw value matches none of the existing tag's keys. `assertNoCollision` then throws `tag_conflict` on the slug clash. `ensureTag` swallows that error because `getTag(slug)` finds a live tag, and it returns that tag.

Scenario, reproduced against real SQLite:
1. Admin creates article A with tags `["C++"]`. Tag `c` is created with names `{vi: "C++"}`.
2. Admin creates article B with tags `["C#"]`.
   - On `main`: `409 tag_conflict`, so the admin notices.
   - On this PR: the create succeeds, and article B's tags are `["C++"]`. No new tag is created and no audit row is written.

The PR body calls this a "small behaviour change", using `AI!` vs `ai` as the example. In practice it attaches wrong tags to articles without any error. That corrupts taxonomy data, which then shows up in public facets, feeds and search.

**Suggested fix (keeps both race paths working):** in `ensureTag`, reuse the existing tag only when `tagKeys(existing)` contains `normalizeKey(raw)`. That means the tag would have resolved this ref if the lookup had seen it, which is exactly the concurrent-create case, because both writers send the same raw name. Otherwise rethrow the 409. `ensureTag` would need the raw value, or a check that `names` contains it. Add a test: `C++`, then `C#`, must still return 409.

### 2. Low: `ensureTag` also swallows conflicts caused by a different tag's alias or name
`src/lib/taxonomy/tags.ts:156-158`. `assertNoCollision` stops at the first clashing tag. If tag X owns the candidate's slug and tag Y owns a clashing name or alias, `ensureTag` still returns X, because X owns the slug. The fix in finding 1 also closes this, because reuse would then need the raw value to be one of X's keys.

### 3. Info: verified correct
- **Upsert:** `slug` is the only unique index on `topic_tags` (`migrations/0009_knowledge_taxonomy.sql:88-98`). The id is a random primary key. Aliases and names are JSON columns with no index, so `ON CONFLICT(slug) DO NOTHING` covers the only constraint that can fire.
- **Soft-delete restore:** `UPDATE ... WHERE id = ? AND deleted_at IS NOT NULL` lets exactly one racer restore. The loser sees `changes = 0` and gets 409. On the ensure path it then reuses the restored tag by slug. The restore targets the row its own slug lookup found, so it cannot resurrect a different tag, and `revision` goes up once.
- **Audit and revisions:** `writeAuditLog('tag.create')` runs only after a successful write (`:144`), so one row is written per real create. The loser writes nothing. Label revision counters are not touched by this code path.
- **Admin contract:** REST `POST /api/v1/taxonomy/tags` (`src/pages/api/v1/taxonomy/tags/index.ts:8`) and MCP `tag_create` (`src/lib/taxonomy/mcp.ts:109`) still call `createTag`. Both return 409 `tag_conflict` with `{tag_id}` in the standard envelope. The concurrent admin test confirms one 201 and one 409 rather than a 500.
- **Edge case (acceptable):** if a concurrent `deleteTag` lands between the slug SELECT and the INSERT, the 409 has no `tag_id` (`:140`). That is rare and harmless.
- **Pre-existing, not from this PR:** the OpenAPI tag create response documents its 409 as `revisionConflict` (`src/lib/taxonomy/openapi.ts:37`), not `tag_conflict`. This PR does not change the endpoint contract. It can be a separate docs issue.

## Tests
The barriers really race: `barrierAtTagInsert` holds both writers at the INSERT, after their lookups, and they fail on `main`. `holdAfterTagLookup` exercises the stale-lookup 409 path. A missing case is a lossy-slug clash (`C++` vs `C#`), which would have caught finding 1.

## Cleanup
The temp worktree `%TEMP%\rv311` was removed together with its `dist`, `node_modules` and the probe test. Nothing was pushed, and no comments or labels were changed.

---

# Round 2: head 810e779

fix(taxonomy): reuse a concurrent tag only when it already resolves the requested name

## Verdict: MERGE

The round-1 blocker is fixed. `ensureTag` now reuses a tag only when that tag owns the slug and `tagKeys(existing)` contains `normalizeKey(name)` for every requested name. This is the same key test that `resolveTagRefs` uses for its lookup, so a tag is reused only when the lookup would have returned it if it had seen the tag. Any other clash still gets 409.

## Gates (temp worktree `%TEMP%\rv311b` at 810e779)

| Gate | Result |
| --- | --- |
| `git diff --stat origin/main...810e779` | 2 files: `src/lib/taxonomy/tags.ts` (+54/-11) and `tests/tag-create-concurrent.test.ts` (+195). Merge base is `d271ee7` (#310). Main has since gained `3d14c0f` (#313), which touches only `chart-data.ts` and `chart-v2.test.ts`, so there is no overlap and nothing is reverted |
| `bun test tests/tag-create-concurrent.test.ts` | 8 pass, 0 fail |
| Same file with `tags.ts` from `fa9e184` (round 1) | 6 pass, 2 fail. The 2 failures are exactly the new tests, so they catch the blocker |
| `bun test` | 2023 pass, 0 fail (115 files) |
| `bun run build` | astro check: 0 errors, 0 warnings, 73 hints. Build complete |
| `gh pr checks 311` | Test & Build: pass (2m54s) |

## Verification

1. **Blocker resolved** (`src/lib/taxonomy/tags.ts:153-163`).
   - **Slug collision.** In a probe, `C++` followed by `C#` returns `409 tag_conflict`. The `c` tag keeps the key `c++`, `c#` is not one of its keys, and no article row is written. The new test at `:150` asserts the same.
   - **Alias owner vs slug owner.** Reuse now needs the raw name to be one of the slug owner's keys, so a clash caused by another tag's alias can no longer return the slug owner. `:159` covers the legacy case where one tag owns the slug and a different tag owns an equal alias.
   - **Case, diacritics and Vietnamese.** Matching uses `normalizeKey` (NFKD, combining marks stripped, `đ` to `d`, lowercase, whitespace and `_` to `-`), the same function as the lookup. Punctuation is kept, so `AI!` and `ai` stay distinct, and so do `rust!` and `Rust`.
   - **Non-race path cannot wrongly reuse a tag.** Reuse needs `normalizeKey(raw)` to be one of a live tag's keys. In the non-race path the lookup would already have found that tag through `byKey`, so `ensureTag` is reached only when that key is missing.
2. **Race case.** The existing barrier and stale-lookup tests pass: two concurrent creates of `gamma` produce one tag and no 409. Extra probes at the insert barrier, written as a temporary file and deleted afterwards:
   - `Tiếng Việt` and `tieng viet`: both fulfilled, with one tag `tieng-viet`.
   - `Đà Nẵng` and `DA NANG`: both fulfilled, with one tag `da-nang`.
   - `C++` and `C#` concurrently: one fulfilled and one `tag_conflict`. The loser does not reuse the tag, which matches the non-race behaviour.
3. **Non-race path matches main.** When `createTag` succeeds, the result is the same as on main. When it raises a non-race `tag_conflict`, the error is rethrown because the key check fails, exactly as main does. A probe confirmed `Rust` then `rust!` gives `tag_conflict`. Admin REST and MCP `createTag` are unchanged since round 1 and still return 409.
4. **Tests.** Both new tests fail on `fa9e184` and pass on `810e779`, and they also check that no article or tag row is left behind. See the Low note below.
5. **Scope.** OK (see the gates table).
6. **Astro hints.** None of the 73 hints is in a PR file. The extra hint comes from `tests/courses-commerce.test.ts:610:9` (`ts(80007)`, `await expect(...).rejects` on `applyDodoCourseWebhook(crashingD1...)`). That line was added by #310 (`90790b3..d271ee7`), which the branch picked up when it was rebased onto `d271ee7`.

## Findings

### 1. Low (non-blocking): the second new test's name overstates what it isolates
`tests/tag-create-concurrent.test.ts:159`. The raw value `Gamma-Ray!` normalises to `gamma-ray!`, which is not one of `tag_x`'s keys. The test therefore fails on the old code for the same reason as the `C++`/`C#` test (raw value not in the slug owner's keys), not because of a separate alias-owner rule. That is acceptable, because a separate rule is not needed: once the raw value is required to be one of the slug owner's keys, reusing that owner is correct by construction. A rename or a comment tweak is optional.

### 2. Info: theoretical legacy-duplicate edge
If legacy data had two live tags sharing one normalised key, `byKey` picks the first by slug order while `ensureTag` picks the slug owner. `ensureTag` is reached only when the lookup missed that key, which needs both tags to be created concurrently. That is not practically reachable, and no action is needed.

### Carried over from round 1 (unchanged, not blocking)
- A concurrent `deleteTag` between the slug SELECT and the INSERT gives a 409 without `tag_id`. This is rare and harmless.
- The OpenAPI tag-create 409 is documented as `revisionConflict` (`src/lib/taxonomy/openapi.ts:37`). This predates the PR and belongs in a separate docs issue.

## Cleanup
The temp worktree `%TEMP%\rv311b` was removed with its `node_modules`, `dist` and `.wrangler`, and the probe test and build log were deleted. `git worktree prune` was run. Nothing was pushed, and no comments or labels were changed.
