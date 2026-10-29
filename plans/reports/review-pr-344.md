# Review: PR #344, course payment event recorded in its fulfilment batch (Closes #335)

- Head: `6b782f4c0228016d67b7b8b8a7156aace4356832`, base `origin/main` `0693668` (merge base = main tip)
- Reviewer: isolated agent, did not write the code. Read-only temp worktree, nothing pushed, commented or relabelled.

## Verdict: MERGE

No correctness or regression problem found. The core claim holds: the `payment_events` record is now the first statement of the payment/flag batch, under the payable guard. A crash before or inside the batch leaves no record, and the redelivery pays and grants exactly once. Findings below are Low/Info and work for follow-up issues.

## Gates (run one at a time, foreground)

| Gate | Result |
| --- | --- |
| `git diff --stat origin/main...head` | 6 files, exactly as expected (docs, commerce-events, outbox, course-order-payments, course-payment-webhooks, courses-commerce test). No migrations touched. |
| Fail-on-main (main's 4 source files swapped in under the PR tests) | 104 pass / **18 fail** of 122. The 18 failures are all the new "a payment the worker dies on" tests; the 2 "record already taken" race tests pass on main. Matches the PR claim. Sources restored with `git checkout HEAD -- src`. |
| `bun test tests/courses-commerce.test.ts` | 122 pass, 0 fail |
| learning + referrals + promos-courses | 18 pass, 0 fail (140 total with commerce, matches PR) |
| `bun test` | 2146 pass, 0 fail, 118 files |
| `bun run build` | astro check 0 errors, 0 warnings (83 hints); build Complete, exit 0 |
| `gh pr checks 344` | Test & Build: pass |

I also ran a scratch adversarial test file (6 tests, deleted afterwards; all pass):
- three concurrent Dodo `payment.succeeded` deliveries (`Promise.all`) give one `paid` and two `duplicate_event`, with 1 record, 1 purchase event, 1 invite and 1 receipt;
- two concurrent underpaid SePay deliveries give one `needs_attention` and one `duplicate_event`, with `amount_paid` added once and 1 needs-attention event;
- an admin grant keeps `attention_reason = admin_grant:<note>`;
- `already_owned` is still flagged when an admin grant with no order owns the course, and that access is kept;
- a second SePay transfer to a paid order gives `already_paid` with `duplicate_payment`, then `duplicate_event`, and one receipt;
- after `dispute.opened`, a redelivered `payment.succeeded` is `duplicate_event` and does not re-grant.

## Adversarial checks

- **Concurrent deliveries (both pass the pre-check).** D1 batches are serialised. The second batch's gate is `INSERT ... SELECT ... WHERE EXISTS(payable)` (`course-order-payments.ts:38-42`, `:157`). The order is already paid, so it inserts nothing and every guarded statement is a no-op. `fulfilCourseOrder` then returns false (`:164`). The caller writes `gate().run()` alone (`course-payment-webhooks.ts:111-113`, `:276`). That throws the `payment_events` unique error, which is mapped to `duplicate_event` (`:59`). In the flag paths the gate is unguarded (`course-order-payments.ts:91`), so the racing batch fails on the unique key and rolls back as a whole. Verified empirically (above). OK.
- **Guard failure (paid/refunded/disputed).** When the guard fails, the gate row, the grant (`grantCourseStatements` ANDs `onlyIf` into `inactive`, `course-purchases.ts:83-91`), the order log, the purchase event (`outboxInsertStatement(..., payable)`, `:149`) and the status update are all skipped. Nothing is written or granted. The Dodo payable predicate is still `o.status <> 'paid'` (`course-payment-webhooks.ts:272`), so the predicate is unchanged from main (see I-1).
- **Crash points.** Before the batch: no record, the redelivery pays (tested at the course read). Inside the batch: atomic rollback (tested at invite, grant, purchase event and status update, for both providers). After the batch: the record exists. The redelivery's pre-check finds it and calls `resumeCourseOrderFollowUps` (`course-payment-webhooks.ts:52-54`, `course-order-payments.ts:181-188`). That function re-reads the order, and when it is `paid` without a `sent`/`skipped` receipt it re-runs the follow-ups (tested at the `email_log` insert). OK.
- **Re-running side effects against real keys.**
  - Referral commission: `getCommissionBySource` returns early, the insert uses `ON CONFLICT (source_kind, source_id) DO NOTHING` (UNIQUE in `migrations/0018_courses.sql:290`), and `isSourceReversed` blocks a commission after a reversal (`referrals/commissions.ts:112-135`).
  - Promo: `UPDATE promo_redemptions ... WHERE status IN ('reserved','released')` (`promos/promo-redemptions.ts:143-145`). A second run is a no-op.
  - Invoice: `UPDATE invoice_requests ... WHERE status = 'awaiting_payment'` with `changes !== 1` returning early (`promos/invoice-requests.ts:127-130`). It is activated once, but see L-2.
  - Receipt: `email_log` idempotency key `course-receipt:<id>`.
  - None of these can double.
- **Event ordering.** The refund and dispute path (`applyGatedDodoCourseEvent`) only changes `isUniqueViolation` to `isPaymentEventConflict` (`:237`). A dispute followed by a redelivered payment is a duplicate and does not re-grant (verified). A refund that arrives before any `payment.succeeded` finds no order by `provider_payment_id` and is handed to the membership handler. That is unchanged from main (I-1).
- **SePay key.** The webhook uses `payload.id` (`payments/sepay.ts:139,146`). Reconciliation uses `tx.id` from the SePay transactions API (`members/billing.ts:547,555`). Both are the SePay transaction id under provider `sepay`, so a webhook and a later reconciliation hit the same record. OK.
- **Analytics outbox, no double count.** The purchase dedupe key is still `purchase:<provider>:course_order:<id>` with `ON CONFLICT (dedupe_key) DO NOTHING`. It is now written only inside the guarded batch. `restoreCourseOrder` still queues no purchase. A later admin grant of a refunded order reuses the same key and is ignored. The needs-attention key is `payment_needs_attention:<provider>:<eventId>`, written once with its record. OK.
- **Other paths.**
  - Free enrolment (`course-orders.ts:300-302`): no gate, and the amount is 0 so no purchase event. It still works (suite green).
  - Admin grant/resolve (#334): the reason moved to `CoursePayment.reason`, and `COALESCE(?, ...)` makes it win over `already_owned` as before (verified).
  - `already_owned` is now derived inside the status update from "an active purchase of another order or of no order" (`course-order-payments.ts:154-155`). This matches the old check ("the grant upsert changed 0 rows") in every reachable case. It no longer mis-flags the edge where this order's own purchase was already active. The `when` predicate is evaluated against the pre-update row, so the SePay `expired AND attention_reason IS NULL` guard cannot be broken by the new SET.
  - Bind order checked: the `payment.values`, then reason, user, course, order (IS NOT), then id, then the payable params (`:161-162`).
- **Code rules.** No `any`, no unchecked member-access casts in the changed files. `isPaymentEventConflict` is a type-guarded `instanceof Error` plus a regex on the exact unique key. No migrations edited.

## Author's concerns, judged

1. **The receipt row is the only completion marker.** Acceptable. The receipt is the last step and every earlier follow-up is idempotent on a real key, so re-running is always safe. Two edge cases. With no user email, `afterCourseOrderPaid` returns before `sendLoggedEmail` (`:203-204`), so no `email_log` row exists and the follow-ups re-run on each duplicate. That is harmless. With a `failed` receipt (Resend down), the follow-ups re-run on the next redelivery or reconciliation, which is desirable.
2. **A `pending` receipt delays the retry until it goes stale.** Acceptable. `PENDING_STALE_MS` is 2 minutes (`members/email.ts:22`), well under Dodo's redelivery backoff and the reconciliation cadence.
3. **An admin retry after a post-batch failure gets 409.** Real but low impact. This is pre-existing from #334 and outside this PR's webhook scope. See L-1.

## Findings

### Low

- **L-1: Admin grant cannot resume its follow-ups.** `course-order-payments.ts:381-384`. If `afterCourseOrderPaid` throws after the batch commits, the admin sees a 500. The order is paid, but the receipt (and referral capture, if the throw came before it) never runs, and a retry returns 409 `already_paid`. One option: call `resumeCourseOrderFollowUps` when the grant finds the order already `paid` before throwing 409. The author already flagged this as out of scope, so it needs its own issue.
- **L-2: The invoice admin email is lost on a crash between the status update and the send.** `promos/invoice-requests.ts:127-149`. The `awaiting_payment` to `requested` update commits before the admin emails go out. A resume finds `changes !== 1` and returns, so the email is never sent. The invoice still shows in Studio, so nothing is lost for bookkeeping. This is pre-existing and unchanged by this PR; the PR body's "made retryable" list includes invoice activation, so this is its only gap.

### Info (pre-existing, not introduced here)

- **I-1: Dodo payments still pay any status but `paid`.** `course-payment-webhooks.ts:272` uses `when: "o.status <> 'paid'"`, so a `payment.succeeded` with a new event id pays a `cancelled` (dismissed), `refunded` or `charged_back` order. In practice a refund or dispute needs `provider_payment_id`, which only the payment sets, so a redelivery of that payment is a duplicate (verified for `dispute.opened`). Separately, a refund arriving before its payment is not matched to the course order and falls through to the membership handler. Both behave exactly as on main. Consider an issue if Dodo can send events out of order.
- **I-2: Spurious log and event when the order turns paid mid-flag.** `markCourseOrderAttention` (`course-order-payments.ts:90-100`) guards only the update with `status <> 'paid'`. The activity log and `payment_needs_attention` event are unguarded. If the order becomes paid between the read and the batch, the record is written correctly, but a log row and a needs-attention event are emitted for an order that was not flagged. This is the same as main (both were unconditional there). Cosmetic only, analytics noise.
- **I-3: Membership and booking still write, then delete on failure.** Membership billing (`members/billing.ts:454,493`) and booking (`booking/store.ts:683,731`) keep the write-then-delete pattern. The PR body already acknowledges this, and it needs its own issue.

## Unresolved questions

- Should L-1 and I-3 be filed as new issues (they relate to #335 and #334)? Nothing was filed from this review.
