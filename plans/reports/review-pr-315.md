# Review: PR #315 (closes #302): restore a won dispute in one guarded D1 batch

Head `140d65e`, one commit on `d271ee7` (#310). `origin/main` has since moved one commit, to `3d14c0f` (#313). That commit touches only `src/lib/blocks/chart-data.ts` and `tests/chart-v2.test.ts`, so it does not overlap this PR. I reviewed in a fresh temporary worktree (`%TEMP%\rv315`) and removed it afterwards, together with its `node_modules`, `dist/` and `.wrangler/`. I did not push, comment or change labels.

## Verdict

**MERGE.** The restore is now one batch: GitHub invite, `courses.granted` log, purchase upsert, `courses.order_paid` log, then the status update. Every statement is guarded on the order still being `charged_back`, and nothing in the batch changes the order status before the last statement. So either the whole restore applies or none of it does. A refund that commits first makes the batch a no-op. A refund that commits after it finds the order `paid` and revokes access through the #291 re-read. `grantCourse` behaves the same for every other caller. `countPurchase` has no caller left. The new tests fail on `main`'s source and pass on the PR. I found no blocking findings, only one minor test gap and some nits.

## Evidence

- `bun test tests/courses-commerce.test.ts`: **66 pass, 0 fail** (899 expects).
- **The new tests are real.** I ran the PR's tests against `origin/main`'s `course-order-payments.ts` and `course-purchases.ts`: 61 pass, **5 fail**. The failures are the race test and four failure points: GitHub invite, grant log, access grant and order log. The status-update point already passes on `main`, because it fails before the grant. This matches the PR description. I restored the files afterwards.
- Full `bun test`: **2022 pass, 0 fail** (114 files, 64295 expects).
- `bun run build`: `astro check` reports **0 errors, 0 warnings** (74 hints) on 916 files, and the build completes.
- `gh pr checks 315`: `Test & Build` **pass** (3m3s).
- **Scope.** `git diff --stat origin/main...140d65e` lists exactly 4 files: `docs/analytics-events.md` (1 line), `src/lib/courses/course-order-payments.ts`, `src/lib/courses/course-purchases.ts` and `tests/courses-commerce.test.ts` (+108, 0 deletions). No test is removed. The merge base is #310's merge commit, so no merged work is reverted.

## Findings

### Critical
None.

### Major
None.

### Minor

1. **No test covers a won dispute for a member who already has active access.** `course-purchases.ts:84-90`, `course-order-payments.ts:294-299`.
   - Scenario: `dispute.opened` revokes the purchase. An admin then grants the course (`order_id = NULL`, `source = 'grant'`), or the member buys it again, before `dispute.won` arrives.
   - Expected, and what the SQL does: the three grant statements are skipped by `NOT EXISTS (… status = 'active')`. The order log and the update to `paid` are guarded only on `charged_back`, so they still apply. No `courses.granted` log and no invite row are written. The purchase keeps its other owner. A later refund of this order revokes nothing, because `revokeCourseStatements` is scoped by `order_id`. This matches `main`, where `grantCourse` returned false and `COALESCE(attention_reason, 'already_owned')` was a no-op.
   - This is the PR's only new conditional branch, and no test reaches it. Suggested (optional): one test that grants the course by admin between `opened` and `won`, then asserts the order is `paid`, there is no new `courses.granted` log, the purchase stays `source = 'grant'`, and a later refund leaves access intact.

### Nit

1. **The race test fires just before the batch, not inside it** (`tests/courses-commerce.test.ts`, `racingRestore`). This is the right window: D1 runs a batch as one unit, so the last point a refund can land is before the restore batch runs. The opposite order (won commits, then the refund re-reads `paid` and revokes) is still covered by #291's `applies a refund that races dispute.won, so access does not stay restored`. Both orders are covered.
2. **The course is now read before any write** (`course-order-payments.ts:291-292`). A deleted course now throws 404 before the batch, so the event is released and Dodo keeps redelivering until its attempts run out, and the order stays `charged_back`. On `main`, the order was set `paid` with no access and the redelivery was `ignored`. The new behaviour is arguably better, and courses are not hard-deleted in practice. No action needed.
3. **Behaviour change for a failing `courses.granted` insert.** It now fails the restore batch, and the event is released and redelivered. Before, `logActivity` swallowed the error. The JSDoc at `course-purchases.ts:76-78` documents this, and it matches `revokeCourseStatements`.

## Focus answers

1. **Guards and statement order.**
   - The grant statements use `inactive AND disputed`, and the order log and status update use `disputed`. `disputed` is `EXISTS (… o.status IN ('charged_back'))`.
   - Only the final `UPDATE course_orders` changes the order status, so `disputed` evaluates the same for every statement in the batch.
   - `inactive` reads `course_purchases`. Only the upsert writes that table, and it is the last grant statement (`course-purchases.ts:86-90`), so the invite and the log see the same value as the upsert.
   - So no statement can apply when the update does not. The reverse can happen, and is intended: the update applies while the grant statements are skipped, for a member who is already active (see Minor 1).
   - The result check reads `results.at(-1)`, the status update.
2. **The "not already active" guard.**
   - A member with access from another order or an admin grant still gets the `paid` restore and the `courses.order_paid` log.
   - No invite is queued, but none is needed, because the active purchase already queued one.
   - The `courses.granted` log is skipped, which matches `grantCourse` returning false.
   - Access granted by this order and revoked by this dispute is not active, so all statements apply and the upsert reactivates it with `order_id = this order`. A later refund then revokes it.
   - A dispute on order B never revokes access that order A granted, because the revoke is scoped by `order_id`. So the "revoked by this dispute" case is always this order's own purchase.
3. **`grantCourse` versus `grantCourseStatements`.**
   - `grantCourse` (`course-purchases.ts:47-56`) has the same sequence as before: course lookup, active check, upsert, `enqueueGithubSync('invite')`, `logActivity`.
   - The upsert changed from `VALUES (…)` to `SELECT … WHERE true ON CONFLICT …`. It inserts the same row and resolves the same conflict, with the same binds. The `WHERE` avoids SQLite reading the upsert's `ON` as a join constraint, the same pattern `githubSyncStatements` already uses.
   - The other callers keep going through `grantCourse` unchanged: the SePay webhook (`course-payment-webhooks.ts:74`), the Dodo payment (`:232`), the admin `resolveCourseOrder` grant (`course-order-payments.ts:318`), free enrolment (`course-orders.ts:300`) and `grantCourseByEmail` (`course-purchases.ts:159`). The full suite passes.
4. **The removed `countPurchase` option.**
   - `git grep countPurchase` finds no match anywhere in the repo.
   - `fulfilCourseOrder` now always queues the purchase event, which is right for its four remaining callers. All of them passed the default before.
   - The restore never calls `queuePurchase`, so a won dispute still queues no second `purchase` event. The tests assert `purchases() === 1`.
   - No `refund` event is queued, so nothing is double-counted or lost.
5. **Steps after the batch.**
   - `afterCourseOrderPaid` (referral capture, promo/invoice bookkeeping, receipt) runs only when the batch applied (`course-order-payments.ts:300-301`). The order matches `main`, where these ran last inside `fulfilCourseOrder`.
   - A crash between the batch and these steps loses them, as it did on `main`. The receipt key `course-receipt:<order id>` was already sent at payment time, so its loss is moot. `redeemPromo` and the invoice activation were already done for the original payment.
   - Referral capture is protected in other ways. `captureReferralCommission` requires `status = 'paid'` (`commission-source-facts.ts:82`). The recapture job skips sources with a reversal marker. Re-capture after a won dispute is pre-existing behaviour, per review-pr-291-round2.
   - If a refund lands between the batch and the capture, the capture sees `refunded` and returns null. If the capture wins, the refund's `reverseCourseOrder` reverses it. Either way the commission ends correct.
   - Acceptable. The PR makes this window strictly smaller: `main` could commit `paid` and then crash before the grant, leaving a paid order with no access.
6. **Event record in `dispute.won`/`dispute.cancelled`.**
   - Confirmed: `applyDodoCourseWebhook` records the event first (`course-payment-webhooks.ts:135`) and calls `restoreCourseOrder` later (`:148`). Only a thrown error releases the record (`:151-153`). A worker crash after the record and before the batch commits leaves the record, so the redelivery is `duplicate_event` and the restore is lost.
   - The PR does not make this worse, it improves it. Before, an error in `grantCourse` after the `paid` update had committed released the event, and the redelivery then found the order `paid` and answered `ignored`, so access never returned. Now any error rolls back the whole batch, the event is released, and the retry restores once (the five failure-point tests).
   - The crash case is unchanged and worth its own issue: make the record the batch's guarded first statement, as #310 did for reversals.
7. **Tests.**
   - `racingRestore` interleaves for real. It wraps only the `UPDATE course_orders SET status = 'paid'` statement. On `main`, where that update runs alone, it fires the refund after the `run`. On the PR, it fires the refund before the batch that carries the update, then runs the batch with the unwrapped statements. On `main`'s code the test fails, so it proves the bug.
   - The failure injection covers all five statements of the batch. With one repo in the course, these are the invite, the `courses.granted` log, the purchase upsert, the `courses.order_paid` log and the status update. `failingD1` swaps the matching statement for an insert into a missing table, so the whole batch fails.
   - Each case asserts the order is still `charged_back`, there is no access, no invite, no new logs and no gate row. Then a retry restores once and a redelivery is `duplicate_event`.
8. **Scope.** Clean, as in Evidence.

## Unresolved questions

- Should the won/cancelled record-first crash window (focus 6) be its own issue? It is out of scope for this PR. The caller will file it.
