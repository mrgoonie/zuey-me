# Review: PR #262 (closes #246)

`fix(articles): report a failed post-commit email step instead of returning 500`
Head `a661e40` on `fix/246-publish-notification-after-commit`. Reviewed in a separate worktree (since removed).

## Verdict

**Approve, with follow-ups.** The fix does what #246 asks for. `applyPublishNotification` is wrapped after `commitAtRevision`. The response returns a fixed, non-sensitive marker, and only `err.message` reaches the log, the same as `afterCommit`. The retry path cannot send an email twice. I found no blockers. The items below are gaps and follow-ups.

## Evidence

- `bun test tests/article-update-atomic.test.ts`: 27 pass, 0 fail.
- **Reverting the fix makes the new tests fail.** I replaced the `catch` body with `throw err` and kept the new tests: 25 pass, 2 fail. Both failures were the new tests. I then restored the file.
- `bun test` (full suite): 1731 pass, 0 fail (103 files, 61755 expects).
- `bun run build`: 0 errors, 0 warnings, 70 hints (the same 70 hints as before). Build completed.
- OpenAPI is 3.1.0, so `type: ['string','null']` for `send_after` is valid and matches the existing `reason` field.

## Failure-path analysis

- **The email step can no longer throw after commit.** `applyPublishNotification` (articles.ts:992-997) covers the existence read, the INSERT/UPDATE and the final re-read. The search reindex already goes through `afterCommit`. `scheduleOgRefresh` catches its own errors inside `waitUntil`.
- **One post-commit throw remains: `getArticleById`** (articles.ts:998). See minor finding M1.
- **The response shape is honest.** It says "failed" and does not claim to know the stored state. The JSDoc on `ArticleNotificationFailure` says the same.
- **Raw error text is kept out of the response.** The test asserts that the trigger message is absent from the body. The log line has `err.message` only, no stack and no SQL bindings.
- **The REST idempotency wrapper is unaffected.** A keyed request stores and replays the `failed` body, which is the true outcome of that request. A retry needs a new `expected_revision`, which means a new body and therefore a new key. Reusing the same key with the new body correctly returns `422 idempotency_key_reused`.

## Retry story (double-send or skip)

`article_notifications` has one row per article (keyed by `article_id`, written with `INSERT OR IGNORE`), and `notify: true` only re-schedules a row that is `skipped` or `cancelled`. So no retry can send twice:

| Where the email step failed | Stored state | Retry with `notify: true` | Retry with no `notify` |
| --- | --- | --- | --- |
| Before or at the INSERT (first publish) | no row | INSERT `scheduled`, so the email goes out once | `previouslyPublished` is now true, so the row is `skipped` / `previously_published` and the email is silently never sent (minor M3) |
| Re-read after the INSERT succeeded | `scheduled` | no change, so the email goes out once | no change, so the email goes out once |
| An opt-out UPDATE failed (`notify: false` on `scheduled`) | still `scheduled` | (wrong retry for this case) | the email **still goes out** unless the caller retries with `notify: false` (minor M2) |
| The row is `sent` or `sending` | unchanged | no change, no second send | no change |

**Studio's retry is correct.** After a failed first publish the reloaded draft view has `email_notification: null`. `emailChoice(null)` is true and `defaultNotify(null)` is true, so the dialog sends an explicit `notify: true`.

## Findings

### Blocker

None.

### Major

None.

### Minor

**M1. `getArticleById` after commit can still turn a committed publish into a 500.** (src/lib/blocks/articles.ts:998)
- Scenario: the publish batch and the email step both succeed. Then the D1 read in `getArticleById` → `articleRecord` → `loadEditions` hits a transient error, or a concurrent delete makes it throw `AppError(500, 'internal_error', 'Article disappeared after publish')`. The client gets 500 for a publish that is live, which is the confusion #246 describes.
- This existed before the PR and `updateArticle` (articles.ts:926) has the same pattern, so it is outside #246's narrow scope. Per AGENTS.md it should get its own issue rather than widen this PR. Possible fix: a minimal receipt fallback built from `art` and `revision`.

