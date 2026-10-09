# Referral payments: phases 3–4 (discounted checkout, commissions, fraud, refunds)

Status: DONE_WITH_CONCERNS. `bun test` 421/421 pass (24 new tests). `bun run build` passes: astro check reports 0 errors and 0 warnings, and none of the 37 hints come from touched files. Nothing was committed, the remote DB was not touched, and no real Dodo or PayPal API was called (fetch is mocked in tests). Plan and phase status are left for the orchestrator to set via `ak plan`.

## Files
New:
- `src/lib/referrals/checkout.ts`
- `src/lib/referrals/commissions.ts`
- `src/lib/referrals/fraud.ts` (pure)
- `src/lib/referrals/fraud-signals.ts` (the DB fact gathering, split out so `fraud.ts` stays pure)
- `src/lib/referrals/disposable-domains.ts`
- `src/lib/referrals/refunds.ts`
- `src/pages/api/v1/referrals/quote.ts`
- `tests/referrals-checkout.test.ts` (12 tests)
- `tests/referrals-commissions.test.ts` (12 tests)

Modified:
- `src/lib/members/billing.ts`
- `src/lib/payments/dodo.ts`
- `src/lib/payments/dodo-billing.ts`
- `src/lib/payments/paypal.ts`
- `src/lib/booking/store.ts`
- `src/lib/referrals/eligibility.ts`
- `src/pages/api/v1/booking/hold.ts`
- `src/pages/api/webhooks/{dodo,paypal,sepay}.ts`

The billing checkout route `src/pages/api/v1/billing/orders/index.ts` was not changed: it already forwards the body and the request, so `referral_code` and the `zr_ref` cookie reach `createMemberCheckout`.

## Exported API
```ts
// checkout.ts
BOOKING_PRICE_USD_CENTS = 199_900                      // booking store's CONSULTATION_PRICE_USD_CENTS now aliases this
sepayReferralAmounts(plan, months, usdVndRate, discountPercent): { beforeUsdCents, beforeVnd, usdCents, vnd }
cardFirstChargeCents(plan, discountPercent): number
parseReferralCodeField(body): string | null           // malformed → 400 invalid_field
resolveCheckoutReferral(d1, { userId?, email?, enteredCode, request?, product }): Promise<CheckoutReferral | null>
  // typed code that cannot apply → 400 referral_code_invalid; a typed code that applies binds an unbound account
referralQuote(d1, env, { userId?, enteredCode, request }): Promise<ReferralQuote>
// fraud.ts
assessReferral(snapshot): { verdict: 'block'|'review'|'ok', reasons[] }; payerTextMatches(); foldForMatch(); VELOCITY_MAX_SIGNUPS_24H = 5
// fraud-signals.ts
gatherFraudSnapshot(d1, { referrerUserId, refereeUserId, refereeEmail, sourceId, payerText? })
// commissions.ts
type CommissionSource = {kind:'billing_order', id, payerText?} | {kind:'card_subscription', id, paymentId, collectedCents} | {kind:'booking', id, payerText?}
recordReferralCommission(d1, env, source): Promise<{ created, commission | null }>   // idempotent per (source_kind, source_id)
captureReferralCommission(d1, env, source): Promise<void>                           // payment-path wrapper; never throws, audits 'commission.failed'
getCommission(d1, id); getCommissionBySource(d1, kind, sourceId); rowToCommission(row)
// refunds.ts (for the phase 6 admin route)
reverseCommission(d1, { commissionId } | { sourceKind, sourceId }, reason, actor = 'system')
  : Promise<{ outcome: 'reversed'|'already_reversed'|'not_reversible'|'not_found', commission, ledger_reversed }>
// dodo.ts
DODO_ALLOW_DISCOUNT_CODE_INPUT = false; dodoFeatureFlags(); dodoDiscountPayload(); createDodoDiscount(); parseDodoReversalEvent()
// dodo-billing.ts
startCardCheckout(d1, env, userId, plan, request?, referral?); applyDodoReversal(d1, event)
// paypal.ts
parsePaypalReversalEvent(); PaypalReversalEvent; parsePaypalCaptureEvent now returns null for REFUNDED and REVERSED
// booking/store.ts
bookingAmountDue(row, env); applyPaypalReversal(d1, event); createHold(d1, env, input, { request? })
// eligibility.ts
isEligibleReferee(d1, { userId?, email?, excludeSourceId? })   // new optional exclusion
```

