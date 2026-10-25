# Review: PR #310 (closes #308), course webhook `payment_events` gate inside the reversal batch

Head `becc81b` (`fix/308-course-webhook-gate-in-batch`), one commit on `90790b3` (current `origin/main` tip). Fresh-context review in a temporary worktree (`%TEMP%\rv310`), removed afterwards together with `node_modules`, `dist/` and `.wrangler/`. Nothing pushed, no comments, no label changes.

## Verdict

**MERGE.** The gate is now the first statement of every reversal batch, under that batch's own guard, so a crash before the commit leaves no record and the redelivery applies the reversal once. Racing deliveries cannot both apply, and cannot both be answered `duplicate_event` with nothing applied. `chargeBackLostCourseOrder`'s SQL guard is equivalent to #291's JS re-read, partial refunds included. The #291 race tests still prove the race. Scope is clean, with no revert of merged work. Findings are minor and nits only, and none blocks.

## Evidence

- `bun test tests/courses-commerce.test.ts`: **59 pass, 0 fail** (780 expects).
- **The new tests are real.** With `origin/main`'s two `src/lib/courses` files and the PR's tests: 49 pass, **10 fail**. The 10 failures are exactly the 5 crash and 5 structural tests. Files restored, `git status` clean.
- **Mutation: no #291 retry.** I replaced `if (current && current.status !== order.status) done = await refund(current);` with a no-op. Result: 57 pass, 2 fail, and the 2 failures are exactly the race tests (`races dispute.opened`, `races dispute.won`).
- **Mutation: no full-refund check.** I replaced the guard's `status = 'refunded' AND COALESCE(...) <> 'dodo_partial_refund'` with `0`. Result: 3 fail (`counts the money back … once … in either order`, `reports no chargeback when a dispute refunded in full is then lost, and a partial refund keeps the chargeback`, `reports no chargeback for any funds-lost outcome after a full refund`).
- Full `bun test`: **2015 pass, 0 fail** (114 files, 64176 expects).
- `bun run build`: `astro check` **0 errors, 0 warnings**, build complete.
- `gh pr checks 310`: `Test & Build` **pass** (2m21s). `mergeStateStatus` is CLEAN and the head matches `becc81b`.
- **Scope.** `git diff --stat origin/main...becc81b` and the two-dot diff are identical. Both list only the 4 files: `docs/analytics-events.md`, `src/lib/courses/course-order-payments.ts`, `src/lib/courses/course-payment-webhooks.ts` and `tests/courses-commerce.test.ts`. The merge base is the `origin/main` tip, so nothing from #301/#305/#309 is reverted. The diff removes no `it(`/`describe(` and no `expect(` lines. Static `it(` count went from 30 to 33, and the loops add 10 more.

## Findings

### Critical
None.

### Major
None.

### Minor

1. **The crash test for "lost after opened" never crashes inside `chargeBackLostCourseOrder`'s batch.** `tests/courses-commerce.test.ts`, `crashes[4]` (`at: sqlPoint(/INSERT INTO analytics_outbox/)`).
   - For a `charged_back` order, the handler first calls `reverseCourseOrder(..., lost=true, gate)` (`course-payment-webhooks.ts:191`). That batch is a no-op, but it still contains the guarded `analytics_outbox` insert (`course-order-payments.ts:191,199`), so `crashingD1` dies at that first batch.
   - The second batch, `[gate(), moneyBack]` (`course-order-payments.ts:254`), is never the crash point. The same applies to `failingD1`'s "lost dispute after an opened one fails at the chargeback event" scenario.
   - Correctness is not affected. That batch is a single `d1.batch`, atomic by construction, and the structural test does check that it starts with the gate and contains the outbox insert.
   - Suggested fix (optional): crash on the second matching batch for this scenario, or match the `charged_back` dedupe key only when the batch's first statement is the unguarded gate.

2. **There is a narrow commission gap after the batch, and the docs do not mention it.** `course-order-payments.ts:205` (`if (applied && !commissionFirst) await reverseReferral(...)`).
   - The order is read in a non-reversible status and becomes `paid`/`needs_attention` before the batch, so the commission reversal runs *after* the commit.
   - If the worker crashes between that commit and `reverseReferral`, the record and the reversal are committed, the redelivery is `duplicate_event`, and the commission stays unreversed.
   - This is not a regression: on `main` the gate was already committed, so the outcome is the same. But `docs/analytics-events.md` and the `reverseCourseOrder` comment say the commission reversal "runs before the batch", and they describe only the opposite gap (order still `paid`, commission reversed).
   - Suggested fix (optional): one clause in the doc or the comment, or a follow-up issue.

### Nit

1. **The #291 single-retry window is still there.** This is pre-existing and was noted in review-pr-291-round2.md.
   - A refund whose order changes status twice between the read and the retry (for example `opened`, then `won` before the retry batch) applies nothing. It is recorded alone as `ignored`.
   - It is unchanged by this PR. The record is written only after both batches are no-ops, so a crash there loses nothing extra.
