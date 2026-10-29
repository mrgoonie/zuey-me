# Review: PR #291 (closes #289), a refund during an open Dodo course dispute

Head `b991941` (`fix/289-course-refund-during-dispute`). I reviewed it in a separate worktree (`D:\www\zuey\rv291`), which has since been removed along with its `dist/` and `.wrangler/`.

## Verdict

**MERGE.** I found no critical or major issues. The conditional UPDATE is correct, and the argument for the refund racing a funds-lost outcome holds. The analytics outcomes match #287's once-per-payment rule. Access stays revoked after any refund. The commission is not reversed twice. Minor 1 is a smaller race that is still open (the order status is read before the gate). It is cheap to fix in this PR or as a follow-up issue.

## Evidence

- `bun test tests/courses-commerce.test.ts` on the PR: 25 pass, 0 fail.
- New tests against main's `src` (`git checkout origin/main -- src`, then restored; `git status` was clean afterwards): 20 pass, 5 fail. These fail:
  - full refund, then `dispute.won`
  - full refund, then `dispute.cancelled`
  - partial refund, then `dispute.won`
  - partial refund, then `dispute.cancelled`
  - `reports no chargeback when a dispute refunded in full is then lost, and a partial refund keeps the chargeback`
  - `reports no refund after an opened dispute was lost` passes on main. The PR body calls it a guard test, which is correct.
- Full `bun test`: 1911 pass, 0 fail (111 files).
- `bun run build`: `astro check` reports 0 errors and 0 warnings, and the build completes.

## Focus answers

**The SQL** (`src/lib/courses/course-order-payments.ts:171-174`).
- The statement is valid SQLite. The correlated `course_orders.id` inside the `NOT EXISTS` resolves to the row being updated.
- There are three placeholders in the `IN` list (`dispute.accepted`, `dispute.lost`, `dispute.expired`), bound after `order.id`. The bind order matches.
- `course_order_id` is set on every Dodo dispute gate row, because `recordCoursePaymentEvent` is called with `order.id` once `orderByPaymentId` has matched.

**Racing a funds-lost outcome, in both orders.** D1 runs one statement at a time. The two handlers do this:
- Refund: gate INSERT, then one UPDATE that checks `status = 'charged_back' AND NOT EXISTS (funds-lost row)`.
- Funds-lost: gate INSERT, `reverseCourseOrder` (does nothing, the order is already `charged_back`), then the order is read again.

| Interleaving | Result |
| --- | --- |
| The lost gate row is written before the refund UPDATE | The UPDATE matches nothing, so the refund is suppressed. The read sees `charged_back`, so one chargeback is counted. |
| The refund UPDATE runs before the lost gate row is written | The order is `refunded` and the refund is queued. The read comes after the lost INSERT, so it sees `refunded`. Full refund: chargeback skipped. Partial refund: chargeback counted, which is the #287 adding-up rule. |

- A check-then-act race needs a gap between the check and the write. The refund side has none, because the check is inside the UPDATE. The lost side writes its gate row before it reads.
- So "check after writing" is sound without a cross-request transaction.
- If the lost handler throws after its INSERT, the catch block releases the gate row. A refund it suppressed in the meantime stays suppressed, and the redelivered outcome counts the chargeback, so the money is still counted once.

**Analytics vs #287** (keys `refund:dodo:course_order:<id>:refunded` and `…:charged_back`).
- Opened, partial refund, lost: refund (partial) and chargeback are both counted, as #287 does for a paid order.
- Opened, full refund, lost (also accepted or expired): refund only.
- Opened, lost, refund (full or partial): chargeback only.
- A second refund after the first: `refunded` matches neither branch, so it queues nothing ("only the first refund is counted", already documented).
- Exactly 1 `purchase` in every case; no won path re-queues one.

**Redelivery.** The webhook-id gate in `payment_events` returns `duplicate_event`, and the outbox `dedupe_key` is unique. The tests redeliver both the refund and the outcome.

**No access restore.** `restoreCourseOrder` needs `charged_back`, and the order is now `refunded`, so won and cancelled return `ignored`. This holds after a partial refund too. `refundDisputedCourseOrder` neither grants nor revokes access: access was already revoked at `dispute.opened`.

**Referral commission.**
- `dispute.opened` reversed it through `reverseCourseOrder`.
- `refundDisputedCourseOrder` does not call `onCourseOrderReversed`, so it is not reversed twice.
- A won dispute no longer reaches `fulfilCourseOrder`, so it is not re-captured either.

