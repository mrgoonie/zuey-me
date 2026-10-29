# Review: PR #305 (closes #296), course order reversal and its analytics in one batch

Head `43fc6fe` (`fix/296-atomic-course-reversal`). This was a fresh-context review in a temporary worktree (`%TEMP%\rv305`). I removed that worktree afterwards, with its `node_modules`, `dist/` and `.wrangler/`. I did not push, comment or change labels.

## Verdict

**CHANGES.** The course batch itself is correct and its tests are real. However, the commit also reverts #301 (`f355aba`, "create an article in one batch"), which was merged three minutes before it. It deletes #301's test file, so CI cannot catch this. Restore the four files from `main`, and this PR is ready to merge. All other findings are minor.

## Evidence

- `bun test tests/courses-commerce.test.ts`: 48 pass, 0 fail.
- **The failure-injection tests are real.** I ran the PR's tests against `main`'s `src` (`git checkout f355aba -- src`, then restored it) and got 32 pass, 16 fail. All 16 failures are new "fails part-way" tests: 6 for a refund of a paid order, 6 for a lost dispute of a paid order, 2 for a refund during a dispute, 1 for lost after opened, and 1 admin refund. The 3 that pass inject at the status update, which was already the first write on `main`. This matches the PR body.
  - The injection is a real failure. Inside a batch, the wrapper swaps the statement for `INSERT INTO injected_failure DEFAULT VALUES`, which fails on a missing table, so the `bun:sqlite` transaction in `tests/helpers/d1.ts` rolls back as D1 would. `/injected/` matches the resulting `no such table: injected_failure`.
- **#301 regression proven.** I ran `main`'s `tests/article-create-atomic.test.ts` against the PR head's `src` and got 1 pass, **10 fail**. The failures are atomic create, slug race giving 409 `slug_taken`, REST and MCP envelopes, and legacy tag mirror.
- Full `bun test`: 1963 pass, 0 fail (111 files). This count already leaves out #301's deleted tests.
- `bun run build`: `astro check` reports 908 files, 0 errors and 0 warnings, and the build completes.
- `gh pr checks 305`: `Test & Build` passes (2m1s). It passes only because the regression's tests were deleted.

## Findings

### Critical

1. **The commit reverts #301 (article create atomicity and the slug race).** The PR's parent is `f355aba` (#301), but the commit's tree has the pre-#301 versions of:
   - `src/lib/blocks/articles.ts:885-895`: `createArticle` again writes the article, edition, revision and tags row by row. `recordRevision` is back at `:771`. The `slug_taken` mapping for a concurrent create is gone.
   - `src/lib/taxonomy/tags.ts:217`: `setArticleTags` is restored.
   - `tests/article-create-atomic.test.ts`: deleted (240 lines).
   - `tests/article-update-atomic.test.ts:707-708`: comment reverted.
   - Effect: a failure part-way through creating an article again leaves an unreadable article, and every retry gets 409 `slug_taken`. A same-slug race answers 500. This is the #301 bug back on `main`.
   - Likely cause: the work tree was based on `26f4d92` and committed on top of `f355aba`. None of this is mentioned in the PR body or the commit message.
   - Fix: `git checkout origin/main -- src/lib/blocks/articles.ts src/lib/taxonomy/tags.ts tests/article-create-atomic.test.ts tests/article-update-atomic.test.ts`, then commit. The diff against `main` should then list only the course, outbox, users, store and docs files.

### Major
None.

### Minor

1. **A failed batch leaves the referral commission reversed on an order that is still paid.** `src/lib/courses/course-order-payments.ts:159-160`.
   - Before this PR, the commission was reversed only after the status update succeeded. Now it is reversed before the batch, for any order read as `paid`/`needs_attention`.
   - When Dodo redelivers, the result is the same, because `reverseCommission` is idempotent (see below). The gap appears when the retry never succeeds: Dodo stops after 8 attempts, or an admin gets the 500 from a failed refund and does not retry. The order then stays `paid` with access, and its commission is `reversed`.
   - For a referred order with no commission yet, `markSourceReversed` (`src/lib/referrals/refunds.ts:50`) marks the source for good, so a later recapture (for example an admin `grant`) never creates one.
   - The PR states this trade-off. It mirrors #287's membership path, and commission reversal leans toward safety, so I do not count it as blocking. A short note in the admin refund's 500 path or in the docs ("retry until it succeeds") would make it visible.
2. **The comment overstates crash safety.** `course-order-payments.ts:149` says "a failure or a crash leaves none of them and the retry writes them all once".
   - A crash leaves no partial reversal, because the batch is atomic.
   - But the `payment_events` gate row (`course-payment-webhooks.ts:132`) was committed before the batch, and only the `catch` at `:184` releases it. After a crash, the redelivery returns `duplicate_event` and the reversal never happens. So there is no retry.
   - Change the comment to say "a failure", or name the crash gap. See "Where the gate lives" below.

### Nit

1. `orderIn(...)` returns a fresh object, and `refundDisputedCourseOrder` then mutates its `params` (`:199-200`). This works, but passing `lost` through the `also` argument as params would be cleaner.
2. A refund of an order read in a non-reversible status now builds and runs a batch of N+6 no-op statements (N = GitHub repos), where it used to run a single UPDATE. That is harmless, and it stays well under the Workers 50-query limit.

## Focus answers

**Batch contents.** Every correctness write is in a batch:

