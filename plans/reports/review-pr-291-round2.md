# Review round 2: PR #291 (closes #289), a refund during an open Dodo course dispute

Head `195fed3`, one commit on top of `b991941`: `fix(courses): apply a refund that races a dispute opening or being won`. I reviewed it in a temporary worktree (`%TEMP%\r291b`), which I removed afterwards together with its `dist/` and `.wrangler/`. I did not push, comment or change labels.

## Verdict

**MERGE.** Round 1 Minor 1 (a refund racing `dispute.opened` or `dispute.won` was dropped) is fixed, and the new race tests check it for real: they fail without the fix. Round 1 Minor 2 (reconciliation doc), Nit 2 (Vietnamese wording) and Nit 3 (test coverage) are also addressed. I found no double counting, no lost refund, no idempotency regression and nothing blocking. One narrow window is left (Minor 1 below). It is much smaller than the bug that was fixed, and it is not a regression.

## Evidence

- `bun test tests/courses-commerce.test.ts`: 29 pass, 0 fail (25 in round 1, plus 4 new tests).
- **Are the race tests real?** I put back `b991941`'s `src/lib/courses/course-payment-webhooks.ts` and kept the new tests. Result: 27 pass, 2 fail, and the 2 failures are exactly the race tests:
  - `applies a refund that races dispute.opened, so the won dispute restores nothing`
  - `applies a refund that races dispute.won, so access does not stay restored`

  So the `racing()` D1 wrapper really runs the other webhook between the gate INSERT and the UPDATE. Its check `values[1] === eventId` matches the bind order of `INSERT INTO payment_events (provider, event_id, …)` in `course-order-payments.ts:32`. I restored the file afterwards, and `git status` was clean.
- Full `bun test`: 1915 pass, 0 fail (111 files).
- `bun run build`: `astro check` reports 906 files with 0 errors, 0 warnings and 69 hints, and the build completes.

## How the retry plays out (`src/lib/courses/course-payment-webhooks.ts:150-160`)

The handler picks a branch from the order it read before the gate (`charged_back` goes to `refundDisputedCourseOrder`, anything else to `reverseCourseOrder`). If that update matches nothing, it reads the order again. If the status changed, it runs the matching branch once more.

| Refund read | Committed in between | Re-read | Result |
| --- | --- | --- | --- |
| `paid` | `dispute.opened` | `charged_back` | `refundDisputedCourseOrder` sets `refunded` and queues `…:refunded`. A later won or cancelled dispute is `ignored`. |
| `paid` | `opened` and a funds-lost outcome | `charged_back` | The `NOT EXISTS` finds the lost row, so the refund is suppressed. The lost handler counts the chargeback once. |
| `charged_back` | `dispute.won` | `paid` | `reverseCourseOrder` sets `refunded`, revokes access, reverses the commission and queues `…:refunded`. |
| `paid` | another refund (a different webhook id) | `refunded` | The retry matches nothing, so the result is `ignored`. No second refund is counted. |
| `refunded` | n/a | unchanged | No retry. The result is `ignored`, as before. |
| `charged_back`, lost already recorded | n/a | unchanged | No retry. The refund stays suppressed. |

- **Double counting.** Not possible. Both branches queue the same outbox key, `course_order:<id>:refunded`, and at most one of the two conditional UPDATEs can match, because each needs a status the other one changes. The retry runs only once.
- **Idempotency.** The webhook-id gate is unchanged. If the extra `getCourseOrderByCode` throws, nothing has been written yet, and the catch block releases the gate row.
- **The reason is computed from the stale order.** `isPartialCourseReversal(order, amount)` depends only on `amount_paid` and `currency_paid`, and no dispute handler changes those. So it is correct.
- **Referral commission when the refund races a won dispute.** `restoreCourseOrder` calls `fulfilCourseOrder`, which runs `onCourseOrderPaid`. The retried `reverseCourseOrder` then runs `onCourseOrderReversed`. The commission ends `reversed`, which is correct for refunded money. Re-capturing on a won dispute was already the behaviour before this PR.

## Findings

### Critical
None.

### Major
None.

### Minor

1. **A refund that lands inside `dispute.won`'s own handler can still leave access granted.** See `course-order-payments.ts:205-209` and `:142-145`.
   - `restoreCourseOrder` first commits `status = 'paid'`. It then awaits `fulfilCourseOrder`, which calls `grantCourse`.
   - Suppose the refund's retry runs between those two steps:
     - `reverseCourseOrder` sets `refunded`.
     - It looks for an `active` `course_purchases` row. The row is still revoked from `dispute.opened`, so it skips `revokeCourse`.
     - The won handler then runs `grantCourse`, which reactivates the purchase (`ON CONFLICT … SET status = 'active'`).
   - End state: the order is `refunded` and the money was counted once, but the member has access again.
   - The window is a few awaits inside one worker, far smaller than the gap between the order read and the update that this PR closed. The same pattern already exists for `payment.succeeded`'s fulfilment racing an admin or Dodo refund of a `paid` order, so this is not a regression.
   - Possible fix: in `restoreCourseOrder`, read the status again after `fulfilCourseOrder`, or call `grantCourse` only while the order is still `paid`. A follow-up issue is enough. It does not block this PR.

### Nit

1. The retry runs once. If the status changes twice during the window (for example `opened`, then `won`, both while the refund is in flight), the second attempt also matches nothing and the refund is `ignored`. That needs two dispute webhooks inside one refund handler's few milliseconds, so it is not worth a loop.
2. Deferred Minor 3 from round 1 (a throw after the UPDATE loses the refund) is unchanged. The retry adds only a read before any write, so it is not worse.

## Docs accuracy

- `docs/analytics-events.md`: the new sentence ("reads it again when its update matches nothing and applies the refund once on the current status") matches lines 153-159.
- `docs/analytics-reconciliation.md:185`: the new exception covers round 1 Minor 2 accurately:
  - A partial refund (also during a dispute) followed by a funds-lost outcome gives one D1 `refunded` row and two outbox `refund` rows.
  - Their total can exceed the amount paid.
  - The `…:charged_back` row can fall into a later `updated_at` window.

  This is consistent with `course-payment-webhooks.ts:168-170`, where the funds-lost path writes no `updated_at`.
- `docs/env-setup.vi.md:140`: now reads "khoản hoàn tiền được ghi nhận một lần" (round 1 Nit 2).
- No endpoint changed, so no OpenAPI or Scalar update is needed.

## Tests added

- `reports no chargeback for any funds-lost outcome after a full refund during the dispute`: covers `dispute.accepted` then `dispute.lost` after a full refund. Only `…:refunded` is queued (round 1 Nit 3).
- `reverses the referral commission once when the order is refunded during a dispute that is then won`: the commission is `reversed` and there is exactly one `commission.reversed` event (round 1 Nit 3).
- Two race tests using the `racing()` D1 wrapper. Both fail without the fix (see Evidence).

## Unresolved questions

- Should Minor 1 (the gap between `restoreCourseOrder`'s UPDATE and its grant) be filed as its own issue? The AGENTS.md workflow says to file it rather than widen this PR.
