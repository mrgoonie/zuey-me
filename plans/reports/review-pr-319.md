# Review: PR #319 (Closes #314)

`docs(openapi): document the real 409 codes for taxonomy tag, category and label CRUD`
Head `99890a9cb0be89bdec1dcf767120bb79109275c9`. Reviewed in a fresh context, in a temporary worktree at the head commit.

## Scope

`git diff --stat origin/main...99890a9` lists only the two expected files:
`src/lib/taxonomy/openapi.ts` (+17/-5) and `tests/knowledge.test.ts` (+31). `tags.ts` is untouched, so it does not collide with #311.

## 1. Error codes vs handlers

Route handlers in `src/pages/api/v1/taxonomy/{tags,categories,labels}/{index,[id]}.ts` only delegate to the lib. `adminRoute` and `common.ts` throw no 409. `errorResponse` (`src/lib/http.ts:38`) spreads `AppError.extra` into `error`, so `error.tag_id`, `error.current_revision` and `error.articles` really appear on the wire.

| Operation | Documented | Thrown (source) | Match |
| --- | --- | --- | --- |
| POST /tags | `tag_conflict` + `tag_id` | `tags.ts:98` via `assertNoCollision` (`createTag` :116) | yes |
| PUT /tags/{id} | `tag_conflict`, `revision_conflict` | `tags.ts:142` → :98; `tags.ts:147` (+`current_revision`) | yes |
| DELETE /tags/{id} | `revision_conflict` | `tags.ts:162` | yes |
| POST /categories | `slug_taken` | `categories.ts:73,77` (`assertUniqueSlug`, :83) | yes |
| PUT /categories/{id} | `slug_taken`, `revision_conflict` | `categories.ts:106` → :73/:77; :111 | yes |
| DELETE /categories/{id} | `revision_conflict` | `categories.ts:128` | yes |
| POST /labels | `label_conflict` | `labels.ts:151` | yes |
| PUT /labels/{id} | `revision_conflict` | `labels.ts:188` (taken slug → raw 500, #318) | yes |
| DELETE /labels/{id} | `label_in_use` + `articles`, `revision_conflict` | `labels.ts:202` (`{ articles: n }`), :206 | yes |

No thrown 409 code is undocumented, and no documented code is unreachable. The extras (`tag_id`, `current_revision`, `articles`) match the `AppError` payloads exactly.

## 2. Interaction with PR #311 (unmerged, head 810e779)

#311 changes only `createTag` (plus the new private `writeTagRow`/`ensureTag`) and `resolveTagRefs`. Explicit create still runs `assertNoCollision` first. A lost insert race now throws `409 tag_conflict` (previously a raw 500 on the slug UNIQUE index), with `owner ? { tag_id } : {}`. `ensureTag` is reached only through article writes, not through `POST /tags`. So after #311 merges, POST /tags still returns only `tag_conflict`, and the docs stay correct. Update and delete are untouched. The test in this PR stays valid after #311, because a duplicate alias is still caught by `assertNoCollision` with `tag_id`.

## 3. Label update documents only `revision_conflict`

Acceptable. `updateLabel` (`labels.ts:168-193`) has no slug pre-check. A taken `(kind, slug)` hits `UNIQUE (kind, slug)` and `errorResponse` answers `500 internal_error`. Documenting `label_conflict` would promise a code the endpoint never returns. #318 is filed, and its fix explicitly includes adding `label_conflict` to this 409. Accurate docs for the current behaviour is the right call.

## 4. Test (`tests/knowledge.test.ts:719-748`)

- **Meaningful.** I ran a mutation check: with `origin/main`'s `openapi.ts` restored, the new test fails (POST /tags documented `revision_conflict` and not `tag_conflict`). With the PR's file it passes. The test checks every operation against all five codes in both directions (present and absent), so both drift directions are caught. It also calls the real `POST /api/v1/taxonomy/tags` on real SQLite and asserts `409`, `tag_conflict` and `error.tag_id === owner.id`. That ties the docs to runtime behaviour.
- **Not brittle.** It matches backticked code tokens (`` `code` ``), which is this file's existing convention (`job_closed`, `label_revision_conflict`), not full prose. The per-assertion object `{ path, method, code, documented }` makes failures self-describing. The tag names (`Doc owner`, `doc-alias`) are unique in the suite.

## Findings

| # | Severity | Location | Scenario |
| --- | --- | --- | --- |
| 1 | Info (pre-existing, out of scope) | `src/lib/taxonomy/tags.ts:93-99,142-146` | `PUT /tags/{id}` renames a tag's slug to a slug held by a **soft-deleted** tag. `assertNoCollision` uses `allTags`, which filters `deleted_at IS NULL`, so the UPDATE hits `topic_tags.slug UNIQUE` and answers a raw `500`, not `409 tag_conflict`. This is the same class as #318 and is not filed (searched open issues). Per AGENTS.md, file it as its own issue; do not widen this PR. |
| 2 | Info | `src/lib/taxonomy/openapi.ts:19` | `slug_taken` reads "another category already uses this slug". `assertUniqueSlug` (`categories.ts:72`) does not filter `deleted_at`, so a soft-deleted category's slug also yields `slug_taken`. The wording is still essentially true, since the slug stays reserved. No change needed. |
| 3 | Info | `src/lib/taxonomy/openapi.ts:18` (after #311) | #311's race path attaches `tag_id` only when `getTag` finds the owner (`owner ? { tag_id } : {}`). In the near-impossible case where the owner is gone by then, `error.tag_id` is absent. The docs saying it "names that tag" is fine for the practical case. No change needed. |

No Critical, High, Medium or Low findings.

## Gates (temporary worktree at 99890a9, run one at a time)

- `bun install --frozen-lockfile`: OK (744 packages).
- `bun test tests/knowledge.test.ts`: 63 pass, 0 fail.
- `bun test`: 2017 pass, 0 fail (114 files).
- `bun run build`: `astro check` 0 errors, 0 warnings, 73 hints (none in touched files); build complete.
- Mutation check: the new test fails against `origin/main`'s `openapi.ts`, as intended.
- CI (`gh pr checks 319`): `Test & Build` pass (2m49s).
- OpenAPI/Scalar: the fragment is consumed unchanged by `/api/openapi.json` (merged registry). Only description strings changed, with no schema shape change. Build and astro check confirm it type-checks.

Cleanup: the temporary worktree was removed, which also removed its `dist/`. No `.wrangler/` was created. Nothing was pushed, commented or relabelled.

## Verdict

**MERGE**

Follow-up to file separately: finding 1 (tag slug rename onto a soft-deleted tag's slug returns 500).
