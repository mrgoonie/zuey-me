# Re-review (round 2): PR #125, Dodo charge counting and early refund/dispute handling (closes #121)

Delta `734c986..8419ead`. The PR's own change is commit `3ec20a8`; the rest is merges of main. Reviewed with the latest `origin/main` merged in locally. Isolated reviewer.

**Verdict: APPROVE.** The round-1 Medium is fixed: a dispute of an unrecorded renewal is now matched through `GET /payments/{id}`. Both round-1 Lows and the nits are resolved too. What remains is two non-blocking Lows that can go to follow-up issues.

## Gates (merged tree, Windows)

- `bun install --frozen-lockfile`: OK
- `bun test`: **945 pass, 0 fail** (52 files)
- `bun run build`: astro check **0 errors, 0 warnings**; build complete
- New tests fail against main. With main's `dodo-billing.ts`, `dodo.ts`, `users.ts` and `webhooks/dodo.ts` swapped in, 6 tests fail (redelivery count, dispute via lookup, 409 before first charge, pre-#119 renewal and ignored payments, failed-log retry, signed dispute + 409 route). All 6 pass on the PR head. Files were restored afterwards.
- No `any` and no unchecked casts. The lookup reads `subscription_id` with `strOrNull` on an `isRecord`-validated body.
- The signature check is unchanged (`src/pages/api/webhooks/dodo.ts:24`), and the forged-signature test still returns 401.

## What was checked

- **Payment lookup.** `getDodoPaymentSubscriptionId` (`src/lib/payments/dodo.ts:235`) reuses `dodoRequest`, so it gets the same base URL resolution (`dodoBase(env)`, test vs live), the same `Bearer` header from `env.DODO_API_KEY`, and the same 502 `AppError` on network failure, non-2xx or a non-object body. The key is never logged. The warning at `dodo-billing.ts:614` prints only the `AppError` message: either "HTTP <status>" or "missing DODO_API_KEY". The payment id is `encodeURIComponent`-encoded and comes from a signature-verified payload, so the path is not attacker-controlled. There is no fetch timeout, which matches every other Dodo call (see nit).
- **First payment vs renewal.** `first_payment_id` is set only by the first processed `payment.succeeded` of the card (`COALESCE`, `dodo-billing.ts:496-500`). If the card has a `first_payment_id` and the payment has no `charge:` row, the payment cannot be the first payment, because the first payment would have matched `cardForPayment` (`:599`). It is therefore a renewal (or another subscription charge such as a plan-change charge). Neither carries a commission, so treating it as a renewal is correct. One-time payments (`subscription_id: null`) and course payments (handled earlier by `applyDodoCourseWebhook`) are not mis-attributed.
- **409 path.** A card that is found but has no first payment yet throws 409 before any write (`:620`). The reversal of a first payment that beats its `payment.succeeded` is redelivered, and its commission is then reversed. The retries are bounded by Dodo's 8 attempts. The docs now state about 28 hours and the schedule.
- **Idempotency.** The lookup runs before the `${type}:${objectId}` gate, so a redelivery repeats the GET but not the writes. The tests cover a dispute applied early and then redelivered after the charge is recorded: one log and one `refund` event. They also cover a pre-#119 renewal refunded twice: one log.
- **`insertActivity`.** It is extracted from `logActivity`, which now delegates to it inside its unchanged `try/catch`, so other callers behave the same. Only the reversal log uses the throwing variant, and the new trigger-based failure-injection test proves the gate is released and the retry logs once.
- **Docs.** `docs/analytics-events.md` and the route comment match the code. The webhook is not in OpenAPI on main either, so nothing needs updating there.

## Findings

**[Low] A transient lookup failure drops the reversal permanently** (`src/lib/payments/dodo-billing.ts:611-616`). Every lookup error becomes `ignored` with a 200: no API key, 404, and also network errors and Dodo 5xx. If Dodo's API has a short outage while a dispute of an unrecorded renewal arrives, the reversal is never logged, although Dodo would have retried it. Suggestion: return `ignored` only for a missing key and for 4xx. Let a network error or 5xx propagate (502, so Dodo redelivers). This works because nothing has been written yet at that point. Non-blocking. The docs currently describe the behaviour accurately.

**[Low] A reversal of the first payment that arrives before any card webhook is still ignored** (`dodo-billing.ts:618`). Cards are created at checkout with `provider_subscription_id = NULL`. It is filled only by the first subscription or payment webhook. If a refund or dispute of the first payment beats both, the lookup by `subscription_id` finds no card and returns `ignored`. The commission captured later is then never reversed. This is not a regression: main and the previous head behave the same. It is also unlikely, because Dodo sends `subscription.active` and `payment.succeeded` together. A cheap fix is to also match the lookup response's `metadata` card reference, as `locateCard` does (`:344`). Dodo's payment object returns the checkout metadata. File it as a follow-up issue if wanted.

**[Nit] No timeout on Dodo API calls** (`dodo.ts:87`). This is pre-existing and consistent across the client. A slow lookup only delays the webhook response, and the webhook is idempotent on retry. An `AbortSignal.timeout(...)` in `dodoRequest` would bound it for all callers. Separate issue.

## Round-1 items

| Round-1 finding | Status |
|---|---|
| [Medium] Dispute webhooks carry no customer, so early disputes returned `ignored` | Fixed via payment lookup; test uses Dodo's real `Dispute` shape (no customer, string amount) |
| [Low] Refunds of pre-#119 renewals retried 8 times | Fixed: matched at once as renewal |
| [Low] Dispute `amount` is a string | Out of scope (pre-existing); still worth its own issue |
| Nit: "about a day" | Fixed: "about 28 hours" with schedule |
| Nit: failure-injection test for reordered writes | Added (trigger-based, uses `insertActivity`) |