**Admin flows** (`resolveCourseOrder`, `course-order-payments.ts:217-238`).
- `grant` on a `refunded` order still pays it again. That is what it did before for any refunded order. The purchase key `course_order:<id>` prevents a second `purchase`.
- `refund` on a `charged_back` order still answers 409 (unchanged).
- No admin code or UI treats `charged_back` and `refunded` differently: `CourseOrderStatus.tsx:119` and `checkout-markdown.ts:65` show both as "reversed". The new `charged_back` to `refunded` transition breaks nothing.

## Findings

### Critical
None.

### Major
None.

### Minor

1. **The branch uses the order status read before the gate, so a refund racing `dispute.opened` or `dispute.won` is still dropped.** `src/lib/courses/course-payment-webhooks.ts:124,150-153`.
   - `order` is read at line 124, before `recordCoursePaymentEvent`, and line 150 picks the code path from that copy.
   - Scenario A (refund racing `dispute.opened`):
     - The refund reads `paid`.
     - `dispute.opened` commits `charged_back`.
     - `reverseCourseOrder` (`status IN ('paid','needs_attention')`) matches nothing, so the result is `ignored`. The gate row stays, so a redelivery is a `duplicate_event`.
     - A later `dispute.won` restores access, and the refund is never counted. This is the #289 bug, reached through a race.
   - Scenario B (refund racing `dispute.won`):
     - The refund reads `charged_back`.
     - `won` commits `paid` and grants access.
     - `refundDisputedCourseOrder` matches nothing, so the result is `ignored`. Access stays restored although the money went back.
   - The window is small. A dispute alert (Ethoca or Verifi style) that triggers an automatic refund as the dispute opens makes Scenario A plausible.
   - Fix: when the chosen UPDATE matches nothing, read the order again and, if its status changed, run the other branch once. This makes "counted once" in the PR body hold for every race, not only refund against funds-lost.
2. **Reconciliation guidance is now wrong for this path.** `docs/analytics-reconciliation.md:185`.
   - The doc says to "compare course refund counts exactly and amounts only as an upper bound".
   - After opened, partial refund, lost: D1 has one `refunded` row, but the outbox has two `refund` rows (`…:refunded` and `…:charged_back`). Their amounts (for example 10 + 49) exceed the D1 amount (49).
   - The query also filters on `updated_at`. The lost outcome does not change `updated_at`, so the chargeback row can fall into a different window than the order.
   - The same was already true after #287 for a partial refund of a paid order followed by a lost dispute. This PR edits the same section (line 189), so it is the right place to say it. Add one sentence: an order with a `dodo_partial_refund` reason and a funds-lost dispute has two `refund` rows, and its amounts can exceed the D1 amount.
3. **A failure after the UPDATE loses the refund for good.** `course-order-payments.ts:175-177`.
   - If `logActivity` or `queueCourseMoneyBack` throws, the catch block at `course-payment-webhooks.ts:170-172` releases the gate row, but the order is already `refunded`.
   - The redelivery reaches `reverseCourseOrder`, which matches nothing, so the result is `ignored` and the `refund` is never queued.
   - This is the same pattern `reverseCourseOrder` already has (UPDATE, then queue), so it is not a regression. It is worth its own issue: write the UPDATE, the activity log and the outbox row in one `d1.batch`, as #287 did for memberships.

### Nit

1. `refundDisputedCourseOrder` scans `payment_events` with no index on `course_order_id` (none in `migrations/`). The path is rare and the table is small, so this is acceptable. Add an index only if the table grows.
2. `docs/env-setup.vi.md`: "hoàn tiền được ghi một lần" reads more naturally as "khoản hoàn tiền được ghi nhận một lần". The rest of the Vietnamese is correct and matches the code: any refund, partial or full, keeps access revoked.
3. Test coverage: no test covers a full refund during the dispute followed by both `dispute.accepted` and `dispute.lost`. The code handles it (each outcome reads `refunded` again), but a test would pin the "one gate per outcome type" behaviour. There is also no test that the referral commission stays reversed once (status `reversed`) after a refund during the dispute.

## Docs accuracy

- `docs/analytics-events.md`, the `refund` row and the "Dodo refunds of renewals" course paragraph: these match the code. That covers the same-statement check, the skip after a full refund and the count after a partial one, and the rule that a refund after a funds-lost outcome queues nothing.
- `docs/analytics-reconciliation.md:189`: accurate. Minor 2 is about line 185.
- `docs/env-setup.vi.md:140`: accurate (Nit 2).
- No endpoint changed, so no OpenAPI or Scalar update is needed.

## Unresolved questions

- Should Minor 1 be fixed in this PR (cheap: read the order again and retry once) or filed as a follow-up issue? It is the #289 scenario reached through a race, so fixing it here keeps the issue's guarantee whole.
