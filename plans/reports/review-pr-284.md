# Review: PR #284, fix(articles): return committed update and publish when the read-back fails (closes #266)

Reviewed head `5f77fa3` (branch `fix/266-post-commit-readback`) in a separate worktree.

## Verification

| Check | Result |
| --- | --- |
| New tests run against `main`'s `src/` with the PR's test file | 8 fail (all 8 new read-back tests), 31 pass. The tests do catch the bug. |
| `bun test` on the PR | 1847 pass, 0 fail (109 files) |
| `bun run build` | `astro check` 0 errors, 0 warnings; build Complete |
| Probe: fallback compared with a real read-back on an article with two editions (vi published, en draft, update en with a forced read-back failure) | Revision, status, has_unpublished_changes, label_revision and draft_recovery match. `available_locales` is `[]` in the fallback but `["vi"]` in the real read, and `editions` has 1 entry instead of 2 (see Minor 1). |

## Correctness of the fallback record (`readBackAfterCommit`, `src/lib/blocks/articles.ts:559-575`)

I checked each "exact" field against the SQL that was committed:

- **Update** (`articles.ts:955-964`): edition title, excerpt, draft_json, revision and updated_at match the guarded UPDATE/INSERT. For a re-created deleted edition, cover_url NULL, published_* NULL, words 0 and the kept cover_alt match the re-create UPDATE. Article slug, locale, access, category_id, revision (`expected + 1`) and updated_at match the bump. For an edition that was already published, published_json is the pre-read value. That is exact because a publish in between would bump the revision and turn the commit into a 409.
- **Publish** (`articles.ts:1037-1044`): `published_json = draft_json`, `published_revision = revision = expected + 1`, `published_at = COALESCE(param, old, now)`, `published_words`, `cover_url` and `updated_at` all mirror the UPDATE. The word count is now computed once and shared (`publishedWords`), so it cannot drift from the stored value. The bump sets `updated_at = now`, which matches.
- **Receipt**: `toWriteReceipt` only reads `revision`, `published_revision`, `has_unpublished_changes`, `locale` and the edition's own revision. All of these are exact in the fallback, as the tests show.

**Can a failure before the commit now be reported as success?** No. `readBackAfterCommit` runs only after `commitAtRevision` returns, and that function returns only when the bump changed a row. A conflict throws through `conflict()` and a batch error propagates, and both happen before the call. The only thing the try/catch covers is the read-back.

**Error text leakage:** none. The raw message goes only to `console.error`, and the response never carries it. The tests assert this for REST and MCP.

**Docs and contracts:** the OpenAPI `ArticleSummary.read_back` entry (`src/lib/blocks/openapi.ts:86-91`), `READ_BACK_NOTE` in the MCP `article_update` / `article_publish` descriptions (`src/lib/blocks/mcp.ts:148`), the playbook bullet and the TS interface all say the same thing. The REST handlers and MCP build their answers only from `rec` (`toSummary`, `rec.draft`, `rec.published`) and do no further DB reads, so a 200 reaches the caller. Studio treats any 200 as success and calls `load()` again.

## Findings

### Critical
None.

### Major
None.

### Minor

1. **`available_locales` (and `editions`) in the fallback cover only the written edition, and the docs do not say so.** At `src/lib/blocks/articles.ts:568`, `buildSummary(art, edition, [edition], ...)` derives `available_locales` from that one edition. Failure scenario: an agent updates the `en` draft of an article whose `vi` edition is live, and the read-back fails. The answer says `available_locales: []`, which reads as "nothing about this article is public", but `vi` is still live (the probe above reproduced this). The OpenAPI, MCP and playbook text lists tags, topic_tags, category, labels and "other editions" as not loaded. `available_locales` is not empty, it is wrong, and it is not on that list. Fix: either add `available_locales` to the documented "not loaded" fields (all three places), or omit it from the fallback.

2. **`tag_ids` is inconsistent with `tags` in the update fallback.** At `articles.ts:963`, `tagIds: tagIds ?? []` means: when the request sent `tags`, `tag_ids` is exact, but `tags` / `topic_tags` are `[]`; when it did not, `tag_ids` is `[]` even though the article keeps its tags. `toSummary` strips `tag_ids`, so REST and MCP callers never see it. It is internal-only today, so the impact is low. It would be simpler to always return `[]` and treat it as not loaded, or leave a comment on the asymmetry.

3. **Test coverage gaps on the fallback builder.** The new tests (`tests/article-update-atomic.test.ts:530-620`) do force a real post-commit failure in two ways (a D1 error on the read-back query only after the batch, and a concurrent soft delete after the first write), and they assert the DB state. They do not cover:
   - the "missing edition is created" branch of `writtenEdition` (`articles.ts:957-960`: new INSERT, and re-creating a deleted edition);
   - updating an edition that is already published (`published_revision` kept, `status: 'published'`);
   - an article with several editions (this would have caught Minor 1).

   A stronger test would compare the fallback's exact fields with a normal `getArticle` read of the same state, so the two builders cannot drift apart later.

### Nit

- `articles.ts:963`: `parseStoredDoc(docJson, slug)` uses the old slug when the update renames the article. Elsewhere the slug is used only for logging context, so this is harmless.
- An idempotent request (with an `Idempotency-Key`) whose read-back failed stores the degraded answer, and replays within 24 hours return it, still flagged `read_back: "failed"`. That is acceptable and self-describing, but the playbook could add "a replay may repeat the flag; call `article_get`".
- Studio: if the read-back failed because of a concurrent delete, the follow-up `load()` fails too, and the user sees the load error rather than "Đã lưu". This is expected for that rare case and needs no change.

## Out of scope (not filed, as instructed)

`createArticle` (`articles.ts:876`), `deleteEdition` (`articles.ts:1068`) and `setTagsForArticle` (`articles.ts:1100`) still end with a bare `getArticleById`. A failed read-back there still returns 500 for committed work, and for create a retry gets `409 slug_taken`. Issue #266 names only publish and update, so this belongs in a follow-up issue.

## Verdict

**MERGE.** The fix is correct and scoped. It cannot report a failure before the commit as success, it does not leak error text, and the contracts are consistent. The tests fail on `main` and pass on the PR. Minor 1 (fix the docs, or drop `available_locales` from the fallback) is worth a quick follow-up commit, but it does not block the merge.

Cleanup: removed the review worktree `D:\www\zuey\rv284` (including its `dist/`, `.wrangler/` and the probe test).
