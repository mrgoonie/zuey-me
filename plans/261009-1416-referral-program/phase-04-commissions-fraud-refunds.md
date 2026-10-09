---
phase: 4
title: "Commission capture, fraud checks, refunds and reversals"
status: pending
priority: P1
effort: 6h
dependsOn: [3]
---

# Phase 4 — Commission capture, fraud, refunds

## Objective
Every paid referred first order creates exactly one commission; fraud signals block or queue it; refunds and disputes reverse it.

## Steps
1. `src/lib/referrals/fraud.ts` (pure): `assessReferral(snapshot) → {verdict: 'block'|'review'|'ok', reasons[]}`.
   - Block: self (ids/normalized email/OAuth subject), referee previously paid, referrer locked.
   - Review: referee signup ip_hash equals referrer's recent ip_hash (from `login_tokens`/sessions), SePay payer name/account (from `payment_events` payload) matches referrer payout profile name/account, disposable email domain (small static list in `src/lib/referrals/disposable-domains.ts`), velocity (> 5 bound signups for one code in 24 h).
2. `src/lib/referrals/commissions.ts`: `recordReferralCommission(d1, env, source)` — reads snapshot columns, converts collected amount to USD cents (SePay: `amount_paid / usd_vnd_rate`; Dodo: `total_amount − tax`; PayPal: captured USD), `INSERT … ON CONFLICT DO NOTHING` on (source_kind, source_id), status from fraud verdict (`pending`/`review`/`blocked`), `hold_until` = paid_at + hold_days (booking: `slot_end` + hold_days). Ledger line only on approval (phase 5) — pending is not balance.
3. Call sites (after the existing success path, inside the same idempotent branch):
   - SePay: after `fulfilOrder` in `applyBillingPayment` (`billing.ts` ~:318).
   - Dodo: first `payment.succeeded` for a card row with referral snapshot (`dodo-billing.ts`).
   - Booking: on `status='confirmed'` (`booking/store.ts:569`) for both rails.
4. `src/lib/referrals/refunds.ts`: `reverseCommission(d1, source, reason)` — pending/review/approved → `reversed`; if already in ledger (approved), append `reversal` line (negative). Unique (kind, commission_id) keeps it idempotent.
   - Dodo: handle `refund.succeeded`, `dispute.opened`/`dispute.lost` by `payment_id` → card row via `first_payment_id` (webhook `src/pages/api/webhooks/dodo.ts`).
   - PayPal: split `PAYMENT.CAPTURE.REFUNDED` / `.REVERSED` / `CUSTOMER.DISPUTE.CREATED` from captures in `src/lib/payments/paypal.ts` + webhook route; match booking by capture id via the `up` link / `custom_id`.
   - SePay & any rail: admin action "refund" (`POST /api/v1/admin/referrals/commissions/{id}/reverse`, phase 6) — SePay refunds are manual.
5. Audit each state change in `referral_events`.

## Tests (`tests/referrals-commissions.test.ts`)
Paid SePay order → one pending commission; replayed webhook → still one; self-referral → none/blocked; soft signal → review; Dodo refund → reversed; reversal after approval appends negative line; PayPal REFUNDED not treated as capture.

## Validation
All payment and booking tests pass.