2. **`racing()` now fires after the duplicate check instead of after the gate insert** (`tests/courses-commerce.test.ts:341-370`).
   - This is the correct window now, and the mutation run above shows it still proves both refund races.
   - The other #291 ordering, where a lost outcome commits first and the refund is then suppressed, is covered only sequentially (`reports no refund after an opened dispute was lost`). That was already the case on `main`.
3. `coursePaymentEventRecorded` returns `.first<Row>() !== null`. That is fine with D1 and the bun helper, which both return `null` on no row. `undefined` would read as "recorded", but neither runtime returns it.

## Focus answers

1. **Pre-check and racing deliveries.** Two deliveries A and B both pass the pre-check (`:166`).
   - `reverseCourseOrder` and `refundDisputedCourseOrder`: D1 serialises the batches. The first commits the gate together with the status update. The second evaluates the same guard against the new status, so its `INSERT … SELECT … WHERE` inserts 0 rows (no unique violation) and every other statement is a no-op.
   - The second then re-reads the order. A changed status gives a retry batch that is still a no-op, then the standalone `recordCoursePaymentEvent` hits the unique key and returns `duplicate_event` (`:199`).
   - `chargeBackLostCourseOrder` uses an unguarded `gate()`, so the second batch raises a unique violation and rolls back entirely. The catch (`:202`) confirms the record exists and returns `duplicate_event`.
   - A record exists only if some delivery's batch applied, or if a delivery found nothing applicable. So "both duplicate, neither applied" cannot happen, and "both applied" cannot happen. The `rolls the whole reversal back when its record is already taken` test covers the unique-violation rollback.
2. **Gate deletion removed from the catch.** It is correct.
   - The reversal path never writes the record outside a batch, except the final standalone insert. So on any non-unique error, the batch has rolled back and no record exists. The handler rethrows, the route answers an error, and Dodo redelivers.
   - A non-unique error from the standalone `recordCoursePaymentEvent` is rethrown too, and nothing was written.
   - Not deleting is also safer, because a delete could remove a racing delivery's committed row.
   - The non-reversal path keeps `releaseCoursePaymentEvent` (`:151-153`).
3. **No batch applies.** The record is written alone (`:199`).
   - A crash before that write leaves no record and no state change, so the redelivery re-runs the same no-op batches.
   - `reverseReferral` ran only if the order was read as reversible, and it is idempotent. Nothing is lost.
4. **`chargeBackLostCourseOrder`.** `NOT EXISTS (… status = 'refunded' AND COALESCE(attention_reason,'') <> 'dodo_partial_refund')` is equivalent to main's `!(current?.status === 'refunded' && current.attention_reason !== 'dodo_partial_refund')`:
   - a missing order gives an insert in both;
   - a NULL reason counts as fully refunded in both;
   - a partial refund still counts the chargeback;
   - an admin refund (reason = note) counts as full.
   - It reads the order inside the batch, after the gate row with `raw_type` = lost and `course_order_id` = order is written. A racing `refundDisputedCourseOrder` either committed first and is seen, or its `disputed` guard (`NOT EXISTS lost payment_event for o.id`) sees the record and is suppressed. That is the #291 argument.
   - The outbox insert also has `ON CONFLICT (dedupe_key) DO NOTHING` (`outbox.ts:134`), so a second funds-lost type (accepted/lost/expired) cannot double count.
   - The mutation test above shows the guard is exercised.
5. **#291 race tests.** They are not weakened: no assertion was removed, and `gateRows === 1` and a duplicate redelivery were added. Both still fail without the retry (mutation run above).
6. **Non-reversal events.** `payment.succeeded`, `payment.failed`, `dispute.won`/`cancelled` (`DODO_DISPUTE_FUNDS_KEPT`), other `refund.*`/`dispute.*` types, and SePay keep the record-first and release-on-error path (`:135-154`, `:76-79`).
   - The only routing change is `order && (refund.succeeded || DISPUTE_REVOKE)`, where DISPUTE_REVOKE = `dispute.opened` plus accepted/lost/expired.
   - Refund and dispute events without an order already return `null` earlier (`:125`), so the old `unmatched` branch could not be reached for them anyway.
   - The admin refund (`resolveCourseOrder`, `:307`) calls `reverseCourseOrder` without a gate. It is unchanged.
7. **Commission reversal.** The documented residual gap is accurate: Dodo gives up after 8 attempts, or an admin does not retry, and the order stays `paid` with its commission reversed. It is incomplete only for the after-commit path in Minor 2.
8. **`crashingD1`.** It really simulates a crash.
   - The crash throws before `inner.run()` or `base.batch()`, so the matching write and its batch never commit.
   - `dead = true` makes every later `first`/`all`/`run`/`batch` throw, so cleanup cannot run. On `main` this is exactly why the gate survives and 10 tests fail: `releaseCoursePaymentEvent`'s `.catch` swallows the crash.
   - It records every batch's SQL and every standalone run, which the structural tests use.
9. **Scope.** See Evidence: 4 files, no revert, no deleted tests.

## Unresolved questions
- Should Minor 2 (the commission gap after the batch) get a doc clause now, or its own issue?

Status: DONE
Summary: MERGE; 59/59 focused, 2015/2015 full, astro check 0/0, CI Test & Build pass; no blocking findings.
