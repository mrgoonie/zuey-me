# Review: PR #373 (fixes #369) — late Dodo payment.succeeded on a refunded / charged-back course order

Reviewed head `4d387e2` (base `d99bae4`; `main` has since moved only by an unrelated taxonomy commit #370).

## Verification

- New tests on the base source (PR's `course-payment-webhooks.ts` swapped for `d99bae4`'s): **7 fail, 2 pass**. The 2 that pass are the expired/flagged baseline checks, as the PR says.
- `bun test tests/courses-commerce.test.ts`: 160 pass, 0 fail.
- `bun test`: 2271 pass, 0 fail (121 files).
- `bun run build`: astro check 0 errors, 0 warnings (98 hints), build complete.
- `gh pr checks 373`: Test & Build pass.
- Probe tests (not committed) went through the real `/api/webhooks/dodo` route with a mocked Telegram fetch. Results are below.

## What is correct

- The core bug is fixed. A refunded or charged_back order is caught before any pay path runs (`course-payment-webhooks.ts:278`). The pay guard is now `o.status <> 'paid' AND NOT (o.status IN ('refunded','charged_back'))` (`:311`). It is part of `payable`, which guards every statement of the fulfil batch, the gate included, so a refund or dispute that commits in between makes the whole batch a no-op. The re-read then takes the settled path (`:315-316`).
- The `payment_events` gate stays the first statement of every batch and is never deleted. Only the unique-key error is mapped to a duplicate (`isPaymentEventConflict` at `:62`, plus a re-check that the record exists).
- Flag path: the `open` guard goes to `markCourseOrderAttention` as `onlyIf`. That function puts it into the gate, the log, the event and the status update, and the PR adds it to the payment-id `UPDATE` too (`:295-299`). A refund landing in between leaves the order `refunded` and is answered `ignored` (test at the "admin refunds between the read and the flag batch" case).
- The refunded order's `attention_reason` (`dodo_partial_refund`) is preserved. Probe: partial refund, then a late payment, then `dispute.lost` keeps `dodo_partial_refund`, and the chargeback is still counted (`refund` and `chargeback` events both emitted).
- `dispute.won` after a late payment still restores the order (test). `dispute.lost` / `cancelled` are unaffected because the order status is not touched.
- pending → paid, expired → paid and needs_attention → paid still work. user_mismatch, provider_mismatch, underpaid and course_missing flags are unchanged for open orders (the existing suite is green).
- HTTP: `ignored` and `needs_attention` both answer 200 (probe: `200 {"outcome":"ignored"}`), so Dodo stops retrying. No infinite-retry risk.
- AGENTS.md TS rules: no `any`, no unchecked casts, and `import type` is used for `SqlCondition`.

## Findings

### High
None.

### Medium

**M1. The admin notice for a new capture on a closed order names the wrong payment and amount. The order also never appears in the admin queue, so this money can be forgotten.**
`src/pages/api/webhooks/dodo.ts:38-46` builds the notice from the `course_orders` row (`amount_paid`, `provider_payment_id`). `settledCoursePayment` (`course-payment-webhooks.ts:255-271`) deliberately leaves that row untouched, so the notice shows the original, already-refunded payment.

Probe: order paid with `pay_first` ($49), refunded, then `payment.succeeded` `pay_second` for $25. Telegram text received:
`⚠️ Thanh toán cần kiểm tra … Số tiền: 49.00 USD … Mã giao dịch: pay_first`.

Failure scenario: the admin looks up `pay_first` in Dodo, sees it is already refunded, and closes the alert as noise. In the studio the order is `refunded` with no attention reason, so it is not in the default `needs_attention` filter (`course-orders-review.tsx:84`) or any attention list. The only record of `pay_second` is the `courses.order_attention` activity row and an analytics outbox event, and no admin surface lists either. A refund of `pay_second` made later in Dodo does not match any course order (`orderByPaymentId` returns null). It falls through to the membership handler and is `ignored` (probe), so nothing ever records that it was settled.

Fix (small): carry the event's own `payment_id` and amount in `CoursePaymentResult` (for example optional `payment_ref`/`amount`), and have the route prefer them over the row. Ideally also show a reason in the text (`payment_after_refund`). Keeping the status unchanged is reasonable, because it preserves the dispute.won restore and #368's grant block. But then the push notice is the only signal, so it has to name the right capture.

### Low

**L1. A redelivery of the new-capture event under a new event id duplicates the log, the analytics event and the notice.** The `needs_attention` event's `reference` is `p.eventId` (`:263`). Probe: two event ids for the same `pay_second` give 2 `courses.order_attention` rows and 2 Telegram notices. Using `p.paymentId` as the reference would dedupe the analytics event. The log and notice would still repeat, which is tolerable.

**L2. Flag-path edge where the event is not recorded** (`:299-303`). The `open` guard fails because a dispute opened, and then `dispute.won` restores the order to `paid` before `settledMeanwhile()` reads it. In that window the function returns `needs_attention` without writing the gate. Dodo got a 200, so the event is simply never recorded and a later redelivery is processed as new (it then takes the `already_paid` path). The outcome is harmless, but it breaks the "always recorded once" invariant. Falling back to `await gate().run()` when `settled` is null would close it.

**L3 (pre-existing, outside this PR; suggest separate issues per AGENTS.md):**
- A flagged order redelivered under a new event id adds the money again. Probe: underpaid `pay_low` ($1) delivered under 2 event ids gives `amount_paid = 200`. `markCourseOrderAttention` adds `amount` without checking the payment id.
- A dismissed (`cancelled`) order is reopened to `needs_attention` by a late redelivery. Probe confirms. A full-amount one would pay it and grant access, because `cancelled` is not in `SETTLED_SQL`.
- A second capture with a new payment id on an already `paid` Dodo order is silently `already_paid` (probe), with no notice. This is the same money-at-risk class as M1.
- The truly out-of-order case (refund delivered before the order has a `provider_payment_id`) cannot match the order and is dropped. The late payment then pays it. This needs the refund to be parked or looked up, and is not addressed here (nor claimed).

## Design note (not surfacing the new-id case in the status-filtered queue)

Not changing the status is the right call for correctness: re-flagging a `charged_back` order would break the dispute.won restore and let an admin grant through #368's block. The cost is that the money is tracked only by a push notice and an activity row. With M1 fixed the notice is actionable. A durable fallback would be better still: list `courses.order_attention` rows whose order is refunded or charged_back in the billing attention panel. That could be a follow-up issue rather than part of this PR.

Verdict: CHANGES
