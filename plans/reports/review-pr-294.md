# Review: PR #294, fix(articles): return committed create, edition delete and tags set when the read-back fails (closes #288)

Reviewed head `49e44ba` (branch `fix/288-readback-create-delete-tags`) in a separate worktree (`D:\www\zuey\rv294`, now removed).

## Verification

| Check | Result |
| --- | --- |
| New tests against `main`'s `src/` (`git checkout origin/main -- src`) | 16 fail (all new failure-path tests: 15 in `article-update-atomic`, 1 in `article-localization`), 67 pass. This matches the PR body. |
| `bun test` on the PR | 1922 pass, 0 fail (111 files) |
| `bun run build` | `astro check` 0 errors, 0 warnings; build Complete |
| Probe A: `article_tags_set` sent with a revision that does not exist yet, while an update moves the article to that revision between the pre-read and the commit; read-back forced to fail | Fallback says title `Old title` and edition revision 1. The stored article has `New title` and edition revision 2. The answer is flagged `read_back: "failed"` and these fields are documented as exact (Minor 1). |
| Probe B: label write (`label_revision + 1`) between the pre-read and the commit of an edition delete; read-back forced to fail | Fallback `label_revision` 0, stored 1 (Minor 2). |

## Exact fields compared with the SQL that was written

- **create** (`src/lib/blocks/articles.ts:885-902`): `slug`, `locale` (primary = `input.locale ?? input.primary_locale ?? vi`, the same value bound to `articles.locale` and the edition), `access`, `category_id`, `revision 1`, `created_at`/`updated_at = now` all mirror the INSERT. `label_revision 0`, `cover_asset_id NULL`, `social_preview_mode 'generated_card'`, `social_preview_asset_id NULL`, `cover_alt ''`, `published_words 0`, `cover_url NULL` and `published_* NULL` are the column defaults (migrations `0009`, `0026`). `setArticleTags` and `mirrorLegacyTags` do not touch `updated_at`. The fields match.
- **edition delete** (`articles.ts:1079-1090`): the batch changes only the deleted edition and bumps `revision`/`updated_at`. The primary edition and the article row as read before the commit, plus `revision = expected + 1` and `updated_at = now`, describe the committed state, unless the case in Minor 1 or 2 happens. The receipt for `edition_delete` uses only `revision` and `deletedLocale`, so it is exact.
- **tags set** (`articles.ts:1129-1136`): same as delete. `tag_ids: []` even though the ids are known. That matches the documented "not loaded" rule, and `toSummary` strips the field anyway.
- **Pre-commit failure reported as success?** No. `readBackAfterCommit` runs only after `commitAtRevision` returns (a lost bump throws a 409 or 404 first) or, for create, after all four statements returned. The `written === null` path rethrows the original error. That can only happen when the article has no live edition left after the delete, and then a working read-back would also throw (`pickEdition` returns null, so you get a 500). The behavior does not change.
- **No raw error text** in the REST or MCP answers. The tests assert this, and the handlers build their answers only from `rec`.
- **Status codes and idempotency**: create stays `201` (`idempotentJson(..., status: 201)`), delete and tags return `200`. Replays return the stored degraded answer with the flag, as documented.
- **Localization apply** (`localization-service.ts:345-350`): when the read-back works, `updateArticle` returns `getArticleById(id, {locale})`, which is the same `articleRecord` that `getArticle(slug, {locale})` built before. Title, excerpt and draft are identical, so `result_hash` and provenance do not change. The only behavioral difference is an improvement: before, a concurrent rename made the slug read return null and the code fell back to `resultHash`; now the read by id still finds the article. In the fallback, the draft comes from the written JSON through the same `readStoredDocWithRecovery`, so the hash is exact.
- **Docs and contracts**: the OpenAPI `read_back` description, `READ_BACK_NOTE` (now on create, edition delete and tags set), the playbook bullet and the TS doc comment all say the same thing. Studio reloads after create and edition delete, and does not read tags from the PUT answer.

## Findings

### Critical
None.

### Major
None in this PR's scope. (See "createArticle atomicity" below. It is Major on its own, but the PR leaves it out on purpose and it will be filed separately.)

### Minor

