# Review: PR #356 (fixes #345), head 433636e

fix(payments): record membership and booking payment events inside the fulfilment batch

Reviewed in a detached worktree at `433636ed880915fbcb60856acacd5e143f1572fe` (merge base with `origin/main`: `a6471df`).

## Gates

| Gate | Result |
| --- | --- |
| Diff | 9 files, +555 / -171 (as expected) |
| Fail-on-main (main's `billing.ts`, `store.ts`, `course-order-payments.ts` swapped in) | 19 fail / 50 pass across `billing` + `booking`: membership 8 of 9 new tests fail, booking 10 of 11 new tests fail, plus the rewritten in-flight test fails. Only the two blind-race tests pass on main. Matches the author's claim |
| Focused (`billing`, `booking`, `courses-commerce`, `analytics-outbox`) | 241 pass, 0 fail (4 files) |
| `bun test` | 2193 pass, 0 fail (118 files) |
| `bun run build` | 0 errors, 0 warnings, 89 hints |
| `gh pr checks 356` | Test & Build: pass |
| Merge with PR #355 (`b241499`) | One conflict in `src/lib/courses/course-order-payments.ts`, import block only (line ~17): #355 changes the `../payments/dodo` import to add `DODO_DISPUTE_FUNDS_KEPT`, #356 adds the `../payments/payment-events` import on the next line. Trivial to resolve by keeping both lines. `tests/courses-commerce.test.ts` auto-merges |

## Claims verified

- Both modules follow the pattern. They pre-check with `paymentEventRecorded`. The record is the first statement of the guarded batch and the status update is last. Booking guards on `held AND hold_expires_at >= now`. Membership guards on `pending OR (expired AND attention_reason IS NULL)` and `expires_at >= paidIso`. Neither module deletes the record any more (no `DELETE FROM payment_events` left in either one). The catch maps only `isPaymentEventConflict` and then re-checks the record. On booking, a slot-index unique violation is still told apart from the record conflict and flagged as `late_payment`, as before.
- Guards: a paid, cancelled, confirmed or expired-hold booking can't be confirmed twice. The same holds for a paid or flagged membership order. Every statement in the batch carries the same `EXISTS` guard, and D1 runs the batch as one transaction.
- Membership period extension is idempotent. `rebuildSubscription` recomputes the period from every paid order (`subscriptions.ts:107`), so resuming can't extend it twice. Promo and invoice bookkeeping are guarded on status. The commission is captured once per order. `purchase` uses the dedupe key `billing_order:<id>`. The receipt goes through `sendLoggedEmail`, which claims an `email_log` row (`pending`) before it sends, so even concurrent resumes send one receipt.
- `payment-events.ts` has the same regex and the same SQL as the old course helpers. `course-order-payments.ts` re-exports them and delegates, with no behaviour change.
- `crashingD1` moved to `tests/helpers/d1.ts`. The docs paragraph is accurate.
- Rewritten booking test (admin resolve while the webhook is running): the old interleaving (record written, confirm not yet run) can't happen any more, because the record now commits only with the confirm. The new interleaving (resolve before the batch) is the only real one left. The batch's guard fails, the record is written alone, and the outcome is `already_confirmed` with one purchase. The purchase key changes from `purchase:sepay:7301` to `purchase:sepay:booking:<id>`, because no transaction is recorded when the admin resolves. This follows the documented rule for a resolve without a recorded transaction, and nothing is counted twice. It doesn't hide a regression.

## Findings

### High

**H1. A duplicate delivered while the first delivery is still fulfilling the booking creates a second Meet event and sends a second invite email** (`src/lib/booking/store.ts:727`, with `afterBookingConfirmed` at `:703` and `fulfilBooking` at `:887`).

The resume condition is `status === 'confirmed' && meet_status === null && email_status === null`. That condition is also true for the whole time a live first delivery is between its batch commit and the status write at the end of `fulfilBooking`, which spans the Google token request, `events.insert` and the Resend request. Nothing claims the follow-ups, so a duplicate arriving in that window runs `fulfilBooking` again.

This window is hit in normal operation, not only after a crash. The PayPal return path (`capturePaypalBooking`, `:853`) and the `PAYMENT.CAPTURE.COMPLETED` webhook share the event id (the capture id). PayPal sends the webhook as soon as the capture happens, while the return path is still in `fulfilBooking`. A slow SePay response that SePay retries hits the same window.

Reproduced with a temporary probe test (not committed). Inside the first delivery's mocked Calendar call, a second `applyPayment` with the same notice runs:

```
PROBE sepay:  first=confirmed second=duplicate_event meet=2 emails=2
PROBE paypal: first=confirmed second=duplicate_event meet=2 emails=2
```

On main the second delivery returned `duplicate_event` and did nothing, so this is a regression. The guest gets two calendar events, each with its own Meet link (`sendUpdates=all`), and two confirmation emails. `createMeetEvent` isn't idempotent: its `requestId` only dedupes the conference request, not the event.

The membership side doesn't have this problem, because its receipt claims an `email_log` row first.

Suggested fix: claim the follow-ups atomically before the external calls, on both the first path and the resume path. For example, run `UPDATE bookings SET meet_status = 'pending', updated_at = ? WHERE id = ? AND status = 'confirmed' AND meet_status IS NULL AND email_status IS NULL` and continue only when `changes === 1`. Treat a `pending` claim older than a few minutes as stale and claimable, so a crashed worker can still be resumed. The simpler alternative is to resume only when `updated_at` is older than a stale window. Add a concurrency test like the probe above.

### Medium

None.

### Low

**L1.** `billing.paid` activity detail no longer includes `period_end` (`src/lib/members/billing.ts:425` `paidDetail`). This affects both the batch path and `fulfilOrder`, because the log is now written before the recompute. Nothing in `src/` reads it (`AccountApp.tsx` only maps the action label), and the admin resolve still logs `period_end` in `billing.attention_resolved`. It is a small loss of audit detail. Accept it, or note it in the PR.

**L2.** Booking `purchase` and `payment_needs_attention` are now inside the payment batch (`store.ts:762-766`), so a failing outbox insert fails the booking payment, which is then redelivered. This matches course orders and is documented. Membership keeps `purchase` outside the batch. The author already called this out, and the trade-off is acceptable.

**L3.** Membership resume (`billing.ts:462-495`) reruns all the follow-ups on every duplicate whose receipt is `failed`, or was never logged because the user or subscription is missing. Each follow-up is idempotent, so this only costs work. Booking resume similarly fires for any confirmed booking with both statuses NULL, including any old rows confirmed before fulfilment tracking existed, if one of their events is redelivered. That's unlikely, and it falls under H1's claim fix.

**L4.** Admin Telegram/Discord notices are not resent after a crash past the batch. A Meet or email call that succeeds just before a crash is resent. Both are disclosed, consistent with courses, and acceptable.

## Verdict

**CHANGES.** The crash-safety fix is correct and well tested, and every gate is green. H1 is a new, reproducible double Meet event and double invite on the normal PayPal flow (return path plus webhook) that main didn't have. Add a follow-up claim and a concurrency test, then this can merge. When it rebases onto #355 or #355 lands first, resolve the trivial import conflict in `course-order-payments.ts`.

## Round 2 (head 754993b)

New commits: `84403c7` (merges main `5e122a4`, which contains #355) and `754993b` (the follow-up claim that fixes H1). Reviewed in a fresh detached worktree.

### Gates

| Gate | Result |
| --- | --- |
| `bun install --frozen-lockfile` | ok |
| Focused (`billing`, `booking`, `courses-commerce`, `analytics-outbox`) | 246 pass, 0 fail (4 files) |
| `bun test` | 2198 pass, 0 fail (118 files) |
| `bun run build` | 0 errors, 0 warnings, 90 hints |
| `gh pr checks 356` | Test & Build: pass. PR is `MERGEABLE` |

### 1. The #355 merge

I compared the new head with main `5e122a4`:

- `course-order-payments.ts` differs only by this PR's changes: the added `payment-events` import (next to #355's `DODO_DISPUTE_FUNDS_KEPT, DODO_DISPUTE_FUNDS_LOST` import), the re-export of `isPaymentEventConflict`, and the delegating `coursePaymentEventRecorded`.
- `course-payment-webhooks.ts` is identical to main.
- In `tests/courses-commerce.test.ts`, the only change is the local `crashingD1` being replaced by a wrapper over the shared helper.

Every #355 guard and test is intact.

### 2. The H1 probe

I reran the round-1 probe unchanged: a second `applyPayment` with the same notice runs inside the first delivery's Calendar call.

```
PROBE sepay:  first=confirmed second=duplicate_event meet=1 emails=1 row=[sent,sent]
PROBE paypal: first=confirmed second=duplicate_event meet=1 emails=1 row=[sent,sent]
```

H1 is closed. The claim (`meet_status = 'pending'`) is written in the same statement that confirms the booking (`CLAIM_ON_CONFIRM`). A duplicate takes it only through a conditional `UPDATE` (`claimBookingFollowUps`, `store.ts:712`). Concurrent duplicates race on that single `UPDATE`, so only one wins.

### 3. Lease semantics

- **Can resume be blocked forever?** No. Only these writes refresh `updated_at` on a confirmed booking:
  - the admin `note` and `cancel` actions (`:1113`, `:1115`);
  - `mark_attention`;
  - reschedule, which runs `fulfilBooking` and writes final statuses.

  Nothing writes it on a schedule or repeatedly, so an admin note delays a resume by at most 5 minutes.
- **First delivery stalling past 5 minutes:** this does double-send. I confirmed it with a probe that advances the clock 6 minutes inside the Calendar call (meet=2, emails=2). That is the intended trade-off of a lease. In practice a Worker request can't stall that long, because the provider times out and the request is cancelled. Low.
- **`fulfilBooking` throws:** `createMeetEvent` and `sendEmail` catch their own errors, so only a D1 failure can leave `pending`. The booking then recovers in either of two ways:
  - a redelivery after the lease takes the claim;
  - the admin runs `mark_attention`, then `resolve`. `CLAIM_ON_CONFIRM` keeps `pending`, and `fulfilBooking` still runs because `meet_status !== 'sent'` (`:1132`).

  A direct `resolve` on a confirmed booking still returns 409, as before (it was the same with NULL statuses on main). The admin panel shows "Meet: pending" for a stuck booking. That is honest, if not self-explanatory. Low.
- **Accepted, as in round 1:** a crash after Meet and email succeed but before their status is written still resends, once the lease expires.

### 4. Readers of `meet_status`

Outside `store.ts`, the only readers are:

- `BookingPanel.tsx:87,243`: typed `string`, rendered as text;
- the OpenAPI enum, which now includes `pending`.

The guest view doesn't expose it, and the MCP booking tools return the admin view without branching on it. Internally, admin resolve checks `!== 'sent'`, which treats `pending` correctly. Nothing breaks.

### Remaining

- **L1** (`billing.paid` without `period_end`) is left as-is. The author's reason holds: the period is computed after the batch. It's acceptable.
- **L2 to L4** are unchanged and accepted.
- New Low **L5**: the 5-minute lease can double-send if a first delivery runs longer than 5 minutes. This is theoretical on Workers.

### Verdict (round 2)

**MERGE.** H1 is fixed and verified by the rerun probe, the #355 merge is clean, and every gate is green.