**M2. The `failed` marker hides an email that is still going out when an opt-out update fails.** (src/lib/notifications/article-notification-schedule.ts:83-85; articles.ts:996)
- Scenario: the email is `scheduled`. The admin republishes with `notify: false` to stop it, and the UPDATE fails. The response says `failed / notification_update_failed`, but the row is still `scheduled`, and members are emailed within 30 minutes.
- The MCP description and OpenAPI only say to "republish with an explicit notify". Only the playbook adds "then check `pending_side_effects`".
- Suggestions:
  - In the `catch`, re-read the row on a best-effort basis (`getArticleNotification`, its own errors swallowed) and include the known stored status. Or add a `stored_status` field.
  - At minimum, add "check `article_verify_public.pending_side_effects`" to the MCP `article_publish` description and the OpenAPI text, not only the playbook.

**M3. A retry without `notify` silently skips the email, and the retry has side effects beyond the email.** (articles.ts:968-971, 977-985; article-notification-schedule.ts:77-78)
- Skipped email: after a failed first publish, `previouslyPublished` is true, so a republish with no `notify` writes `skipped` / `previously_published`. Members are never emailed. The docs do say "explicit notify", so this is documented and the response is honest (`status: skipped`). It is still an easy trap for scripted retries.
- Side effects: #246 asked for a way "to retry only the notification". The PR's only retry is a full republish, which also:
  - adds a `publish` revision and bumps `revision` and `published_revision`;
  - rewrites `published_modified_at`, so the reader-facing "updated" date and sitemap lastmod move;
  - re-runs the reindex and the OG image refresh;
  - publishes whatever draft is at the new `expected_revision` if someone re-read the article and saved in between.
- A notify-only path (for example, re-running `applyPublishNotification` without a publish) would match the issue's expected behaviour exactly. This is acceptable as a follow-up. Note it in the PR or file an issue.

**M4. The tests only inject a failure on the INSERT path.** (tests/article-update-atomic.test.ts:413-454)
- The `BEFORE INSERT` trigger covers a first publish only. These cases are not tested:
  - the UPDATE branches (opt-out cancel, re-schedule of `skipped` / `cancelled`);
  - a failure after the write landed (the re-read), which is the case behind the "idempotent if the row did get written" claim in the PR body;
  - the MCP `article_publish` path (it shares `publishArticle`, so the risk is low).
- One extra test with a `BEFORE UPDATE ON article_notifications` trigger, plus an assertion that the row is still `scheduled`, would pin down M2.
- The existing tests are good. They use real SQLite, check REST status 200, the receipt `published_revision: 2` and the stored `published` state, and assert the raw message is absent. They fail when the fix is reverted (verified above).

### Nit

- **N1.** (articles.ts:992-997) The `try/catch` duplicates `afterCommit`'s logging. A small `afterCommitValue<T>(what, task, fallback)` helper, or extending `afterCommit` to return a value, would keep the post-commit log format in one place. This is cosmetic.
- **N2.** (ArticleEditor.tsx:1226-1228) The variable `scheduled` now also holds `failed`; renaming it to `email` would read better.
  - The Studio message ("Không cập nhật được email cho thành viên; xuất bản lại để thử lại.") is honest. It could say that the dialog's email checkbox must stay ticked. Studio defaults it to ticked when the row is null, but not in the M2 case, where the reloaded row is `scheduled` and the user wanted to cancel.
- **N3.** (articles.ts:80) `ArticleSummary.email_notification` is widened to `PublishEmailNotification`, which includes `failed`, for draft views too. The comment says `failed` appears only in publish responses, which is correct. A separate type for the draft view would keep the type exact, but this is optional.

## Docs and contract consistency

- **OpenAPI** (src/lib/blocks/openapi.ts:86-94): `failed` is in the enum and `send_after` is nullable. The description matches the behaviour.
- **MCP description** (src/lib/blocks/mcp.ts:203), the **playbook** (docs/agent-article-playbook.md:84) and the **Studio note** all match the behaviour.
- **Only gap:** `pending_side_effects` is mentioned in the playbook only (M2).

## Cleanup

- Removed the temporary worktree, including its `node_modules`, `dist/` and `.wrangler/`.
- Nothing was pushed, commented or merged.

## Unresolved questions

- Should a notify-only retry path (M3) be in scope for #246? The issue text says "retry only the notification". Or is a republish accepted as the retry?

## Round 2 (delta `a661e40..89d22de`)

