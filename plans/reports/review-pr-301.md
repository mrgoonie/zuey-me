# Review: PR #301, fix(articles): create an article in one batch and map a slug race to slug_taken (closes #295)

Reviewed head `81d1f02` in a separate temporary worktree (`%TEMP%\rv301`, now removed along with its `node_modules`, `dist/` and `.wrangler/`). Nothing was pushed, commented or labelled.

## Verification

| Check | Result |
| --- | --- |
| `bun test tests/article-create-atomic.test.ts` on the PR | 11 pass, 0 fail (78 expects) |
| New tests against the merge-base `src/` (`abf5c5f`, `git checkout <base> -- src`) | 10 fail, 1 pass (the article-row case). This matches the PR body. |
| `bun test` on the PR | 1933 pass, 0 fail (112 files) |
| `bun run build` | `astro check` 0 errors, 0 warnings (69 hints); build Complete |

## Checklist

- **One batch** (`src/lib/blocks/articles.ts:878-895`): the article, edition, `create` history row and every `article_tags` row are in one `db.batch`. D1 runs a batch as one transaction and rolls it all back when any statement fails. The test helper (`tests/helpers/d1.ts`, `db.transaction(...)`) behaves the same way. Nothing runs between the batch and the read-back except the best-effort mirror. The schema has no triggers and no foreign keys on these tables, so no hidden statement can escape the transaction. The earlier review's nit (`access` computed after the INSERT) is fixed: the INSERT now binds the same `access` the read-back uses.
- **Slug race** (`articles.ts:896-900`, `838-840`): only an error whose message contains `UNIQUE constraint failed: articles.slug` maps to `409 slug_taken`. `articles.slug` is a column `UNIQUE` (`migrations/0003_articles_and_surveys.sql:6`). No other table that this batch writes has a name ending in `articles` with a `slug` column. A PK collision (`articles.id`, `article_editions.id`, ...) or an `article_editions (article_id, locale)` violation is rethrown and stays a 500. This is the same predicate `updateArticle` already uses (`articles.ts:978`).
- **Tag mirror is a derived cache**: safe.
  - Writer: `mirrorLegacyTags` is the only writer (`src/lib/taxonomy/tags.ts:214`), apart from the `'[]'` default in the create INSERT (`articles.ts:882`). It is called from create (`articles.ts:902`), update (`984`), tags set (`1140`), tag rename (`tags.ts:107`) and tag delete (`tags.ts:166`). Each call rebuilds the column from `article_tags` + `topic_tags`.
  - Readers: only `src/lib/ai/context.ts:202,223` (AI grounding text) and `src/lib/videos/related-content.ts:77,89` (related-content weighting). Both are relevance hints. The record's `tags`/`topic_tags`, the search index (`src/lib/search/indexer.ts:32`), public facets (`src/lib/taxonomy/public.ts`), the CLI (`packages/cli`, which reads the API field) and Studio all read `article_tags`. `src/lib/reads/store.ts:80` is the `reads` table, not this one.
  - A failed mirror leaves `'[]'` until the next tags write, rename or delete. The only effect is weaker AI and related-content hints for that article. A 500 on a create that already committed (every retry then gets 409) was worse.
- **Tags created before the batch** (`articles.ts:869`, `tags.ts:176-202`): when the batch fails, the tags that `resolveTagRefs(createMissing: true)` created stay as topic tags with no articles. This does not break anything. Public facets drop tags with no published article (`public.ts:38`). Admin lists show `article_count: 0`. The retry resolves them by slug or name and reuses them, and the per-statement failure tests exercise exactly this path. This behavior existed before the PR, and `updateArticle` (`articles.ts:944`) already works this way.
- **Removed code**: grepping the repository (`src/`, `scripts/`, `packages/`, `tests/`, MCP modules) finds no reference to `setArticleTags` or `recordRevision` outside old `plans/reports/*.md`. The build typechecks.
- **Unchanged contracts**: the REST route (`src/pages/api/v1/articles/index.ts`) and the MCP tool (`src/lib/blocks/mcp.ts`) are not touched. Idempotency still goes through `idempotentJson(..., status: 201)` and the MCP `IDEMPOTENT_TOOLS` set. Create still returns 201, `409 slug_taken` and a 500 with no raw text (the test asserts `injected storage failure` is absent). The #294 read-back still runs after the commit, with the same written-state fallback. The test helper comment in `tests/article-update-atomic.test.ts:706-709` was updated to match.
- **Tests prove atomicity**: yes. The failures happen inside SQLite through temp `RAISE(ABORT)` triggers, in the real transaction, not in a JS mock. The cases cover every statement position, including the first and last tag rows. Each case asserts zero rows in all four tables, then a full retry (rows, history action, mirror). The tests fail on base `src/` (10 of 11), so they detect the old row-by-row code. Splitting the batch in two would fail the edition, revision or last-tag cases. The race test holds both requests at a barrier after the slug pre-check, so it really exercises the unique-index path, and it covers both the library and the REST envelope.

## Findings

### Critical
None.

### Major
None.

### Minor
None.

### Nit

1. **`afterCommit` doc comment is wrong** (`src/lib/blocks/articles.ts:843-844`). It says the cache "is rebuilt by the next write or an admin reindex". `reindexAll` / `search_reindex` (`src/lib/search/indexer.ts:122`) never calls `mirrorLegacyTags`. Only a tags write, a tag rename or a tag delete rebuilds `articles.tags`. A plain `article_update` without `tags` does not, and neither does a reindex. The author's admission is accurate. The comment existed before this PR, but it now covers one more call site, so fixing it in this PR is cheap. Suggested text: "the legacy tag mirror is rebuilt by the next tags write, tag rename or tag delete; the search index by the next write or an admin reindex".
2. **Out of scope, existing behavior, worth its own issue if wanted:** two concurrent creates that both introduce the same *new* tag name race inside `createTag` (`tags.ts:112-131`). The loser gets `409 tag_conflict` or a raw 500 (`UNIQUE constraint failed: topic_tags.slug`) before its batch runs, not `slug_taken`. The race test avoids this on purpose by creating the tags first. No rows are left half-written, so this is not an atomicity gap. Also note that `createTag` restores a soft-deleted tag with the same slug (`tags.ts:120-123`). If the batch then fails, that tag comes back with no article. That is harmless for the same reasons as the orphans above.

## Verdict

**MERGE.** The create is atomic by construction. Only the slug index maps to `slug_taken`. The mirror being best-effort is safe, because its only readers are relevance hints and every tag-changing path rebuilds it. The tags created before the batch cannot break reads or a retry. The removed helpers have no callers left. The REST, MCP, idempotency and read-back contracts are unchanged. Gates are green: 11/11 new tests, 1933/0 full suite, and build with 0 errors and 0 warnings. The only change worth making is the comment in Nit 1, and it does not block the merge.
