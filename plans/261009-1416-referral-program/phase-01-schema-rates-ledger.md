---
phase: 1
title: "Schema, config, rates and ledger core"
status: pending
priority: P1
effort: 6h
dependsOn: []
---

# Phase 1 — Schema, config, rates and ledger core

## Objective
Add `migrations/0014_referrals.sql` (tables and columns only, no data rewrite) and pure core logic for rates, codes and the append-only ledger.

## Schema (`migrations/0014_referrals.sql`)
- `referral_settings` (single row `id = 'default'`): `tiers_json` (`[{min:0,rate:20},{min:3,rate:25},{min:10,rate:30},{min:25,rate:40},{min:50,rate:50}]`), `hold_days` 30, `booking_rate` 10, `payout_threshold_cents` 5000, `vn_deduction_bp` 1000, `paypal_deduction_bp` 1800, `cookie_days` 30, `updated_at`. Seed default row with `INSERT OR IGNORE`.
- `referral_profiles`: `user_id` PK → users, `code` UNIQUE (lowercase `[a-z0-9]{6,16}`), `discount_percent` INT default 0, `admin_rate_override` INT NULL (0–50), `admin_enabled` INT 0/1, `locked_at`, `lock_reason`, `leaderboard_opt_out` INT 0, `tier_rate` INT default 20, `tier_count_90d` INT default 0, `tier_updated_at`, `created_at`, `updated_at`.
- `users` add: `referred_by_user_id TEXT`, `referred_at TEXT`, `referral_signup_ip_hash TEXT`.
- `billing_orders`, `card_subscriptions`, `bookings` add: `referrer_user_id`, `referral_rate`, `referral_discount_percent`, `referral_commission_percent`, `amount_before_referral` (minor units of that row's currency), `referral_ref` (Dodo discount id / code where relevant). `card_subscriptions` also `first_payment_id`.
- `referral_commissions`: `id`, `source_kind` (`billing_order|card_subscription|booking`), `source_id`, UNIQUE(`source_kind`,`source_id`), `referrer_user_id`, `referee_user_id` NULL (booking guests), `referee_email`, `base_amount_cents` (USD, collected), `commission_percent`, `commission_cents`, `status` (`pending|review|approved|reversed|blocked`), `review_reasons` (JSON), `hold_until`, `provider_payment_id`, `paid_at`, `approved_at`, `reversed_at`, `created_at`, `updated_at`. Indexes on (`referrer_user_id`,`status`), (`status`,`hold_until`), (`paid_at`).
- `referral_ledger` (append-only): `id` AUTOINCREMENT, `referrer_user_id`, `kind` (`commission|reversal|payout|adjustment`), `amount_cents` (signed), `commission_id` NULL, `payout_id` NULL, `note`, `created_at`. UNIQUE(`kind`,`commission_id`) WHERE commission_id NOT NULL — guards double credit/reversal.
- `referral_payout_profiles`: `user_id` PK, `method` (`vn_bank|paypal`), `full_name`, `bank_name`, `bank_account`, `national_id`, `address`, `paypal_email`, `status` (`draft|submitted|verified|rejected`), `id_front_key`, `id_back_key`, `verified_at`, `verified_by`, `reject_reason`, `created_at`, `updated_at`.
- `referral_payouts`: `id`, `period` (`YYYY-MM`), UNIQUE(`referrer_user_id`,`period`), `method`, `gross_cents`, `deduction_bp`, `deduction_cents`, `net_cents`, `usd_vnd_rate` NULL, `net_vnd` NULL, `status` (`pending|paid|cancelled`), `transaction_ref`, `paid_at`, `paid_by`, `created_at`, `updated_at`.
- `referral_events` (audit): `id`, `actor`, `action`, `subject_user_id`, `detail` JSON, `created_at`.

Remote-safety: only CREATE TABLE / ALTER TABLE ADD COLUMN / CREATE INDEX / INSERT OR IGNORE of the settings row.

## Code
- `src/lib/referrals/config.ts`: `getReferralSettings(d1)`, `updateReferralSettings(d1, patch)` with validation (tiers ascending `min`, rates 0–50, first `min` = 0).
- `src/lib/referrals/rates.ts` (pure): `tierRateFor(count, tiers)`, `effectiveRate(profile, settings)` = max(override ?? 0, tier_rate), `clampDiscount(d, R)`, `bookingSplit(d, R, bookingRate)`, `applyPercent(amount, pct)` (integer rounding: discount rounded down for VND to 1,000 via existing helpers; USD to cents).
- `src/lib/referrals/codes.ts`: `generateReferralCode()`, `ensureReferralProfile(d1, userId)` (unique-retry), `normalizeEmailForSelfCheck(email)` (gmail dots/plus).
- `src/lib/referrals/ledger.ts`: `appendLedger`, `balanceCents(d1, userId)` (sum), `approvedUnpaidCents` helpers.
- Referrer eligibility `isActiveReferrer(d1, userId)`: not locked AND (admin_enabled OR has active subscription via existing subscriptions/card rows).

## Tests (`tests/referrals-core.test.ts`)
Tier boundaries (0,2,3,9,10,25,50,99), override vs tier max, discount clamp when R drops, booking split (d=15,R=30 → 5/5; d=0; d=R), ledger balance with reversal, migration applies on `createTestD1()`.

## Validation
`bun test tests/referrals-core.test.ts` passes; full `bun test` still green.
