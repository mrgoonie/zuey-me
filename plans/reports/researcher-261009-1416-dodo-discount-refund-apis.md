# Dodo discount / refund / dispute APIs (+ PayPal refund events)

Date: 2026-10-09 (Asia/Saigon). Docs version read: Dodo OpenAPI `1.118.3` (changelog v1.118.3, 2026-10-06). Sources fetched as raw `.md` from docs.dodopayments.com (official, Mintlify-rendered from OpenAPI), PayPal official spec repo.

Repo context: `src/lib/payments/dodo.ts` calls REST directly: `POST {base}/checkouts`, base `https://live.dodopayments.com` / `https://test.dodopayments.com`, Bearer key, Standard Webhooks. Currently sends `feature_flags.allow_discount_code: false`, `customer: {email, name}` (new-customer shape). Webhook parsing reads `total_amount` on `payment.succeeded|failed`.

## Verdict

**Yes.** Merchant can create a percentage discount limited to 1 billing cycle, single-use, restricted to product(s), and pre-apply it server-side to a checkout session. Recommended shape: one unique code per referred customer, `usage_limit: 1`, `subscription_cycles: 1`, `restricted_to: [productId]`, `expires_at` short. Customer-allowlist (`customer_eligibility: specific`) is optional hardening; it needs a Dodo `customer_id` which the current checkout flow does not have.

## 1. Create discount: `POST /discounts`

Doc: https://docs.dodopayments.com/api-reference/discounts/create-discount

| Field | Type | Notes |
|---|---|---|
| `type` (req) | `percentage` \| `flat` | `flat_per_unit` blocked |
| `amount` (req) | int32 | percentage = **basis points** (`1500` = 15%, `10000` = 100%), min 1. Flat = money, denominated via `currency_options` |
| `code` | string? | uppercased, min 3 chars; omitted => random 16-char code |
| `usage_limit` | int? | total redemptions, >=1 |
| `per_customer_usage_limit` | int? | must be <= `usage_limit` |
| `subscription_cycles` | int? | "Number of subscription billing cycles this discount is valid for." null = all recurring payments forever. **Use `1` for first cycle only.** |
| `restricted_to` | string[]? | product IDs |
| `starts_at` / `expires_at` | date-time? | starts_at < expires_at |
| `customer_eligibility` | `any`\|`first_time`\|`existing`\|`specific` | default `any`; `specific` fails closed until customers attached |
| `currency_options` | array? | per-currency `max_amount_possible` (cap for percentage), `minimum_subtotal`, `is_default`; required for `flat` |
| `preserve_on_plan_change` | bool | default false: discount dropped on plan change |
| `metadata` | object | tag with referral id / referrer |
| `name` | string? | |

Response `DiscountResponse`: `discount_id`, `code`, `amount`, `times_used`, `subscription_cycles`, `usage_limit`, etc.

Allowlist: `POST /discounts/{discount_id}/customers` body `{customer_ids: [...]}` (idempotent; customers must exist) — https://docs.dodopayments.com/api-reference/discounts/add-discount-customers. Also GET/PATCH/DELETE `/discounts/{id}`, `GET` by code (validate) — https://docs.dodopayments.com/api-reference/discounts/get-discount-by-code.

Feature guide confirms intent: "Use cycle limits for introductory pricing on subscriptions (e.g., '50% off for 3 months')" and basis-point API unit — https://docs.dodopayments.com/features/discount-codes

Trial gotcha: product-level `trial_apply_discounts` defaults `false` (discount does not reduce a paid trial charge) — https://docs.dodopayments.com/features/subscription. Zuey plans have no trial today (unverified in dashboard), so irrelevant unless one is added.

## 2. Apply to checkout session

Docs: https://docs.dodopayments.com/api-reference/checkout-sessions/create , https://docs.dodopayments.com/developer-resources/checkout-session

- Field: **`discount_codes: string[]`** (max 20, stacked in order). Singular `discount_code` is deprecated, still works, cannot be combined with `discount_codes`.
- `feature_flags.allow_discount_code` (default `true`) is described only as "Show discount code input field in the checkout interface" / "If the customer is allowed to apply discount code". Feature guide: "pass `discount_codes` to pre-apply... The discount input field is shown by default. Set `feature_flags.allow_discount_code` to `false` to hide it." => reads as UI-only; pre-applied server codes should still apply with flag `false`. **Not explicitly stated; verify in test mode** (create session with flag false + code, check `GET /checkouts/{id}` or `POST /checkouts/preview` `current_breakup.discount`).
- Pre-apply not allowed with `product_collection_id` flow (N/A here; repo uses `product_cart`).
- To use allowlist, pass existing customer: `customer: {customer_id}` (schema has `AttachExistingCustomer` variant). Current code passes `{email,name}`.
- Preview endpoint for pricing check: `POST /checkouts/preview` returns `current_breakup.discount`.

## 3. Refund / dispute webhooks

Event list: https://docs.dodopayments.com/developer-resources/webhooks/intents/webhook-events-guide

