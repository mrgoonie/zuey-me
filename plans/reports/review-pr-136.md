# Review: PR #136, early Dodo first-payment reversal matched by card reference (closes #132)

Head `76d122ed`. Reviewed with the latest `origin/main` (`13ebe5d`) merged in locally (clean merge). Isolated reviewer. No Dodo API calls were made.

**Verdict: APPROVE.** The fallback mirrors `locateCard`, excludes a card bound to another subscription, writes nothing before the 409, and is tested end to end through the signed webhook. One non-blocking Low (identity check parity) and one nit. It conflicts with #133, which merges first; the rebase checklist is below.

## Gates (merged tree, Windows)

- `bun install --frozen-lockfile`: OK
- `bun test`: **962 pass, 0 fail** (52 files)
- `bun run build`: astro check **0 errors, 0 warnings** (65 hints, pre-existing); build complete
- New test fails against main: with main's `dodo.ts`, `dodo-billing.ts` and `webhooks/dodo.ts` swapped in, `tests/referrals-commissions.test.ts` gives 22 pass / **1 fail** (the new test). On the PR head: 23 pass / 0 fail. Files restored afterwards.
- No `any`, no new casts. `lookupDodoPayment` reuses the existing `parseMetadata` (`isRecord` + `strOrNull`).

## What was checked

- **Nothing written before the 409.** `cardFromDodoLookup` (`src/lib/payments/dodo-billing.ts:613-635`) only reads; the 409 at `:632` is thrown before `recordEvent`, `reverseCommission`, `queueRefund` or `insertActivity`. Redeliveries are bounded by Dodo's 8 attempts (about 28 hours), as for the subscription-id path.
- **Bound cards are not matched.** The fallback query (`:627`) accepts the referenced card only when `provider_subscription_id IS NULL` or equals the payment's own subscription id. With a null subscription id the second branch is `= NULL`, never true. The test's `pay_other` case (card already bound to `sub_1`, payment on `sub_other`) returns `ignored`.
- **Metadata trust / spoofing.** The metadata is not taken from the webhook body; it comes from `GET /payments/{id}` with our API key, and our checkout sets it server-side (`card_ref: id`, `dodo-billing.ts:261`); no member input reaches it. Even if a customer could set payment metadata through some Dodo-side path, the worst case is bounded: a forged `card_ref` can only hit a card that is still unbound, and on such a card `first_payment_id` is null, so the result is a 409, never a write. Once the real owner's first payment binds the card (`:495` sets `provider_subscription_id` and `first_payment_id` together), the forged payment's different (or null) subscription id no longer matches, and the reversal is `ignored`. A reversal therefore cannot be bound to another member's card.
- **Commission reversal path.** After `payment.succeeded` records the first payment, the redelivered refund is caught by `cardForPayment` (`first_payment_id = pay_first`), so the outcome is `reversed` and the commission goes `pending` to `reversed`. The test asserts all of it through `signedDodo`, so the route's 409/200 mapping is covered.
- **Docs.** `docs/analytics-events.md` and the route comment match the code.

## Findings

**[Low] The metadata fallback skips the identity check that `locateCard`'s callers apply** (`src/lib/payments/dodo-billing.ts:626-628`). When `applyPaymentEvent` matches a card `via: 'metadata'`, it also requires `metadataMatches` (`user_id` and `plan`, `:586`). The reversal fallback matches on `card_ref` alone. Writes are not at risk (see the trust analysis), but if a payment's metadata disagrees with the card, `applyPaymentEvent` flags it and never sets `first_payment_id`, so this reversal answers 409 eight times and is then dropped, where `ignored` at once would be correct. Suggestion: also require `metadata.userId === row.user_id && metadata.plan === row.plan` for the fallback match, as the payment path does.

**[Nit] One query, two shapes.** The two `SELECT`s could be one `locateCard`-style helper shared by both paths (it already exists, returning a full `CardSubscription`). Optional.

## Rebase checklist for #136 onto #133

#133 changes the same function (`cardFromDodoLookup`), `dodo.ts`, the route comment and the same docs paragraph. The combined result must keep all of the following:

1. **`DODO_API_KEY` precheck** at the top of `cardFromDodoLookup` (returns `null` with the "skipped" warning) from #133.
2. **Error classification from #133** around the new call: `lookupDodoPayment` must go through `dodoRequest` (it does) so it throws `DodoApiError`; the catch rethrows non-`DodoApiError`, `upstreamStatus === null` and 5xx, and returns `null` only for 4xx. Do not keep #136's catch-all "payment lookup failed; ignored" branch.
3. **Imports** in `dodo-billing.ts`: `DodoApiError` and `lookupDodoPayment` (value), `DodoPaymentLookup` (type). `getDodoPaymentSubscriptionId` is removed; nothing else imports it.
4. **`dodo.ts`**: keep `DODO_REQUEST_TIMEOUT_MS`, `DodoApiError` and the `signal: AbortSignal.timeout(...)` in `dodoRequest`; replace `getDodoPaymentSubscriptionId` with `lookupDodoPayment` and state in its comment that it throws `DodoApiError`.
5. **Do not reintroduce `if (!subscriptionId) return null;`**: the card-reference fallback must still run when the subscription id matches no card.
6. **Card-reference query** keeps `AND (provider_subscription_id IS NULL OR provider_subscription_id = ?)`, and the 409 stays after both lookups and before any write.
7. **Docs paragraph** (`docs/analytics-events.md`, "Dodo refunds of renewals"): keep #136's `card_ref` clause and #133's sentences on 4xx/no key as `ignored` and network error/5xx/10 s timeout as `502 payment_provider_error`. Drop the old "A failed lookup ... is acknowledged as `ignored`" sentence.
8. **Function JSDoc of `applyDodoReversal` and the route comment**: merge both the card-reference wording and "a lookup that hits a Dodo outage answers 502".
9. **Tests**: both new tests must pass together: #133's outage test in `tests/analytics-outbox.test.ts` (its `dodoPayments.pay_9` stub has no metadata; `parseMetadata(undefined)` handles it) and #136's test in `tests/referrals-commissions.test.ts`. Re-run `bun test` and `bun run build` after the rebase, then re-check that the 502 path still writes nothing.