| Path | Batch (in order) | Guard |
| --- | --- | --- |
| Refund of a paid order | certificate revoke; GitHub `remove` upsert per repo; `courses.revoked` log; purchase revoke; `courses.order_refunded` log; `refund` outbox row; status update | Revoke statements: purchase still `active` with `order_id` = this order, and the order is `paid`/`needs_attention`. The rest: order is `paid`/`needs_attention`. |
| Lost dispute of a paid order | same, with `courses.order_charged_back` and a `…:charged_back` outbox row (`countMoneyBack = lost`) | same |
| Opened dispute of a paid order | same, without an outbox row | same |
| Admin refund | same as the refund row | same |
| Refund during an open dispute (#291) | `courses.order_refunded` log; `refund` row; status update | order is `charged_back` and no funds-lost `payment_events` row exists for it |
| Lost after opened | a single outbox insert, which now throws | none needed (`ON CONFLICT (dedupe_key) DO NOTHING`) |

- Every statement repeats the guard as an `EXISTS` on `course_orders`, and the status update comes last. Inside one D1 transaction, every earlier statement sees the old status, so they all apply or none do. No write can apply while the status update does not. This rules out a double revoke, a second outbox row or a second activity.
- Inside the revoke, the purchase UPDATE is last, so the certificate, GitHub and `courses.revoked` statements still see `active`.
- `githubSyncStatements` uses `SELECT … WHERE <cond>` (or `WHERE true`), which resolves SQLite's upsert parse ambiguity. A false condition yields no row, so neither the insert nor the `DO UPDATE` fires.
- Bind order checked: `active.params` = user, course, [order], order, statuses.

**Where the gate lives.** For course webhooks, the `payment_events` row is a separate statement before any processing (`recordCoursePaymentEvent`, `course-payment-webhooks.ts:132`). It is deleted only in the `catch` (`:184`).
- A throw is safe: the batch rolls back, the gate is released, and Dodo redelivers.
- A crash (CPU or memory limit, eviction, timeout) between the gate insert and the end of the batch leaves the gate behind, so the redelivery is `duplicate_event` and the reversal is lost. The author is right about this.
- Memberships after #287 differ: the business-keyed gate (`refund.succeeded:<id>`, `dispute.lost:<id>`) is the first statement of the reversal batch (`src/lib/payments/dodo-billing.ts:694,714`), and a unique violation means "already done". A crash there is safe.
- **Could this PR have included the gate?** For the paid-order reversal and the admin refund, yes. A gate insert as the first batch statement, with a unique violation mapped to `duplicate_event`, works like #287. It is not a drop-in change, though:
  - The #291 re-read-and-retry runs a second batch, which needs the gate with `ON CONFLICT DO NOTHING`, or the gate only in the attempt that applies.
  - The "lost after opened" path depends on its gate row being committed before it re-reads the order. #291's race argument depends on that.
  - The commission reversal and the reads all run between the gate and the batch.
  - Issue #296 asked only for status, log and outbox in one batch. So leaving the gate out is acceptable here, but it should be filed as its own issue (crash-safe course gate) rather than claimed in the comment (Minor 2).

**#291 behaviour kept.**
- The re-read on a race is unchanged (`course-payment-webhooks.ts:153-159`).
- A refund during a dispute still uses the same guard (`charged_back` and no funds-lost row), now inside the batch with its log and outbox row.
- A funds-lost outcome on an order already charged back still re-reads the order after its gate and skips the chargeback only after a full refund.
- Money back is still counted once per payment. Both refund branches use the key `course_order:<id>:refunded`, only one guarded update can match, and the outbox `dedupe_key` is unique.
- New: on a paid order, the chargeback goes in the reversal batch with no re-read. That is correct, because a `paid` order cannot be `refunded`.

**GitHub removal.** No external API call is inside or before the batch. `githubSyncStatements` only upserts `github_invites` rows (`action = 'remove'`), which the scheduler processes later. The GitHub API is therefore never called on an inconsistent DB, and a rolled-back batch leaves no queued removal. The tests check this (`removals()`).

**Commission reversal is idempotent.** `reverseCommission` (`src/lib/referrals/refunds.ts:47-72`):
- The status UPDATE is gated on `pending`/`review`/`approved`.
- The ledger reversal re-runs only when a credit exists, and `appendLedger` reports `inserted`, so no second line is added.
- `commission.reversed` is logged only when something changed.
- Running it before the batch and again on a retry is safe. The post-batch call (`:176`) covers an order read as non-reversible that became reversible, and it runs only when the batch applied. See Minor 1 for the cost of the new ordering.

**Admin refund error envelope.** A batch failure propagates out of `resolveCourseOrder`. `memberRoute` passes it to `errorResponse` (`src/lib/http.ts:37-41`), which returns `500 { success: false, error: { code: 'internal_error', … } }` without the raw message. Nothing is written apart from the commission (Minor 1). The test shows that the retry refunds once. A non-reversible order still gets `409 not_refundable`.

**Out of scope, #302.** `restoreCourseOrder` is unchanged. The refund's revoke still requires an `active` purchase granted by this order, now checked inside the batch rather than by a read before it. The window between the restore's status UPDATE and its `grantCourse` is the same, so #302 is not worse.

**Docs.** The new "Payment first" sentence in `docs/analytics-events.md` matches the code. The outbox header comment is accurate. No endpoint changed, so no OpenAPI or Scalar update is needed.

## Unresolved questions

- Should a follow-up issue cover the crash gap, by putting the course webhook gate inside the reversal batch as #287 did for memberships? Under AGENTS.md it belongs in its own issue, not this PR.
