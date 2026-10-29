# Review: PR #360 (fixes #312), head `f70c5a9`

fix(referrals): reverse course commissions in the same batch as the order. Reviewed in an isolated worktree at the head commit. The merge base is `origin/main` `36043f3` (#358), so the branch is up to date.

## Gates

| Gate | Result |
| --- | --- |
| `git diff origin/main...HEAD --stat` | 6 files, +309 / -34 (as expected) |
| Fail on main (main's 4 source files swapped in, new test file only) | **8 fail, 2 pass**. The 2 that pass are the after-commit crashes on an order read as `paid`. This matches the author's claim. |
| Focused: commission-reversal, courses-commerce, courses-referrals, referrals-* (8 files), billing, billing-attention, booking | 362 pass, 0 fail (14 files) |
| Full `bun test` on this head | **2224 pass, 0 fail (119 files)** |
| `bun run build` | astro check: 0 errors, 0 warnings, 93 hints (none new). Build complete. |
| `gh pr checks 360` | Test & Build: pass. mergeStateStatus CLEAN. |
| Extra probes (temporary file, deleted afterwards) | 4/4 pass: late `dispute.opened` after an early `dispute.won` on a referred, approved order; pending commission; paid-out commission; blocked commission |

## Claims verified

- **Option (a), one batch.** `reverseCourseOrder` (`src/lib/courses/course-order-payments.ts:257-282`) no longer has `commissionFirst` or the post-commit `reverseReferral`. The commission statements sit at :277, before the status `UPDATE` at :278, and use the same `reversible` condition, which includes `onlyIf` from #355.
- **`reverseCommission` untouched.** `refunds.ts:47-72` is identical to main. Membership, booking and admin callers are unchanged.
- **`markSourceReversed`** now runs `markSourceReversedStatement` without `onlyIf`. The SQL is byte-for-byte the old insert.
- **`onCourseOrderReversed` removed.** `git grep` finds no remaining references in `src/` or `tests/`. The callers outside this module (`courses-learning.test.ts:140`, `courses-referrals.test.ts:85`, the webhooks, the admin resolve) call `reverseCourseOrder`, and its signature has not changed.
- **Docs sentence** in `docs/analytics-events.md` is replaced and now describes the batch behaviour accurately.
- **10 new tests** in `tests/courses-commission-reversal.test.ts`.

## Semantic equivalence with `reverseCommission` (`refunds.ts:82-121`)

| Aspect | Old imperative | New statements | Equal? |
| --- | --- | --- | --- |
| Blocked commission | returns `not_reversible`, writes nothing | every statement has `c.status <> 'blocked'`; `noCommission` is false, so no marker | Yes (probe) |
| Status update | `status IN (pending, review, approved)` | same `REVERSIBLE` list, keyed by source | Yes |
| Ledger line | only when a `commission` line with amount > 0 exists; unique key stops a second line | JOIN on the credit line with `amount_cents > 0` plus `NOT EXISTS` reversal; amount `-l.amount_cents` | Yes, sign negative, amount equal (tests assert `-credit`) |
| Repair of an interrupted reversal (status already `reversed`, ledger line missing) | appends the line and logs it | ledger statement ignores status; log condition `status IN REVERSIBLE OR ledgerDue` | Yes |
| Already paid out (no `paid` commission status exists; payouts are ledger lines) | reversal line takes the balance negative | same | Yes (probe: balance `-credit`, one reversal line after a refund and a later `dispute.lost`) |
| Pending/review commission | status only, no ledger line, log with `ledger_reversed: false` | same | Yes (probe) |
| Audit log | written only when changed or ledger reversed; detail `{commission_id, reason, previous_status, ledger_reversed}` | first statement, reads the pre-update row, `json_object` with the same key order, `json('true'/'false')` gives JSON booleans | Yes (test asserts exact detail) |
| No commission yet, referred source | marker `INSERT OR IGNORE`; log only when the insert changed a row | marker log guarded by `sourceUnmarked AND noCommission AND guard` before the marker insert, which is equivalent to "insert would change a row" | Yes (tests: one marker, one log, exact detail) |
| Non-referred source | `onCourseOrderReversed` returned early | marker requires `referrer_user_id IS NOT NULL`; no commission rows match | Yes (5 no-op statements) |
| Partial refunds | any course refund reverses the whole commission | unchanged | Yes |
| Redelivery | idempotent | gate unique key aborts the batch; even without it, every statement is idempotent | Yes |

**Ordering and the guard.** `orderIn` is a self-contained `EXISTS (SELECT 1 FROM course_orders o WHERE o.id = ? AND o.status IN …)`, and `courseDisputesPaired` only uses unqualified columns inside its own `FROM payment_events` subquery. Neither can bind to `referral_commissions` columns (`status`, `id`) in the new `UPDATE` or `SELECT`. Nothing earlier in the batch changes `course_orders.status`: the gate, revoke, activity and money-back statements write other tables. The gate's `dispute.opened` insert only keeps `courseDisputesPaired` true. So every commission statement sees the same guard value as the final status update, and a batch that is guarded out writes no ledger, commission, log or marker rows. Within the commission group the order is correct: the log reads the old status and `ledgerDue` before the ledger insert and status update, and the marker log comes before the marker insert.

**Marker semantics (gap 1).** A crash before or inside the batch leaves no marker, so a later admin grant captures a commission (test 9). A committed reversal of an order with no commission writes the marker once (test 10), so a later capture is skipped.

**#355 dispute ordering.** A late `dispute.opened` after a won or cancelled outcome is guarded out, and the commission stays `approved` with no ledger line, log or marker. A later second dispute still reverses it once (probe). On main, `commissionFirst` reversed the commission before the guarded batch for an order read as `paid`, so this PR also fixes that case. I did not run that case on main; this is from reading the code.

## Findings

- **Low: a referral SQL failure now blocks the order reversal.** `src/lib/courses/course-order-payments.ts:277`. Before, a referral error was caught and logged, and the refund or chargeback still applied. Now a failing commission statement rolls back the whole batch, so the webhook returns an error and Dodo retries. This trade-off is the point of #312, and the statements cannot violate a unique key (`NOT EXISTS`, `INSERT OR IGNORE`). It is acceptable, but nothing documents it outside the PR body.
- **Low: two implementations of the same rules.** `src/lib/referrals/refunds.ts:47-72` (imperative) and `:82-121` (SQL) must now be kept in sync by hand. Membership and booking still use the imperative one. A future change to the reversal rules (a new status, for example) has to touch both. Consider a follow-up issue to move the membership and booking callers onto the statement builder, or a shared test that runs the same table of cases against both.
- **Low: test gaps (probes pass).** The new file covers only approved and credited commissions, plus the no-commission marker. Pending/review, an already paid-out balance, blocked, and the #355 late-opened case with a referral are not asserted. All four passed in my temporary probes. The late-opened case is worth keeping as a regression test, because main got it wrong.
- **Info:** `src/lib/courses/referral-bridge.ts:93` hard-codes actor `'system'` for admin refunds too. This matches main, where `reverseCommission` used its default actor. Five no-op statements run for orders that were not referred, which is negligible.

No High or Medium findings.

## Verdict

**MERGE.** The statement-based reversal matches `reverseCommission` on every case I checked. Every commission statement carries the order guard, including #355's `onlyIf`, and runs before the status update. Gaps 1 and 2 of #312 are closed. All gates are green on this head.