## Behaviour
- **SePay membership order:** the prepay discount applies first, then the referral discount. The order snapshots `referrer_user_id`, `referral_rate`, `referral_discount_percent`, `referral_commission_percent` and `amount_before_referral` (VND). The order view gains `referral_discount_percent` and `amount_before_referral_vnd`. Example: Combo for 12 months is $155.04, or 4,089,000 VND at 26,350 VND per USD.
- **Dodo card subscription:**
  - Checkout sends `POST /discounts` first, with: `percentage`, `amount = d·100` basis points, `usage_limit 1`, `subscription_cycles 1`, `restricted_to [product]`, `expires_at` 24 hours later, and metadata `{referral_order, card_ref, referrer_user_id}`.
  - It then sends `discount_codes: [code]` on the checkout. `referral_ref` stores the discount id.
  - No discount is created when d = 0.
  - Checkout metadata is unchanged.
- **Attention fix:** `payment.succeeded` is now compared with the expected first charge (list price minus the snapshotted discount). For `subscription.active`, `recurring_pre_tax_amount` may equal either the list price or the discounted price on a referral card.
- **first_payment_id:** it is set with COALESCE on every `payment.succeeded`, before the attention check, so a later renewal never becomes the "first" payment.
- **Booking:**
  - The referral is resolved at hold time from the typed `referral_code` or the cookie, using the guest email. It is snapshotted, and `amount_before_referral` is stored in the rail's currency.
  - PayPal and SePay checkout, the guest view's VietQR, and the payment sufficiency check all use `bookingAmountDue`.
  - Example: $1,999 with d/R = 0.5 comes to $1,899.05.
- **Commission:**
  - Hooked into three places: after `fulfilOrder` in SePay `applyBillingPayment`; on a Dodo first `payment.succeeded` without attention; and on booking `confirmed` in `applyPayment`, which covers both rails and the PayPal capture-on-return path.
  - The base, in USD cents, is computed as follows:
    - SePay order: min(amount_paid, amount_vnd) ÷ the order's `usd_vnd_rate`.
    - Dodo: total_amount − tax.
    - PayPal: captured cents, capped at the amount owed.
    - SePay booking: VND ÷ today's `USD_VND_RATE`.
  - `commission_cents` = floor(base·pct/100).
  - `hold_until` = paid_at + hold_days, or slot_end + hold_days for bookings.
  - The fraud verdict maps to status: ok → `pending`, review → `review`, block → `blocked`. Each creation is audited as `commission.<status>`.
- **Fraud checks:**
  - Block: self-referral (by id, canonical email or identity email), the referee paid before (any other order, card or booking, excluding this source), or the referrer is locked.
  - Review: the referee's signup ip_hash equals the referrer's `login_tokens.ip_hash` from the last 90 days or the referrer's own signup hash; the SePay transfer content names the referrer's payout full name (diacritics folded, at least 2 words) or contains their bank account number (at least 6 digits); the email is on a disposable domain; or more than 5 accounts were bound to the referrer in 24 hours.