- Refund: `refund.succeeded`, `refund.failed`.
- Dispute: `dispute.opened`, `dispute.challenged`, `dispute.accepted`, `dispute.cancelled`, `dispute.expired`, `dispute.won`, `dispute.lost` (RDR auto-resolve arrives as `dispute.lost` + `is_resolved_by_rdr: true`; Ethoca alert => `refund.succeeded`, no dispute event) — https://docs.dodopayments.com/developer-resources/webhooks/intents/dispute
- Envelope (same as existing handler): `{business_id, type, timestamp, data: {payload_type, ...}}` — https://docs.dodopayments.com/developer-resources/webhooks

Payload linkage (from object schemas; webhook pages render same objects):
- Refund (`RefundResponse`, https://docs.dodopayments.com/api-reference/refunds/get-refunds-1): `refund_id`, **`payment_id`**, `amount`, `currency`, `is_partial`, `status`, `reason`, `customer`, `metadata`, `created_at`. **No `subscription_id`**.
- Dispute (https://docs.dodopayments.com/api-reference/disputes/get-disputes-1): `dispute_id`, **`payment_id`**, `amount`, `currency`, `dispute_status`, `dispute_stage`, `is_resolved_by_rdr`, `reason`, `customer`. **No `subscription_id`**.
- => To map to a subscription/referral, store `payment_id` -> commission row when handling `payment.succeeded` (payment carries `subscription_id`), or call `GET /payments/{payment_id}`.

## 4. Amount actually charged

Payment object (https://docs.dodopayments.com/api-reference/payments/get-payments-1), sent on `payment.succeeded`:
- `total_amount` — "Total amount charged to the customer including tax", minor units. This is post-discount.
- `tax` — tax in minor units (nullable). Net of tax = `total_amount - (tax ?? 0)`.
- `settlement_amount` / `settlement_currency` / `settlement_tax` — what lands in merchant balance after FX/processing (relevant if adaptive currency on).
- `discounts[]` (`DiscountDetailResponse`: `discount_id`, `code`, `amount` bps, `cycles_remaining`, position); `discount_id` deprecated.
- `subscription_id` (null for multi-subscription payments; then `subscription_ids`), `checkout_session_id`, `refunds[]`, `disputes[]`, `refund_status`, `metadata`.
- No explicit pre-discount subtotal field on payment. Use `total_amount` (or `total_amount - tax`) as commission base; recommended `total_amount - tax` in payment currency, since tax is not revenue.

## 5. PayPal (Orders v2 / Payments v2)

Event names (https://developer.paypal.com/api/rest/webhooks/event-names/): `PAYMENT.CAPTURE.COMPLETED`, `.DECLINED`, `.PENDING`, `.REFUNDED`, `.REVERSED`; `CUSTOMER.DISPUTE.CREATED`, `.UPDATED`, `.RESOLVED`.
- `PAYMENT.CAPTURE.REFUNDED` resource = refund object: `id`, `amount`, `invoice_id`, `custom_id`, `seller_payable_breakdown`, `links` (from official spec github.com/paypal/paypal-rest-api-specifications `payments_payment_v2.json`). Links include `rel: "up"` -> `/v2/payments/captures/{capture_id}`. `custom_id` propagates from purchase unit, so repo's `custom_id = bookingId` is usable for linkage.
- Note: repo `paypal.ts` extracts capture from any `PAYMENT.CAPTURE.*` event; a REFUNDED event's resource is a refund, not a capture — parser must branch.
- Dispute resource links via `disputed_transactions[].seller_transaction_id` (capture id) — from memory, not re-verified.

## Ranked recommendation

1. **Per-referral unique code** (`usage_limit:1`, `subscription_cycles:1`, `restricted_to`, `expires_at`, `metadata.referral_id`), pre-applied via `discount_codes`, `allow_discount_code:false`. Simplest, no customer pre-creation. Risk: code leakage before use (mitigated by single use + short expiry + server-only creation at checkout time).
2. Add `customer_eligibility: specific` + allowlist: stronger but needs `POST /customers` first and switching checkout to `customer_id`. Only worth it if leakage is a real concern.
3. Shared code with `per_customer_usage_limit:1`: weakest (anyone can use it); reject.

## Unverified / open questions

- Whether `allow_discount_code:false` still honours server-side `discount_codes` (strongly implied UI-only; test in test mode).
- Whether a pre-applied code can be removed by the buyer when input field is visible.
- Exact `subscription_cycles` counting: assume cycle 1 = initial checkout charge; confirm renewal `payment.succeeded` has full price and `discounts[].cycles_remaining` 0.
- Webhook payload pages for refund/payment rendered empty in md export; field list taken from REST object schemas (docs state webhooks carry same objects). Confirm with a test refund.
- Failed/abandoned checkout: does an unused single-use code stay redeemable (`times_used` increments on success only?). Not documented.
- PayPal dispute payload linkage field not re-verified.

Status: DONE_WITH_CONCERNS
Summary: Dodo supports first-cycle-only percentage discounts (`subscription_cycles:1`, bps `amount`, `usage_limit:1`, `restricted_to`) pre-applied via checkout `discount_codes`; refund/dispute webhooks link by `payment_id` only; `total_amount`/`tax` give collected amount. Concern: `allow_discount_code:false` + server code behaviour needs test-mode confirmation.
