# Review: PR #287 (closes #281), atomic Dodo reversal log and money back once per payment

Head `14743bc` (`fix/281-dodo-dispute-atomic`). Reviewed in a separate worktree that has since been removed.

## Verdict

**MERGE.** I found no critical or major issues. The batch is atomic in D1 and in the test helper alike. The SQL is valid. The only unique violation the batch can raise comes from the gate. The marker rows do not affect any other reader of `payment_events`. The findings below are minor items and nits that can be fixed later.

## Evidence

- New tests on the PR: `bun test tests/referrals-commissions.test.ts tests/courses-commerce.test.ts` gave 52 pass, 0 fail.
- New tests against main's `src` (`git checkout origin/main -- src docs`, then restored) gave 49 pass, 3 fail:
  - `counts the money back of a course order once ... in either order`
  - `counts the money back of a payment once ... in either order`
  - `leaves a dispute retryable when the worker dies at the activity log`
  - The other new tests pass on main. They pin coverage the issue asked for (opened after lost, renewal lost, course accepted/expired/cancelled). They are not regression tests. See Minor 3.
- Full `bun test`: 1847 pass, 0 fail (109 files).
- `bun run build`: `astro check` reports 0 errors and 0 warnings (902 files), and the build completes.

## Focus answers

**Batch atomicity.**
- D1 runs a `batch()` as one SQL transaction. If any statement fails, the whole sequence rolls back.
- `tests/helpers/d1.ts:53-58` wraps the batch in a `bun:sqlite` `db.transaction`, which gives the same rollback.
- A gate conflict throws `UNIQUE constraint failed`, and the whole batch rolls back. `isUniqueViolation` (`runtime.ts:92`) matches that text in both D1 and bun error messages.

**Swallowing the unique violation.**
- Here is every unique constraint the batch can touch:
  - `payment_events (provider, event_id)`. The gate insert has no conflict clause. The marker insert has `ON CONFLICT DO NOTHING`, which covers all constraints.
  - `analytics_outbox`: `dedupe_key` is covered by `ON CONFLICT (dedupe_key)`. The `id` primary key is a random UUID, and the `DO NOTHING` clause does not cover it, but a collision is negligible.
  - `user_activity` has no unique index.
- So the only real source of a unique violation is the gate, and acknowledging it is correct. The comment at `dodo-billing.ts:716` is accurate.

**`INSERT ... SELECT ... WHERE NOT EXISTS ... ON CONFLICT DO NOTHING`.**
- SQLite needs a WHERE clause on the SELECT of an upsert to resolve a parsing ambiguity. The statement has one: `WHERE NOT EXISTS (...)`, and the SELECT has no FROM.
- It runs under bun:sqlite in the "dispute then refund" test, which fails on main.
- D1 runs the same SQLite parser.

**Marker semantics.**

| Sequence | Result |
| --- | --- |
| Full refund, then dispute lost | Chargeback suppressed |
| Dispute lost, then full or partial refund | Refund suppressed |
| Partial refund, then dispute lost | Both counted (documented, see Minor 1) |
| Dispute opened, then refund, then dispute won or cancelled | Refund counted (the opened dispute writes no marker) |

- **Retries:** a redelivery rolls back at the gate, so the marker is not written twice. The marker also has `ON CONFLICT DO NOTHING`.
- **Concurrent refund and dispute webhooks:** D1 runs one batch at a time. Each guard checks the opposite marker inside its own transaction, so exactly one event is counted.

**Other readers of `payment_events`.**
- The Dodo charge count (`dodo-billing.ts:431,436`) filters on `raw_type = 'payment.charge'` and `raw_type = 'payment.succeeded'`. Marker rows have `raw_type` set to the reversal type, so the count ignores them.
- `cardForPayment` (`:615`) filters on `event_id = 'charge:...'`.
- The booking reader filters on `booking_id`, which is NULL for marker rows.
- Webhook-id dedupe is per `event_id`, so a marker cannot collide with a webhook id.
- Reversals bypass the webhook-id gate (`webhooks/dodo.ts:51`), so the redelivery after a crash is processed again, as intended.

