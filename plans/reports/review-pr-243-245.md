# Review: PR #243 (#194) and PR #245 (#159)

Reviewer: isolated agent (did not write either PR). Date: 2026-10-23 (Asia/Saigon).
Heads: #243 `6d7283a`, #245 `cc3a54d`, both on `origin/main` `4653695`.

## Verdict

| PR | Verdict | Blockers / majors |
| --- | --- | --- |
| #243 WriteReceipt on all writers | **APPROVE** (minor follow-ups) | none |
| #245 afterCommit + read back by id | **APPROVE** | none |

## Evidence

| Check | #243 | #245 | Merged (#243 + #245) |
| --- | --- | --- | --- |
| `bun test` | 1626 pass / 0 fail on rerun (first run, alongside the #245 suite: 1 fail, see N1) | 1630 pass / 0 fail | 1634 pass / 0 fail |
| `bun run build` (astro check + build) | 0 errors, 0 warnings, build complete | 0 errors, 0 warnings, build complete | not run (no shared lines) |
| `git merge-tree --write-tree review-243 review-245` | clean, exit 0 | | both PRs' test files: 32 pass |
| New tests against main's code | 3 of 7 fail with main's `mcp.ts` and routes (the 4 that pass are unit tests of the new helpers, which need #243's `articles.ts` to import at all) | all 8 new tests fail on main's `articles.ts`, 17 old ones pass | |

## PR #243: findings

Correctness: the receipt values match DB state for every writer:
- create: edition revision 1 = article revision 1.
- publish: sets the edition `revision = published_revision = expected+1` (`src/lib/blocks/articles.ts:963-967`).
- tags_set: leaves the edition revision alone, so the receipt shows the lower value. The test asserts 2 against an article at 5.
- edition_delete: sets the deleted row's `revision = expected+1` (`:994`), and the receipt reports `rec.revision`.

Publish reads back with the published `locale` (`:975`), so a non-primary publish gets a receipt for that locale (tested for `en`). The REST and MCP bodies keep every existing key: `receipt` is a new key and `operation` a new field. That makes the change additive. The OpenAPI `withReceipt` wrapper matches the five handlers, `WRITE_OPERATIONS` feeds the enum, and the summary-mode extras (`document_blocks`, `content_hash`) were already undocumented on `Article` before this PR.

### M1 (minor): the `edition_draft_revision` docs claim a metadata-only save leaves it lower. It does not.
- `src/lib/blocks/articles.ts:392` (interface comment), `src/lib/blocks/openapi.ts:148`, `docs/agent-article-playbook.md:26`. All three say "lower than article_revision after tags_set or a metadata-only save".
- `updateArticle` always rewrites the edition row with `revision = expected+1` when the edition exists (`articles.ts:871-873`), even for an `access`-only or `excerpt`-only save.
- Empirical check on the merged tree: create, publish, then `updateArticle({access:'knowledges'})` gives `article_revision: 3, edition_draft_revision: 3`.
- Only `tags_set` (and a concurrent writer) makes the value lower. The PR body says it fixed this comment, but the new wording is wrong in a different way. Fix: drop "metadata-only save" from all three places.

### M2 (minor): idempotent replays stored before deploy have no `receipt`, but OpenAPI now marks it required.
- `src/lib/idempotency/store.ts:13` keeps results for 24 h. A replay (`Idempotent-Replayed: true`) of a create, publish, tags_set or edition_delete stored before the deploy returns the old body without `receipt`. MCP `idempotency_status` does the same.
- This lasts at most 24 h after deploy and only affects strict clients that retry with a key. A one-line note in the PR or the playbook ("replays of requests made before <date> may lack receipt") is enough. No code change needed.

### M3 (minor): the stale-revision test depends on the previous test's state.
- `tests/article-write-receipt.test.ts:121-124` (`keeps stale revisions machine-readable`) uses the article that the test above it creates in a shared `d1`.
- Run alone (`bun test tests/article-write-receipt.test.ts -t stale`), it fails on the PR head: `Received: [AppError: Article not found]` instead of 409.
- It also checks nothing about receipts. Fix: create its own article, or merge it into the previous `it`.

### N2 (nit): `submittedPublishFields` counts `published_at: null` or `""` as submitted.
- `articles.ts:409-411` checks `!== undefined`, but `parsePublishedAt` treats `null` and `''` as absent (`:918`). The receipt would list `published_at` for a publish that did not backdate. Consider aligning it with the parser.

### N3 (nit): `edition_delete` receipt uses the read-back article revision for `edition_draft_revision`.
- `articles.ts:423` sets `edition_draft_revision: rec.revision`. If another writer gets in between commit and read-back, this exceeds the deleted row's real revision (`expected+1`). This only happens under the documented "unless someone else wrote in between" race, so it is harmless.

## PR #245: findings

- `getArticleById` (`articles.ts` near the old `getArticle`) uses the same `deleted_at IS NULL` filter as `loadArticleRow` and the same record builder (`articleRecord`). Behaviour is identical apart from looking the article up by id. The 500 messages are kept.
- The `afterCommit` wrapping covers exactly the reindex in publish, deleteEdition and setTags, plus the legacy mirror in setTags. Nothing inside the commit batch changed, so the atomicity from #157 is untouched. The mirror-failure trigger (`BEFORE UPDATE OF tags`) does not fire on the commit batch, which proves the mirror runs outside it.
- The rename tests use `interleaveAtFirstWrite('after')`. None of the three writers (or `updateArticle` without tags) issues a `run()` before the commit batch, so the hook fires right after the commit as intended.
- `applyPublishNotification` is unguarded. That is out of scope (#246) and not flagged.

### N4 (nit, existing code, not introduced here): `scheduleOgRefresh` still gets the pre-commit slug.
- `publishArticle`, `deleteEdition` and `setTagsForArticle` pass `slug`. `updateArticle` passes `nextSlug`, which can be stale after the new rename-in-window case. It only affects the OG cache warm-up URL. If it matters, file it as a separate issue; it should not widen #245.

## Interaction between the PRs

- No textual conflicts. #243 touches the receipt helpers and routes, #245 the read-back and post-commit paths.
- Together they are semantically consistent. When a concurrent rename lands between commit and read-back, #245 returns the record by id, and #243 builds the receipt from it. So `article_revision` is R+2 and the slug is the new one, which matches the documented "next expected_revision unless someone else wrote in between".
- Merge order does not matter. The merged tree passes the full suite (1634 / 0).

## Production risk

- No schema or migration changes, and no changes to auth or idempotency keys.
- The responses only gain keys.
- After #245, a failed reindex or mirror is logged instead of returning 500. The search cache can be stale until the next write or `search_reindex`. That is the intended trade-off, and it matches the `updateArticle` behaviour from #158.

### N1 (note): one test failure in the first #243 run could not be reproduced.
- The first #243 `bun test` ran at the same time as the #245 suite and reported 1625 / 1. The output filter cut the failing test's name.
- Rerunning #243 alone gave 1626 / 0, and the merged tree gave 1634 / 0. It is probably a timing-sensitive test under CPU load and is not attributable to this diff.

## Unresolved questions

- None blocking. For M2, decide whether the 24 h replay gap is worth a docs line.
