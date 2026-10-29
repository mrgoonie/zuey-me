# Review: PR #322 (closes #316): write the won-dispute record in the same batch as the restore

Head `8507e1c`, one commit on `e995b32`, which is the current `origin/main` tip (merge base equals the tip). `mergeStateStatus` is CLEAN. I reviewed in a fresh temporary worktree (`%TEMP%\rv322`) and removed it afterwards, together with its `node_modules`, `dist/` and `.wrangler/`. I did not push, comment or change labels.

## Verdict

**MERGE.** `dispute.won` and `dispute.cancelled` now go through the gated handler. Their `payment_events` record is the first statement of the one restore batch, under the same `charged_back` guard as the grant, the logs and the status update. So the record and the restore commit together or not at all. The only write of the record outside a batch is the deliberate lone write when nothing applied (`ignored`). A crash before that write only repeats `ignored`. Refund and funds-lost behaviour is byte-for-byte unchanged versus main. The new tests crash for real and fail on main's source. I found no blocking findings, only one minor test gap and some nits.

## Evidence

- `bun test tests/courses-commerce.test.ts`: **73 pass, 0 fail** (1006 expects).
- **Fail on main, rerun.** I checked out `origin/main`'s `course-order-payments.ts` and `course-payment-webhooks.ts` and kept the PR's tests: **67 pass, 6 fail**. The 6 failures are exactly the new tests: crash, batch shape, and refunded-meanwhile, each for `dispute.won` and `dispute.cancelled`. This matches the PR description. I restored the files and `git status` was clean.
- Full `bun test`: **2039 pass, 0 fail** (115 files, 64491 expects). The PR body says 2038; the extra test comes from `main` moving on (#311/#319).
- `bun run build`: `astro check` reports **0 errors, 0 warnings** (76 hints), and the build completes.
- `gh pr checks 322`: `Test & Build` **pass** (2m22s). The head matches `8507e1c`.
- **Scope.** `git diff --stat origin/main...8507e1c` lists exactly the 4 files: `docs/analytics-events.md` (1 line), `src/lib/courses/course-order-payments.ts` (+5/-3), `src/lib/courses/course-payment-webhooks.ts` (+11/-12) and `tests/courses-commerce.test.ts` (+72, 0 deletions). The test diff removes no line, and the merge base is the `main` tip, so no merged work is reverted.

## Findings

### Critical
None.

### Major
None.

### Minor

1. **No test races two deliveries of the same won event.** The scenario is `tests/courses-commerce.test.ts` (new block after line 756) against `course-payment-webhooks.ts:164,188,200`.
   - Scenario: deliveries A and B of `evt_x` both pass the pre-check at `:164`.
   - What the code does: D1 serialises the two batches. A commits the record and the restore. B's batch then evaluates `disputed` as false, so its guarded `INSERT … SELECT … WHERE` inserts 0 rows (no unique violation), and every other statement is skipped. `restoreCourseOrder` returns false, and the lone `recordCoursePaymentEvent` at `:200` hits the unique key and returns false, so B answers `duplicate_event`. There is one grant, one log and one invite.
   - The reasoning holds, and #310's "rolls the whole reversal back when its record is already taken" covers the shared unique-violation catch. But for the restore, this "guard false, then the lone write is the duplicate" path is reached only by the sequential redelivery tests, not by a real interleave. Suggested (optional): one test that fires a second `dispute.won` with the same id just before the first batch runs (as `racingRestore` from #315 does), then asserts `restored` plus `duplicate_event`, and a single grant log and invite.

### Nit

1. **A won dispute that arrives before its `dispute.opened` is lost for good. This is pre-existing and not changed by this PR** (`course-payment-webhooks.ts:188,200`).
   - Scenario: the `dispute.opened` delivery fails (for example a 5xx) and `dispute.won` is delivered before Dodo's retry. The order is still `paid`, so the restore batch is a no-op and the won event is recorded as `ignored`. The retried `opened` then revokes access, and every redelivery of the won event is `duplicate_event`.
   - `main` behaves the same (record first, then `ignored`). It is rare and outside #316's scope. It could get its own issue if Dodo's ordering is not guaranteed.
2. **An error from `afterCourseOrderPaid` after the batch commits now surfaces as a 5xx.** `course-order-payments.ts:303`. Its user/course reads or `sendLoggedEmail` can throw after the restore committed (referral and promo steps catch their own errors). On main, the catch released the record, and the redelivery found the order `paid` and answered `ignored`. Now the error is rethrown with the record kept, so the redelivery is `duplicate_event`. In both cases access is restored and only the post-commit steps are lost, so the net outcome is the same. If that error happens to be a unique violation, the catch at `:203` would answer the first delivery `duplicate_event`, which is misleading but harmless. No action needed.
3. **The docs sentence in `docs/analytics-events.md` is accurate but long.** It now covers the refund race, the lone record and the crash in one sentence. It is fine as is.

## Focus answers

1. **Atomicity.**
   - `restoreCourseOrder` puts `gate(disputed)` first in the one `d1.batch` (`course-order-payments.ts:295-301`), with the same `disputed` condition as every other statement. Only the last statement changes the order status, so the guard evaluates the same for the whole batch. The record is inserted if and only if the restore applies.
   - In `applyDodoCourseWebhook`, the only route for won/cancelled is now `:132-133`. The old `recordCoursePaymentEvent` call at `:135` and the restore branch inside the record-first `try` are no longer reachable for these types, because `order` is always non-null for `dispute.*` (`:125`).
   - The only other write of the record is `:200`, reached only when the batch did not apply. Nothing else writes the record for these types.
   - The course lookup (`:292-293`) throws 404 before any write, so no record is left. On main, the record was written and then released, so the outcome is the same.
2. **Idempotency and duplicates.**
   - A real duplicate after a commit is caught by the pre-check (`:164`), and the batch-shape test asserts that the redelivery runs no statement and no batch.
   - Two concurrent deliveries cannot both restore: the second batch's guard is false once the first commits (Minor 1). If the second batch does see `charged_back` with the record already present (only possible after a lone `ignored` write on a then-`paid` order that was later charged back, Nit 1), the guarded insert raises a unique violation. The batch then rolls back, and `:203` answers `duplicate_event`.
   - Neither catch in the gated handler deletes the record. `releaseCoursePaymentEvent` remains only in the record-first path for payment events (`:149`).
   - A second won-type event under a different id, such as `dispute.cancelled` after `dispute.won`, finds the order `paid` and is `ignored`. So the restore applies once per order.
3. **Order no longer `charged_back`.**
   - The record is written alone and answered `ignored` (`:200`). A crash before that write leaves nothing changed, and the redelivery re-runs the same no-op batch and answers `ignored` again. That is idempotent, and the refunded-meanwhile crash test covers it.
   - Can a later legitimate `charged_back` occur for the same event id? Only `reverseCourseOrder` with `REVERSIBLE = ['paid', 'needs_attention']` (`:173`) sets `charged_back`. So a `refunded` order never returns to `charged_back`, and access stays revoked, as #315 intends.
   - A `paid` order can later be charged back by a new `dispute.opened`. That is a different event id, so the won id stays a duplicate. This is the pre-existing ordering edge in Nit 1, and the PR does not change it.
4. **`applyGatedDodoCourseEvent`.**
   - The diff adds one `else if (DODO_DISPUTE_FUNDS_KEPT.has(type))` branch between the refund branch and the revoke/lost branch. `DODO_DISPUTE_FUNDS_KEPT` (`dispute.won`, `dispute.cancelled`) and `DISPUTE_REVOKE` (`dispute.opened` plus accepted/lost/expired, `dodo.ts:399-401`) are disjoint. So the refund path (`:169-185`), including the #291 re-read and retry, and the revoke/lost path (`:189-198`) are unchanged versus main.
   - The only other change is the extra `env` parameter, which only the restore uses.
   - Response codes Dodo sees: `restored`, `ignored` and `duplicate_event` are all acknowledged as before. A failure before the commit is still a thrown error, so the route answers an error and Dodo redelivers. On main, it threw after releasing the record. Now it throws with no record written. Either way Dodo sees the same error, and the redelivery restores once.
5. **Tests.**
   - `crashingD1` really simulates a crash: the matching batch never reaches `base.batch`, and `dead` makes every later call throw, so no cleanup can run. On main, that is why the record survives and the crash tests fail.
   - The crash point for the restore is the `UPDATE … SET status = 'paid'` statement inside the batch, so the whole batch, record included, is dropped.
   - The batch-shape test asserts the following. No record is written as a lone `run`. There is exactly one batch. Its first statement is the record. It contains the status update. A redelivery runs nothing. That is meaningful, and it fails on main.
   - The refunded-meanwhile test crashes only at the lone write. Its counter is incremented after the first batch returns, so the guarded record inside that batch does not trigger the crash. The test then asserts `ignored`, then `duplicate_event`, and that the order stays `refunded` without access.
   - The throw matrix adds "the record" as a failure point: `failingD1` breaks the whole batch, so no record is left, and the retry restores once.
   - The fail-on-main claim is reproduced above: 6 fail.
6. **Scope.** Clean, as in Evidence.

## Unresolved questions

- Should Nit 1 (a won dispute that arrives before its `dispute.opened` is lost permanently) get its own issue? It is pre-existing and depends on whether Dodo guarantees delivery order across retries.

Status: DONE
Summary: MERGE; 73/73 focused (6 fail on main as claimed), 2039/2039 full, astro check 0/0, CI Test & Build pass; no blocking findings.
