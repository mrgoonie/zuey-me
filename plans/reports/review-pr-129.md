# Review: PR #129 — fix(booking): record a purchase when an admin resolves a flagged booking (closes #114)

Head: 662fcad908becfecad93e383c77373b51a2aaa80 (confirmed from author worktree reflog `agent-a00bbd574af06b853`), base 850c4d8.
Files: `src/lib/booking/store.ts` (+38/-1), `tests/booking.test.ts` (+74), `docs/analytics-events.md` (+2/-2).

**Verdict: REQUEST_CHANGES** (one cheap fix, F1).

## Gate evidence / limitations

- The local Bash tool was dead for this whole session: every command, `echo hi` included, returned empty output and had no side effects, so the temporary worktree was never created. It does not exist, so there was nothing to clean up.
- So these did **not** run locally: `bun test`, `bun run build`, the merge with latest main, and the check that the new tests fail against main's `store.ts`.
- CI check run "Test & Build" on 662fcad: **success** (GitHub check-runs API). It covers the PR head only, not a merge with current main.
- Fail-on-main, checked statically: on main `adminUpdateBooking` resolve never calls `queuePurchase`. So every new test's `purchases()` assertion would see 0 rows and fail. Exception: in "webhook then resolve: a booking the webhook already counted" the webhook already queues the row, so that test passes on main too. It is a regression guard, not a failing test.
- No PR comment was posted (`gh` needs the shell). The parent should post the summary below.

## Findings

### F1 (Medium, required): analytics query can abort the resolve after the status commit
`store.ts:971-973` (called at `store.ts:1028`): `queueResolvedPurchase` runs `SELECT ... FROM payment_events` outside any guard. It runs after the `status = 'confirmed'` UPDATE has committed and before `fulfilBooking`, `settleBookingExtras` and `captureReferralCommission`.
- What goes wrong: if this read fails (a transient D1 error), the admin gets a 500 while the booking is already confirmed. A retry returns `409 already_confirmed`. The guest never gets the invite or email, and the referral commission is never captured.
- Why it is new: on main the email step ran right after the UPDATE.
- Contract broken: `docs/analytics-events.md:113` says a failed outbox "never changes a webhook's answer". `commerce-events.ts:4` says the builders "never throw". `queuePurchase` keeps both promises; the new wrapper does not.
- Fix (either one):
  - wrap the body of `queueResolvedPurchase` in `try { ... } catch (err) { console.warn('analytics: could not queue booking purchase', errorMessage(err)); }`, or
  - move the call after the fulfilment, extras and commission steps.
  
  The first keeps the webhook's order (purchase queued before the email).

### F2 (Low): durable double count after the 30-day outbox purge
`store.ts:974-983` + `docs/analytics-events.md:118`.
- Dedupe against an earlier webhook purchase depends on that outbox row still existing. Delivered rows are purged 30 days after `sent_at` (`OUTBOX_SENT_RETENTION_MS`), and each row's uuid is random (`outbox.ts:109`), so PostHog will not dedupe either.
- Failure case: the webhook confirms a booking, then more than 30 days later an admin runs `mark_attention` + `resolve` (or `cancel` + `resolve`). A second `purchase` is emitted.
- The docs' retention bullet still says "Dedupe keys are not needed after that window". This PR makes that claim false.
- Options:
  - (a) Skip the purchase when a payment event exists and `attention_reason` is NULL or `'admin'`. That combination only happens for a booking a webhook already confirmed: `markAttention` always overwrites the reason with `amount_mismatch` or `late_payment`.
  - (b) At minimum, add the caveat to the retention bullet.

### F3 (Low): revenue split across providers or after a manual resolve
- `store.ts:978-980`: only the first event's provider and currency are summed. If a guest pays part by SePay and part by PayPal (that mismatch flags as `amount_mismatch`), the second rail's money is dropped. Rare; mention it in the docs or accept it.
- `store.ts:986-992`: a booking resolved with no recorded transaction uses the key `booking:<id>`. If a transfer for it is recorded later (`already_confirmed`) and the admin then cancels and resolves again, the key switches to `purchase:sepay:<event>` and a second purchase is emitted. This is an edge of F2's class; option (a) there would not cover it. Accept it, or reuse `booking:<id>` whenever `row.amount_paid` is null.

### F4 (Info): unindexed lookup
`payment_events` has no index on `booking_id` (migration 0005 has only `UNIQUE(provider, event_id)`). The new query scans a table shared by billing, courses and Dodo. It is admin-only and rare, so this is acceptable for now. If it is ever needed, add it in a new numbered migration.

## Checks that passed (verified by reading the code)
- **Dedupe key matches the webhook.** Both paths build `purchase:<provider>:<event_id>` from `PurchaseInput.transactionId` (`commerce-events.ts:70`). The claim "the confirming event is the first linked event" holds: `applyPayment` confirms only from `status='held'`, and any earlier linked event would have flagged the booking. Unmatched events are stored with `booking_id NULL`. Events whose processing failed are deleted (`store.ts:731`).
- **Race between resolve and webhook.** Every interleaving yields one key. Either the admin's SELECT sees the webhook's event (same key), or the webhook ends at `already_confirmed`.
- **Free or unpriced bookings.** The amount is 0 or null, so `queuePurchase` returns `rejected` and no event is sent.
- **No PII.** Properties are limited to `provider`, `order_type`, `amount`, `currency` and `renewal`. The distinct id is a `guest_` + SHA-256 prefix of the booking id. `$process_person_profile: false` is applied by `posthog.ts:215` for the `guest_` prefix. A test asserts that the email is absent.
- **Both callers.** The REST endpoint (`src/pages/api/v1/booking/admin.ts:47`) and the MCP tool `booking_update_status` (`src/lib/booking/mcp.ts:150`) both go through `adminUpdateBooking`.
- **Scope and code rules.** Scope is limited to #114. No `any` and no unchecked casts.

## Test gaps
- No test for a free booking (100% promo) being resolved.
- No test for a failing outbox or payment-events read during resolve (that is F1).

## Suggested PR comment
REQUEST_CHANGES.
- (Medium) `store.ts:971-973`: the `payment_events` SELECT in `queueResolvedPurchase` is unguarded. It runs after the confirm UPDATE and before fulfil, extras and commission, so a D1 error leaves a confirmed booking with no invite or commission, and retries get 409. Wrap it in try/catch and log, to match the "analytics never throws" contract.
- (Low) Re-resolving a booking that a webhook already counted, after the 30-day outbox purge, double counts. `docs/analytics-events.md:118` now overstates this. Either guard on `attention_reason` NULL or `'admin'` when events exist, or document the caveat.
- (Low) Revenue paid through a second provider is not summed. `booking:<id>` followed by a later recorded transfer and a re-resolve can double count.

Dedupe key parity, free bookings, PII and guest id, and both callers all check out. CI "Test & Build" on 662fcad is green. Local gates could not run in the review environment.
