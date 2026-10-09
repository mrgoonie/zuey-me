---
phase: 3
title: "Discounted checkout: SePay, Dodo, booking"
status: pending
priority: P1
effort: 6h
dependsOn: [2]
---

# Phase 3 — Discounted checkout

## Objective
Referee pays the discounted amount on every rail; each order snapshots the referral terms so later rate changes never alter it.

## Steps
1. `src/lib/referrals/checkout.ts`: `referralQuote(...)` returns per-plan/per-term discounted prices (reuse `prepayUsdCents` / `prepayVnd` from `plans.ts`, then apply discount; VND rounded up to 1,000 like existing helpers). Endpoint `GET /api/v1/referrals/quote?code=` (public, no cache, reads session + cookie) used by `/pricing` client and booking widget.
2. **SePay** (`src/lib/members/billing.ts:150` order creation): resolve referral; compute `amount_before_referral` (current amounts) and discounted `amount_vnd` / `amount_usd_cents`; write snapshot columns. Webhook amount check (`billing.ts:307`) already compares with stored `amount_vnd` — keep.
3. **Dodo** (`src/lib/payments/dodo.ts:110`, `createMemberCheckout` `billing.ts:214`): when a referral applies, `POST /discounts` with `type: percentage`, `amount: discount*100` bp, `usage_limit: 1`, `subscription_cycles: 1`, `restricted_to: [productId]`, `expires_at: now+24h`, `metadata: {referral_order}`; pass `discount_codes: [code]` on the checkout. Store snapshot on the pending `card_subscriptions` row (`referral_ref` = discount id). **Verify in test mode** with `POST /checkouts/preview` that the code applies with `allow_discount_code: false`; if not, set it true for referral checkouts only. If Dodo cannot apply a first-cycle-only discount at all → STOP and ask.
4. Fix `dodo-billing.ts:366`: compare `payment.succeeded` total against the snapshotted expected amount (list − discount) instead of list price; store `first_payment_id` from the first `payment.succeeded`.
5. **Booking** (`src/lib/booking/store.ts:346` create, price at :31, PayPal amount at :472/:512): resolve referral by cookie/entered code + guest email; discount `bookingSplit`; snapshot on `bookings`; both SePay and PayPal amounts use the discounted price.
6. Checkout UIs accept an optional `referral_code` field (validated server-side; never trust client amounts).

## Tests
`tests/referrals-checkout.test.ts`: SePay order amount with 12-month + 15 % stacking (Combo: 228 → 182.40 → 155.04 USD equivalent; VND rounding), no referral → unchanged amounts, Dodo payload contains `discount_codes` and discount request (fetch mocked), Dodo attention check uses expected amount, booking $1,999 with d/R=0.5 → 1,899.05.

## Validation
New + existing `billing`, `dodo`, `booking` tests pass.