**Course rule.**
- `order` is the status before the update (`course-payment-webhooks.ts:124`). A `refunded` order skips the chargeback.
- A refund of a `charged_back` order matches no row in the update at `course-order-payments.ts:131` and queues nothing.
- Correct as stated in the PR, apart from Minor 2.

**Docs.**
- The `docs/analytics-events.md` text matches the code.
- The rewritten `payment_events` prefix comment (`dodo-billing.ts:372-377`) is accurate.
- The outbox header comment says the batch holds no payment state. That is true, because the commission reversal runs outside the batch.

## Findings

### Critical
None.

### Major
None.

### Minor

1. **A partial refund followed by a funds-lost dispute counts the partial amount twice when the dispute is for the full charge.** `dodo-billing.ts:700-707`.
   - Scenario: a $20 charge, a $5 partial refund, then the cardholder disputes $20 and loses. Analytics records $25 of money back for a $20 payment.
   - Several partial refunds that add up to the full amount, followed by a dispute, behave the same way.
   - The rule is documented as intended ("Partial refunds add up"), so this is a design note, not a bug. If exactness matters, the chargeback amount could be capped at the charge amount minus the partial refunds already recorded. Those amounts are in the `refund.succeeded:*` gate rows of the payment.
2. **Course orders treat a partial refund as a full refund.** `course-payment-webhooks.ts:145,151`.
   - Any `refund.succeeded` sets the order to `refunded`, even a partial one. The new `order.status !== 'refunded'` check then drops a later chargeback for the rest of the order. Analytics undercounts.
   - The membership side does the opposite (partial refunds add up), and the docs present course orders as following "the same rule".
   - The status flip on a partial refund already existed. The skipped chargeback is new.
   - Either note the difference in the docs, or skip only when the refund was full (`partial` false on the queued refund).
3. **The gate-insert crash test does not tell main and the PR apart.** `tests/referrals-commissions.test.ts:488` with `failOn = /INSERT INTO payment_events/`.
   - On main the gate insert itself throws before anything is written, so this case passes there too.
   - Only the activity-log case reproduces the original bug (gate committed, cleanup died).
   - Not wrong, just weaker evidence than the title suggests. A case that dies at the outbox insert (`/INSERT INTO analytics_outbox/`) would also fail on main and would pin the middle of the batch.
4. **No test covers the partial-refund branch.** Two cases would pin the "Partial refunds add up" and "no refund after a chargeback" claims:
   - an `is_partial: true` refund followed by `dispute.lost`, where both should be counted;
   - `dispute.lost` followed by a partial refund, where the refund should be suppressed.

### Nit

1. `dodo.ts:441`: `isPartial` is `d.is_partial === true`. If Dodo ever leaves `is_partial` out of a partial refund, it is taken as full and writes the `full_refund` marker, and a later chargeback is suppressed. Dodo documents the field, so the risk is low. Comparing the refund amount with the charge amount would make the check independent of that field.
2. `outbox.ts:131-139`: the two SQL strings repeat the column list and the `ON CONFLICT` tail. They could share one VALUES-or-SELECT template, though the current form is readable.
3. Already true before this PR, and out of scope here (worth its own issue):
   - Course order: `dispute.opened` sets the order to `charged_back`, then the merchant refunds it, and nothing is queued. Then `dispute.won` or `dispute.cancelled` restores the order to `paid` with access.
   - The result is that a refunded order regains access and its money back is never counted.
   - The membership side handles the same sequence correctly.

## Unresolved questions

- Does Dodo send `refund.succeeded` in addition to an RDR `dispute.lost`? It is still unconfirmed, and the PR guards against both orders anyway.
- Should Minor 2 be fixed here, or tracked as a separate issue? It affects analytics accuracy only, not access or money.