- **Reversal:**
  - pending, review or approved → `reversed`. If a `commission` ledger line exists, a negative `reversal` line is appended, which is unique per commission. Repeat calls are no-ops.
  - Blocked commissions are `not_reversible`.
  - Dodo `refund.succeeded`, `dispute.opened` and `dispute.lost` are matched through `first_payment_id`; refunds of other payments are ignored.
  - PayPal `PAYMENT.CAPTURE.REFUNDED` / `.REVERSED` are matched by `custom_id`, or by the `up` link capture id against `payment_ref`. `CUSTOMER.DISPUTE.CREATED` is matched by `disputed_transactions[].seller_transaction_id`.
- **Quote:** `GET /api/v1/referrals/quote?code=` is `private, no-store` and never sets a cookie.
  - A signed-in member gets the full checkout resolution.
  - An anonymous visitor gets the live code's public terms with `provisional: true`, because eligibility is re-checked at checkout.
  - It returns SePay prepay totals for every plan and term, the card first month and the booking price in USD and VND.

## Deviations
1. **Payer-match signal source:** `payment_events` stores no payload, and adding a migration is outside this phase's scope. The SePay webhook therefore passes the transfer `content` as `payerText` (VN banks put the payer's name there). There is no structured payer account field in SePay webhooks.
2. **SePay booking FX rate:** bookings have no stored `usd_vnd_rate`, so the commission converts at today's `USD_VND_RATE`. If that variable is missing, the booking still confirms, the commission is skipped and `commission.failed` is audited. This case is tested.
3. **Commission failure handling:** commission errors never fail the payment webhook. Releasing the idempotency record would make the retry hit the "already paid" branch and flag the order. Failures are logged and audited instead, and an admin can call `recordReferralCommission` later because it is idempotent.
4. **Partial refunds and won disputes:** any refund or dispute on the first payment fully reverses the commission. `dispute.won` does not reinstate it; that is an admin adjustment.
5. **Zero-cent commissions:** when d = R, the commission row is still recorded with 0 cents, because it counts as a successful referral for tiers and the leaderboard. Phase 5 approval must skip the ledger credit for 0 cents, since `appendLedger` rejects commission lines of 0 or less.
6. **Typed codes:** a typed code that cannot apply returns 400 `referral_code_invalid` rather than charging full price silently. A bound account ignores a typed code and keeps its own referrer. A cookie that cannot apply is silently ignored.
7. **Admin booking resolve:** `adminUpdateBooking('resolve')` does not record a commission, because there is no reliable collected amount. Only `applyPayment` confirmations do.
8. **Clock source:** commission timestamps use `membersRuntime.now`, including for bookings. Both clocks are `Date.now` in production.

## Unverified items
- **Dodo `allow_discount_code: false` with server `discount_codes`:** not verified in test mode (no credentials or network calls in this phase). It is isolated behind `DODO_ALLOW_DISCOUNT_CODE_INPUT` in `dodo.ts`, with a comment. Verify with `POST /checkouts/preview` → `current_breakup.discount` before launch, and flip the flag for referral checkouts if needed.
- **Dodo `recurring_pre_tax_amount`** on a discounted first cycle: either value is accepted.
- **Renewal price after the discount:** a cycle-2 renewal should charge full price with `cycles_remaining` 0.
- **Unused discount codes:** whether an abandoned checkout's code stays usable. It expires after 24 hours either way.
- **Payload field names:** the PayPal dispute field `seller_transaction_id` and refund `custom_id` propagation, and the Dodo refund/dispute field names (`payment_id`, `is_partial`), are taken from the research report and not seen live.

## Unresolved questions
- Should a won dispute (`dispute.won`) or an admin action reinstate a reversed commission? It currently stays reversed.
- Should a refunded or charged-back booking also be flagged `needs_attention`? Its status is currently left unchanged.

Status: DONE_WITH_CONCERNS
Summary: Referral discounts are applied server-side on SePay, Dodo and booking checkouts, with snapshots on the order rows. Commissions are captured idempotently with fraud verdicts and reversed on refunds and disputes, and the full test suite and build are green. The concern is that the Dodo pre-applied code with `allow_discount_code:false` still needs test-mode verification.
