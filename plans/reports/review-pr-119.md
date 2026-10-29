## Review: PR #119 (head 8336f39), closes #100: match Dodo refunds and disputes of renewal charges

**Verdict: APPROVE**

I reviewed this in an isolated worktree at 8336f39, with `origin/main` merged in locally.

### Gates
- `bun install --frozen-lockfile`: OK
- `bun test`: 900 pass, 0 fail (50 files)
- `bun run build`: astro check found 0 errors and 0 warnings (64 hints). Build complete.
- The tests fail on main. I swapped in main's `src/lib/payments/dodo-billing.ts` and ran `tests/analytics-outbox.test.ts` and `tests/referrals-commissions.test.ts`. Three tests failed:
  - The single `billing.card_reversal` entry across a redelivery: 2 entries instead of 1.
  - The new renewal-reversal test.
  - The referral test: `ignored` instead of `renewal`.
- The old `ignored` expectation in `tests/referrals-commissions.test.ts:316` was encoding the bug: `pay_renewal` is a collected charge of the card (line 302). The new assertion that the commission is still `pending` after the renewal refund is a real check.

### Checks
- **Other readers of `payment_events`.** I searched every reader in the repo:
  - `succeededCharges` (`dodo-billing.ts:405`) is the only one that counts by `card_subscription_id`. It filters `raw_type = 'payment.succeeded'`, so the new `payment.charge` rows and the refund/dispute rows (`raw_type = refund.succeeded` and so on) are not counted.
  - The other code is booking, course and SePay. It reads or deletes by its own `event_id` or `booking_id`.
  - No admin view, report or MCP tool reads the table. `tests/booking.test.ts:346` counts the whole table, but only in a booking-only setup.
  - Key namespaces cannot collide: Dodo webhook ids, `charge:<pay>` and `<event type>:<refund/dispute id>` are all distinct.
- **Schema.** The inserted columns (`provider`, `event_id`, `booking_id`, `card_subscription_id`, `amount`, `currency`, `raw_type`, `received_at`) exist: 0005 plus 0011. No migration is needed. `UNIQUE (provider, event_id)` is the dedupe.
- **Concurrent deliveries.** D1 serializes writes and the unique index admits exactly one INSERT. The loser gets `false` and does nothing. Delete-on-throw deletes only the key the same call inserted, and a loser never inserted it, so it cannot remove a row another delivery committed. If the winner throws, it returns 5xx and Dodo retries it.
- **Signature verification.** Unchanged (`webhooks/dodo.ts:23`). Course refunds are still routed first (`applyDodoCourseWebhook`), and card payments have no course order, so they fall through.
- **Code standards.** No `any` and no casts. The activity detail adds only a `renewal` boolean. There is no email or other PII in logs or events.

### Findings
**Critical / Major:** none.

**Minor**
1. `dodo-billing.ts:610-624`: if `logActivity` succeeds and `queueRefund` then throws, the gate row is deleted and the retry writes a second `billing.card_reversal` row. The refund stays deduped by its outbox key, so no money or analytics is affected. The same shape exists in `applyDodoEvent`.
2. `dodo-billing.ts:600-601` and `webhooks/dodo.ts:49`: a refund delivered before its renewal's `payment.succeeded` has been processed returns `ignored` with 200, so Dodo never retries it. This is the same class as the documented pre-deploy limit (rare, since a refund normally follows the charge by more than minutes). Consider returning a retryable status for an unmatched reversal, or noting it next to the known limit.
3. `dodo-billing.ts:606`: when `objectId` is missing, the key falls back to the payment id, so a second partial refund without a `refund_id` would be suppressed. Dodo always sends `refund_id` and `dispute_id`, so this is theoretical. The analytics reference already used the same fallback.

**Nit / follow-up (out of scope)**
- `succeededCharges` counts webhook rows, so one renewal redelivered under two webhook ids is counted twice. This is pre-existing. The new `charge:` rows (one per payment id) could replace it later. Worth its own issue if it matters.

### Business rules (reported, not decided)
- **Access.** Dodo card reversals, first or renewal, never change membership access, now as before; the admin reviews the logged entry. This differs from course orders, where a Dodo refund or opened dispute revokes the course (`course-order-payments.ts:131-139`). PayPal booking reversals also leave the status to the admin (`booking/store.ts:741`). SePay has no refund webhook path.
- **Commission.** Only the first card payment carries a commission (captured in `applyPaymentEvent` when `isFirstPayment`), so leaving it untouched on a renewal refund matches the existing model. Course and PayPal reverse the commission of their single charge.
- A renewal refund is now logged and reported as a `refund` event without changing access or the subscription. That is consistent with the first-payment behaviour.

### Unresolved questions
- Should a refunded or lost-dispute renewal ever reduce access (for example, end the current period)? This is a product decision. The PR deliberately keeps the existing "admin reviews" rule.

Status: DONE
Summary: Correct and well-tested fix. Charge rows do not affect other `payment_events` readers, and the idempotency gate is race-safe. Three minor items, none blocking.
