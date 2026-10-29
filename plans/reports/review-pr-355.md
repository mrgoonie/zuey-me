# Review: PR #355 (fixes #324)

Head `b2414999bc6c61c89fc9ce75e53aaa6acf0a3006`, base `main`. Reviewer worked in an isolated detached worktree.

## Gates

| Gate | Result |
| --- | --- |
| Diff | 3 files, +101 / -24 (`course-order-payments.ts`, `course-payment-webhooks.ts`, `tests/courses-commerce.test.ts`) |
| Fail on main (main's two source files swapped in) | 134 pass / 3 fail: the two `keeps access when dispute.won/cancelled arrives before its dispute.opened` tests and `flags a won dispute of a deleted course for the admin without granting access` |
| Focused `bun test tests/courses-commerce.test.ts` | 137 pass / 0 fail |
| Full `bun test` | 2176 pass / 0 fail (118 files) |
| `bun run build` | 0 errors, 0 warnings (83 hints), build complete |
| `gh pr checks` | Test & Build: pass; mergeable, CLEAN |

Extra probe tests (temporary file, deleted afterwards), 5 pass:
- Race: a `dispute.won` row recorded after the pre-check. `reverseCourseOrder` with `courseDisputesPaired` writes nothing (no record, no revoke) and the order stays `paid`.
- A won redelivered under a new event id swallows the next genuine `dispute.opened` (`ignored`, access kept).
- opened, then refund, then won: answers `ignored` and the order stays `refunded`.
- Deleted course: a won before its opened on a paid order answers `ignored` and the order stays paid; the late opened answers `ignored`; a new opened answers `reversed`; won answers `needs_attention`; a second cycle also answers `needs_attention`, but only 1 `payment_needs_attention` outbox event exists.

## Claims verified

- No migration: the PR uses the existing `payment_events` rows (`provider = 'dodo' AND course_order_id = ?`). It counts `raw_type IN ('dispute.won','dispute.cancelled')` against `dispute.opened`. Refund, lost and membership rows are not counted (membership rows have `course_order_id` NULL). The key is right: the order is found by `provider_payment_id`, and the gate records `event.orderId = order.id`.
- Redelivery under the same event id is stopped by `coursePaymentEventRecorded` / the unique key, so duplicates never inflate the counts.
- The pre-check comes before `reverseCourseOrder`, so the commission is not reversed on the common path. The same SQL is ANDed into `reversible` (`course-order-payments.ts:271-272`), and the gate is the batch's first statement under it. Equivalence holds: the gate's `INSERT ... SELECT WHERE` checks the guard before inserting, and inserting an opened row only raises the right-hand count. So when the gate applies, every later statement in the batch also passes; when it does not apply, all of them fail. The PR's comment (`:362-364`) states this monotonicity correctly. Operator precedence is fine: `<=` binds tighter than `AND`.
- Suppressed opened: falls through to `recordCoursePaymentEvent`, answers `ignored`, and that record restores the pairing. The existing opened -> won -> opened -> lost test and the new "later dispute still reverses" assertion both pass.
- Deleted course on restore (`:398`): `markCourseOrderAttention(..., 'course_missing', {}, gate, [], disputed)`. No grant. `amount + 0`, and `currency_paid` / `payment_ref` / `provider_event_id` are kept through COALESCE. The gate runs under `disputed`; the update, activity log and event run under `unpaid AND disputed`. The update now comes last (`:101-108`), so the `charged_back` guard is still true for the activity log and event. The webhook answers `needs_attention`, which is already in `CoursePaymentOutcome`. No path still throws `course_not_found`: `reverseCourseOrder` / `revokeCourseStatements` accept a null course (probed), and the `gate` parameter of `restoreCourseOrder` is now required, which its only caller already passes.
- #352 merge: with no `onlyIf`, the condition is the unpaid guard alone and `gate()` is unguarded, the same as main. The reorder only moves the update after `also`, the activity log and the event. Those were all guarded by `status <> 'paid'`, which a `needs_attention` update never changes, so the SePay and Dodo flag paths behave the same. All #352 tests pass in the full suite.

## Findings

### High
None.

### Medium
None.

### Low
1. **Per-order counting can swallow a genuine opened** (`src/lib/courses/course-order-payments.ts:367-372`). A won or cancelled row with no matching opened row leaves a surplus that suppresses the next real `dispute.opened` of the order. This can happen when Dodo sends both won and cancelled for one dispute, sends a won under a fresh event id (probed), or when an opened arrived before `provider_payment_id` was set and was handled by the membership path. The effect is bounded: the member keeps access only while that dispute is open, and a later `dispute.lost` still revokes access through the unguarded funds-lost path. This is the limitation the author disclosed, and it is acceptable for a P3. A dispute-id key would need a migration.
2. **A racing outcome still reverses the commission** (`course-order-payments.ts:269-270`). When the won lands between the pre-check and the batch, `reverseReferral` has already run and the batch guard then blocks the reversal. The order stays `paid` with its commission reversed. This race window is narrow, and the result is the same as the documented in-order opened -> won behaviour (the commission stays reversed for the admin to review).
3. **A second `course_missing` cycle gives the admin no new notification** (`course-order-payments.ts:96`, outbox `ON CONFLICT (dedupe_key) DO NOTHING`). The attention reference `course_order:<id>:course_missing` is the same each time, so a second opened -> won cycle on a deleted course flags the order again but queues no second `payment_needs_attention` (probed: 1 event). The order still appears in the admin attention list.

## Verdict

**MERGE.** The fix matches the issue's expected behaviour (won then opened leaves the order `paid` with access kept). The deleted-course path no longer throws. The guard and the pre-check are equivalent, the #352 semantics are preserved, and all gates are green. The Low items are follow-up material and should not block this PR.