1. **The "nothing changed it in between" guarantee only holds when `art.revision === expected` at the pre-read.** See `articles.ts:1093-1103` (`unchangedEditionShown` doc comment), and `1079`/`1129`. The commit is guarded by `expected`, not by the revision that was read. Scenario: an agent pipelines `article_update` (expected 1) and `article_tags_set` (expected 2). The tags request pre-reads at revision 1, the update commits and changes the primary title and draft, then the tags commit succeeds at 2→3, and the read-back fails. The answer reports the old title, draft and edition revision as exact (Probe A reproduced this). The same latent gap exists in `updateArticle`/`publishArticle` (merged in #284), and the publish revision snapshot then records a stale draft. The fix is cheap: right after `loadArticleRow`, add `if (art.revision !== expected) return conflict(db, art.id);` in the revisioned writers. It is a fast 409, and the doc-comment claim becomes true. Severity is low: it needs a client that sends a revision it has not received yet, and a read-back failure on top of that.
2. **`label_revision` (and `category_id`) can be stale in the fallback.** `applyLabelSet` (`src/lib/taxonomy/labels.ts:452`) moves `label_revision` without touching `revision`. Category delete (`src/lib/taxonomy/categories.ts:130`) nulls `category_id` without a bump. A write of either kind between the pre-read and the commit makes the fallback report the old value (Probe B), although "revisions" are documented as exact. This applies to all five writers, including the #284 ones. Fix: either list `label_revision` among the fields that are not exact, or re-read nothing and just document it. A label writer that relies on a stale `label_revision` gets `409 label_revision_conflict` and recovers, so the impact is low.
3. **Coverage of the fallback with three or more editions.** The delete and tags tests use exactly two editions, so `editions` holding only the primary one is never compared with a real read that lists more than one remaining edition. That behavior is documented ("`editions` lists only the edition shown"), so this is coverage only.

### Nit

- `articles.ts:895`: `const access = input.access ?? 'free'` is computed after the INSERT already binds `input.access ?? 'free'`. Hoist it and bind `access`, so the two cannot drift apart.
- `articles.ts:1090`: `editions.filter(e => e !== edition)` relies on object identity. That is fine, but `e.locale !== locale` reads more clearly.

## createArticle atomicity (author's concern, confirmed; for the separate issue)

Confirmed, and it is wider than four rows. `createArticle` (`articles.ts:885-894`) runs as separate auto-committed statements: INSERT `articles`, INSERT `article_editions`, INSERT `article_revisions`, then `setArticleTags` (`src/lib/taxonomy/tags.ts:217-225`), which runs a DELETE, then one INSERT per tag, then `mirrorLegacyTags` (a SELECT plus an UPDATE). Before any of that, `resolveTagRefs(createMissing: true)` already creates the missing tags.

Failure scenarios (each returns 500, and every retry gets `409 slug_taken`):
- **The edition INSERT fails.** The article row exists without an edition. `article_get` returns 404 (`pickEdition` returns null), and the slug is reserved for good. Recovery is possible only through `article_update` with a title, and nothing tells the caller to do that.
- **The revision INSERT fails.** The article is fine but has no revision-1 history.
- **A tag INSERT fails part-way.** The article has a partial tag set and the caller is told the create failed.
- **`mirrorLegacyTags` fails.** That is only a derived cache, yet the create still returns 500. Update and tags set wrap the same call in `afterCommit`.
- **Slug race.** Two concurrent creates with the same slug both pass the `SELECT id ... WHERE slug` check. The second INSERT then fails on the unique index with a raw 500, not with `slug_taken`. `updateArticle` maps this through `isSlugUniqueViolation`; `createArticle` does not.

Severity: **Major** for data integrity (an orphan article that cannot be read, plus a misleading error that agents act on). Each failure is rare on D1 (it needs a transient error mid-sequence). Suggested fix: one `db.batch` with the article, edition, revision, tag inserts and the legacy mirror (`mirrorPrimaryStatement`-style subquery), then map a unique violation to `slug_taken`. That also makes the read-back fallback in this PR exact by construction.

## Verdict

**MERGE.** The fix is correct and scoped. It cannot report a failure before the commit as success, it leaks no error text, `201`/`200` are preserved, the docs are consistent, and the tests fail on `main` (16) and pass on the PR. Minors 1 and 2 are narrow races that affect only an already-degraded answer, and they also exist in the #284 writers. Fix them in one follow-up (early `revision !== expected` conflict, plus a doc note on `label_revision`). File the create atomicity issue separately, as planned.

Cleanup: removed the review worktree `D:\www\zuey\rv294`, including its `dist/`, `.wrangler/` and the probe test. Restored `src/` to the PR head before the removal.