Out of scope per the coordinator: M3 is filed as #267 and M1 as #266.

### Verdict

**Approve.** M2 and M4 are fixed correctly, and the Studio rename (N2) is done. The delta adds no blocker or major issue. One minor follow-up for Studio is below (R2-1).

### Evidence

- `bun test tests/article-update-atomic.test.ts`: 30 pass, 0 fail.
- **The new tests fail without the fix.** I disabled the stored-row branch of `notificationAfterFailure` so that it always returned the `failed` marker. All 3 new tests failed (27 pass / 3 fail). I then restored the file.
- `bun test` (full suite): 1734 pass, 0 fail (103 files, 61766 expects).
- `bun run build`: 0 errors, 0 warnings, 70 hints (unchanged). Build completed.

### M2: fixed

- **New helper.** `notificationAfterFailure` (src/lib/notifications/article-notification-schedule.ts:93-102) re-reads the stored row after the error. If a row exists, it returns that row with `reason: 'notification_update_failed'`. If not, it returns the `failed` marker.
- **The helper cannot throw.**
  - `getArticleNotification` is `async`, so a synchronous throw from `prepare` becomes a rejection, which `.catch(() => null)` absorbs.
  - Building the marker from `nowMs` cannot throw either.
  - So the `catch` in `publishArticle` (src/lib/blocks/articles.ts:994-997) is still safe.
- **The response now shows the real state.** In the opt-out case the response reports `scheduled`, together with the stored `send_after`, so the caller can see that members will still be emailed.
- **The failure reason cannot be confused with a stored one.** The reason `notification_update_failed` is only ever put into responses. It is never written to `article_notifications`, so it always signals this failure path.
- **First-publish INSERT failure is unchanged.** There is no row, so the response is still the `failed` marker. The round-1 tests that assert `toEqual` on that marker still pass.
- **Docs are consistent.** The OpenAPI description (src/lib/blocks/openapi.ts:87-91), the MCP `article_publish` description (src/lib/blocks/mcp.ts:203) and the playbook (docs/agent-article-playbook.md:84) all now say: when the reason is `notification_update_failed`, check `status`, because it may still be `scheduled`.

### M4: fixed

New tests use a `BEFORE UPDATE ON article_notifications` trigger (tests/article-update-atomic.test.ts:459-503). They cover:
- a failed `notify: false` cancel, which reports `scheduled` with the stored `send_after`; the row is still `scheduled`;
- a failed `notify: true` re-schedule, which reports `skipped`;
- the MCP `article_publish` path, which reports `scheduled`, asserts the raw trigger message is absent, and confirms the row is still `scheduled`.

The one path not covered is a re-read that also fails and falls back to the `failed` marker. That fallback is a one-line `.catch`, so this is acceptable.

### New findings

**R2-1 (minor). Studio does not tell the user when a cancel or re-schedule failed.** (src/components/studio/ArticleEditor.tsx:901-903, 1226-1228)
- Cause: `parseEmailNotification` drops `reason`, and the note only checks `status`.
- Scenario 1, failed cancel: the admin unticks the email box to cancel a scheduled email, and the UPDATE fails. Studio shows "Email cho thành viên sẽ gửi lúc …". That is true, but it does not say the cancel failed, so the admin may assume the untick worked.
- Scenario 2, failed re-schedule: the admin ticks the box to send a previously skipped email, and the UPDATE fails. The response is `skipped` with the failure reason, and Studio shows no email note at all. The admin believes the email is scheduled.
- Fix: keep `reason` in `parseEmailNotification`, and show the "Không cập nhật được email…; xuất bản lại để thử lại." note whenever `reason === 'notification_update_failed'`, together with the scheduled time when there is one.
- This is not a regression: before the delta Studio was equally silent, or showed the generic failed note.

**R2-2 (nit). The stored row's original reason is replaced.** (article-notification-schedule.ts:99)
- The response overwrites the row's own reason (for example `publisher_opted_out` or `previously_published`) with `notification_update_failed`. The stored reason is still visible through `pending_side_effects` and the draft view, so no information is lost.

### Cleanup

- Removed the round-2 worktree, including its `node_modules`, `dist/` and `.wrangler/`.
- Nothing was pushed, commented or merged.
