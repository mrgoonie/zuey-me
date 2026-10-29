# Review: PR #142 (closes #141), atomic `updateArticle`

- Head: `463de7c7dc0b4ab7b190654142e6f0be7d2f58d8`, reviewed with the latest `origin/main` merged in locally (no conflicts; `articles.ts` is not touched by main, so the line numbers below match the PR head).
- Reviewer context: isolated; did not write this code.

## Verdict: APPROVE

The fix is correct for `updateArticle`. Every write before the compare-and-set (CAS) is guarded by `EXISTS (... revision = expected ...)`. That includes both INSERT ... SELECT paths for a new locale and for history. All the writes, plus the CAS (placed last) and the primary mirror, go in one `db.batch`. Cloudflare's D1 docs state that "Batched statements are SQL transactions": if one statement fails, the whole sequence rolls back. So a save either applies in full at `expected + 1` or leaves no rows changed and returns `revision_conflict`. The findings below are non-blocking.

## Gates

| Gate | Result |
| --- | --- |
| `bun install --frozen-lockfile` | ok |
| `bun test` (PR + main merged) | 992 pass, 0 fail |
| `bun run build` | astro check 0 errors, 0 warnings (65 hints); build complete |
| New tests against `main`'s `articles.ts` | 1 pass, 2 fail (interleaved save; failed draft write), as the PR claims |

## Findings (ranked)

### Medium: three guards are not covered by any test
Mutation check: I removed one guard at a time and ran `tests/article-update-atomic.test.ts`.

| Guard removed | Tests failing |
| --- | --- |
| edition UPDATE, existing locale (`src/lib/blocks/articles.ts:720`) | **0 / 3** |
| re-create a soft-deleted edition (`articles.ts:727`) | **0 / 3** |
| `DELETE FROM article_tags` (`articles.ts:741`) | **0 / 3** |
| new-edition INSERT (`articles.ts:732`) | 1 / 3 |
| history-row INSERT (`articles.ts:738`) | 1 / 3 |

Why they are missed:
- The interleaved test (`tests/article-update-atomic.test.ts:92`) cannot see an unguarded stale edition write, because B's retry writes the same `B` draft afterwards.
- The stale test (`:151`) targets a new `en` edition, and the article has no tags.

Suggested additions to the stale test:
- give the article a tag first
- make a stale save on the existing primary locale with `tags: []` or other tags
- make a stale save that re-creates a soft-deleted edition

Then assert that the draft, the edition revision, the `deleted_at` value and the tags are unchanged. The code is correct today; this is regression protection.

### Low: the same window remains in other revisioned writers (follow-up, out of scope for #141)
These functions still bump the revision and then write in separate statements:
- `publishArticle` (`articles.ts:809-819`)
- `deleteEdition` (`articles.ts:843-849`)
- `setTagsForArticle` (`articles.ts:880-883`)

Example: a publish bumps to N+1. An `updateArticle` at N+1 then commits. The publish's `published_json = draft_json` copy then publishes a draft the publisher never saw, and the `publish` history row records the older `edition.draftJson`. `deleteEdition` can likewise soft-delete an edition right after a save at N+1 applied to it.

Recommend a separate issue to apply the same batch pattern to these three functions. Per AGENTS.md that belongs in its own issue, not this PR.

### Low (existing on main): a slug race returns 500
The slug check (`articles.ts:695-698`) runs before the batch. If another article takes `nextSlug` in between, the CAS raises a UNIQUE error. The batch rolls back cleanly, but the generic handler (`src/lib/http.ts:40`) returns `500 internal_error` instead of `409 slug_taken`. The behaviour on main is the same, so this is not a regression.

Related: on a CAS miss, `conflict(db, slug)` (`articles.ts:753` → `:637`) looks the article up by the old slug. If a concurrent save renamed the article, the caller gets `404` instead of `409 revision_conflict`. This is also the same on main.

### Low (existing on main): post-batch failures
`mirrorLegacyTags` and `reindexArticle` run after the commit (`articles.ts:757-759`). If either throws, the caller gets a 500 although the save is committed. A retry at the same revision then gets `409` with `current_revision`, so no data is lost. This matches main's order, where `setArticleTags` mirrored and reindex ran after the writes.

`mirrorLegacyTags` (`src/lib/taxonomy/tags.ts:205-214`) reads and then writes in separate statements. Two near-simultaneous saves can therefore leave the legacy `articles.tags` names one save behind until the next tag save. That column is only for older builds, so the impact is negligible.

### Info
- With `createMissing`, `resolveTagRefs` (`articles.ts:709`) creates new tags before the batch. A conflicting save can leave unused tags behind. This is the same on main.
- `mirrorPrimaryStatement` also runs when the CAS loses. It only rebuilds derived columns from committed editions, so it is harmless, as the code comment says.
- Batch size is at most about 26 statements: up to 20 tags, plus 1 delete, 1 edition write, 1 history row, the CAS and the mirror. That is the same statement count main already ran one by one, so D1 per-invocation query limits are unchanged.
- The inline tag writes match `setArticleTags`: delete, then `INSERT OR IGNORE` with the position, followed by the legacy mirror.

## Checks that passed
- **Atomicity on D1:** `db.batch` is a transaction per the Cloudflare D1 Database API docs (`batch()` section). The test helper (`tests/helpers/d1.ts`) implements `batch` with `bun:sqlite`'s `db.transaction`, which matches D1 semantics: sequential execution, full rollback on error, and `meta.changes` per statement.
- **Conditional writes:** each pre-bump statement repeats the same `id + revision + deleted_at IS NULL` predicate as the CAS. Inside one transaction, none of them can apply when the CAS changes 0 rows. I found no write that applies when the bump fails.
- **Callers:** none of them change, because the signature and return value are unchanged:
  - REST PUT (`src/pages/api/v1/articles/[slug].ts:39`)
  - MCP `article_update` (`src/lib/blocks/mcp.ts:217`)
  - the AI attach (`src/lib/ai/admin-chat.ts:83`)

  The attach path benefits most: a save landing between its `getArticle` and its `updateArticle` now gives a clean 409.
- **Response:** `getArticle(nextSlug, { locale })` runs after commit and returns `revision = expected + 1`. The tests assert this.
- **Typing:** no `any`; the only cast-free type import added is `D1PreparedStatementLike`; the AGENTS.md TypeScript rules are respected.

## Cleanup
The temporary worktree `D:\www\zuey\rv142` and the local ref `pr-142-review` were removed. Nothing was pushed, and no labels or remote resources were changed.
