# Review: PR #125 — count Dodo charges by payment id, retry early renewal refunds (closes #121)

Head `734c986`, reviewed with `origin/main` (`850c4d8`) merged in locally. Isolated reviewer.

**Verdict: REQUEST_CHANGES.** One medium-severity issue: the dispute half of the 409 path never runs. The charge-count heuristic and the reordered refund writes are correct.

## Gates (merged tree, Windows)

- `bun install --frozen-lockfile`: OK
- `bun test`: **915 pass, 0 fail** (50 files)
- `bun run build`: astro check **0 errors, 0 warnings** (64 hints); build complete
- The new tests fail on main. I ran the two test files with main's `dodo-billing.ts` and `dodo.ts`, and 3 new tests fail: the redelivery count, the early-refund 409, and the signed-route 409. The reordered writes (item 3) have no test that fails on main.
- No `any` in the touched files. The signature check is unchanged at `src/pages/api/webhooks/dodo.ts:24`, and the forged-signature test returns 401.

## 1. Charge count (60 s legacy gap): sound

`payment_events` has columns (id, provider, event_id, booking_id, amount, currency, raw_type, received_at, card_subscription_id, …) and no payload (`migrations/0005:59`, `0011:89`). Webhook rows store the webhook id, not the payment id. So the suggested simpler rule (count a legacy row only when no `charge:` row has the same payment id) cannot be built: the payment id of a legacy row cannot be recovered. The only alternative with the same power is a hard-coded #119 deploy timestamp. It would behave the same and be more brittle (a deploy-specific constant in code). The per-card gap is acceptable.

How the rows are ordered: `applyDodoEvent` writes the webhook row (`dodo-billing.ts:576`), then `applyPaymentEvent` writes the charge row first (`:490`), with no awaited write that can fail in between. Both rows are written in one request with `iso(now())` (same format), so the same delivery's webhook row is always within milliseconds of its charge row and never counted. Clock skew does not matter: legacy-vs-first-charge comparisons are between rows days apart. On a failure, the webhook row is deleted and the charge row stays. A retry rewrites the webhook row after the charge row, so it is not counted.

Scenarios (promo 50% × 2 cycles; `minimumChargeCents` uses this count):

| Case | Before (main) | This PR |
|---|---|---|
| Post-#119 card: P1, P1 redelivered under a new webhook id, P2 discounted | P2 = cycle 3 → `amount_mismatch` (false flag) | P2 = cycle 2 → OK (tested) |
| Legacy card: W(P1) pre-#119, P2 post | 2 | 1 charge + 1 legacy = 2 ✓ (tested) |
| Legacy card, P1 redelivered under a new webhook id **before** #119 | +1 | +1 (unfixable, no payment id stored) |
| P1 delivered by old code, redelivered under a new webhook id **after** deploy | — | charge row + legacy row = +1 over. Deploy-boundary only; same for any rule |
| Two distinct legacy/new charges within 60 s on one card | — | under-counts by 1. Not realistic for monthly cycles |

No action needed. A nit: the "about a day" in the comments and docs is about 27.6 h by Dodo's published schedule (0, 5 s, 5 m, 30 m, 2 h, 5 h, 10 h, 10 h).

## 2. Early refund/dispute → 409: refunds OK, disputes never match

What the docs say:
- **Refund.** `refund.succeeded` carries `data: Refund`. In the Dodo Node SDK (`src/resources/refunds.ts`, `interface Refund`), `customer: CustomerLimitedDetails` is **required** and includes `customer_id`. The API reference RefundResponse agrees (`customer` in `required`). The refund path works.
- **Dispute.** `dispute.opened` / `dispute.lost` carry `data: DisputesAPI.Dispute` (SDK `src/resources/webhooks/webhooks.ts`). In `src/resources/disputes.ts`, `interface Dispute` has `amount: string, business_id, created_at, currency, dispute_id, dispute_stage, dispute_status, payment_id, is_resolved_by_rdr?, remarks?` and **no `customer`**. Only `GetDispute` (the GET response) has `customer`. The docs' dispute webhook page shows no customer field either.
- **Retries.** "up to 8 attempts total", and any non-2xx counts as a failure (docs.dodopayments.com/developer-resources/webhooks). The docs say nothing about disabling an endpoint.

### Findings

**[Medium] An early dispute of a renewal still returns `200 ignored`.** `parseDodoReversalEvent` (`src/lib/payments/dodo.ts:390`) reads `customer.customer_id`, which a dispute webhook does not carry. So for `dispute.opened` / `dispute.lost`, `customerId` is null and `applyDodoReversal` (`src/lib/payments/dodo-billing.ts:623`) returns `ignored`. The PR body, the docs (`docs/analytics-events.md`) and the route comment all say "refund or dispute". The lost chargeback stays lost, and the docs overstate the coverage. The tests only use refunds, and the fixture's dispute shape is not Dodo's.
Fix (pick one):
- (a) Small: for an unknown payment with no customer id, look up the payment through Dodo's `GET /payments/{payment_id}`, which returns `subscription_id` (nullable) and a required `customer.customer_id`. Answer 409 when `subscription_id` matches a `card_subscriptions.provider_subscription_id`. This also lets you write the missing `charge:` row from the API response and process the reversal right away. That would also cover pre-#119 renewals (see the next finding).
- (b) Minimum: limit the docs, comment and PR claim to refunds, and file a follow-up issue for disputes.

**[Low] Refunds of pre-#119 renewals now fail 8 times (~27.6 h) instead of returning `ignored` once.** A renewal charged before #119 has no `charge:` row. Its customer is known, so every refund of it now gets 409 until Dodo gives up. The end state matches main (unlogged), but it creates repeated failed deliveries and alerts in the Dodo dashboard. The same happens for a payment of a card flagged by `flagUnmatched` (customer id set, no charge row written). Fix (a) above resolves this. Otherwise, document it as an expected one-time cost of the transition.

**[Low] `data.amount` is a string in Dodo's `Dispute`.** `intOrNull(d.amount)` (`dodo.ts:391`, unchanged here) therefore gives `null` for disputes, so `billing.card_reversal` and the `refund` event for a lost dispute have no amount. This predates the PR. File a separate issue; do not widen this PR.

## 3. Refund queued before the reversal log: correct

`queueRefund` → `enqueueServerEvent` uses `ON CONFLICT (dedupe_key) DO NOTHING` (`src/lib/analytics/outbox.ts:107`). The log is the last write, and the `catch` deletes the reversal gate. A retry re-queues (a no-op) and logs once. `reverseCommission` runs before the gate and is idempotent. The 409 throw happens before any write, so it has no side effects.
Nit: there is no test that injects a `logActivity` failure and asserts one log and one event after the retry, so this ordering is not regression-protected.

## Summary of requested changes

1. Make the dispute path work (Dodo payment lookup) or narrow the claims to refunds and file a follow-up issue. Add a test that uses Dodo's real `Dispute` shape (no `customer`).
2. Optionally, through the same lookup, stop the 409 retries for refunds of pre-#119 renewals.
3. Nits: "about a day" → "about 28 hours"; a failure-injection test for the reordered writes.

Sources: Dodo webhooks guide (retry schedule), API reference `get-refunds-1` / `get-disputes-1` / `get-payments-1`, `dodopayments/dodopayments-node` `src/resources/{refunds,disputes,webhooks/webhooks}.ts` (main, last commit 2026-10-09).
