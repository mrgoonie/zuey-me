# Review: PR #352 (fixes #347)

Head `d981e41e4da48bb210f07e9f7a6198671b3ffe90`. The reviewer did not write this change.

## Gates

| Gate | Result |
| --- | --- |
| `git diff origin/main...HEAD --stat` | 2 files: `src/lib/courses/course-order-payments.ts` (+8/-5), `tests/courses-commerce.test.ts` (+43) |
| Fail-on-main (main's `course-order-payments.ts` + PR tests) | 132 pass / **2 fail**: both "payment wins" tests (dodo, sepay). The two "flag wins" tests pass on main, as expected (they are the control) |
| `bun test tests/courses-commerce.test.ts` (PR head) | 134 pass / 0 fail. No other test file calls the changed function or its webhook callers |
| `bun test` (full) | 2164 pass / 0 fail, 118 files |
| `bun run build` | astro check: 0 errors, 0 warnings, 83 hints; build Complete |
| `gh pr checks 352` | Test & Build: pass (2m56s) |

## Correctness

- **The guard is the same in all three statements.** One `SqlCondition` (`unpaid`) is built once and passed to the UPDATE (`WHERE id = ? AND EXISTS(...)`), to `activityStatement(..., onlyIf)` and to `outboxInsertStatement(..., undefined, onlyIf)`. Both helpers turn it into `INSERT ... SELECT ... WHERE <cond>` (`src/lib/members/users.ts:178`, `src/lib/analytics/outbox.ts:132`). A D1 batch runs as one transaction, and the guard is re-evaluated per statement after the UPDATE. The UPDATE only sets `needs_attention`, which is still `<> 'paid'`, so the log and event see the same result the UPDATE saw. The `also` statement (Dodo payment id) does not touch `status`.
- **No legitimate flag is dropped.** The predicate is still `status <> 'paid'`, exactly as main's UPDATE had it (`course-order-payments.ts:98`). `pending`, `expired`, `needs_attention`, `refunded`, `charged_back` and `cancelled` all pass the guard, as before. Callers only reach `markCourseOrderAttention` for orders that were not `paid` when read: SePay `already_paid` is handled at `course-payment-webhooks.ts:78`, Dodo at `:247`. So the guard only matters in the race.
- **The record stays unguarded.** `gate()` is called with no condition (`:94`), so a redelivery is `duplicate_event` (asserted in the tests). This is consistent with #344.
- **No unguarded inserts left in the file.** Every other `activityStatement` / `outboxInsertStatement` / `courseMoneyBackStatement` in the file already has a guard: `payable` (:152, :162), `reversible` (:265, :270), `disputed` (:304, :307, :367), `notFullyRefunded` (:327).

## Tests

The race is real, not a tautology. In `racingFlag('before')`, the order is paid from inside the `crashingD1` predicate, which runs over the batch's statements before `base.batch` executes (`tests/courses-commerce.test.ts:935`). So the order is unpaid when the handler reads it and paid when the batch commits. On main the "payment wins" pair fails, and with the fix it passes. The "after" variant is a useful control: it shows the guard does not suppress a flag that really committed. The `isFlag` regex matches the UPDATE text, which starts with `UPDATE course_orders SET status = 'needs_attention'`.

## Findings

- **Low:** `tests/courses-commerce.test.ts:1221` (the payment-wins case). The test does not assert that `amount_paid` and `attention_reason` were left unchanged on the paid order. That guard predates the PR, but asserting it would pin the whole "flag never took effect" claim. This is optional.
- **Low (pre-existing, author concern (a)):** `course-payment-webhooks.ts:94-95` and `:264-265`. When the payment wins, the handler still returns `needs_attention`. `src/pages/api/webhooks/{sepay,dodo}.ts` then sends the admin announcement "Thanh toán cần kiểm tra" (`order-notify.ts:52`) for an order that shows `paid`, with no `attention_reason`, and without the second payment's amount on it. The extra money is recorded only in `payment_events`. This does not regress main (main's UPDATE was already guarded, and main additionally wrote a misleading log and event). In practice the notification is now the only signal that a second payment arrived. It belongs in a follow-up issue, not this PR. Possible fix: when the UPDATE changed no row, return `already_paid` and set `attention_reason = COALESCE(attention_reason, 'duplicate_payment')`, as the non-race SePay path does at `:78-84`.
- **Low / acceptable (author concern (b)):** `course-payment-webhooks.ts:262`. The `provider_payment_id = COALESCE(provider_payment_id, ?)` update runs unguarded. An order paid by a racing Dodo payment already has `provider_payment_id` set, so this is a no-op. An order paid by SePay or an admin grant gets the racing Dodo payment id. That helps a later refund of that captured card payment. It is not a bug.

## Verdict

**MERGE.** The fix is minimal and correct. The guard is the same in all three statements and matches main's predicate. The tests fail on main and pass on the PR, and all gates are green. The `needs_attention` outcome on a lost race (a) is worth its own follow-up issue.
