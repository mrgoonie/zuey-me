---
phase: 5
title: "Cron: maturity, tiers, monthly close; payout profiles and R2"
status: pending
priority: P1
effort: 6h
dependsOn: [4]
---

# Phase 5 — Jobs, payouts, payout profiles

## Steps
1. `src/lib/referrals/jobs.ts`:
   - `matureCommissions(d1, now)`: `pending` with `hold_until <= now` and referrer not locked → `approved` + ledger `commission` line. `review` never auto-approves.
   - `recomputeTiers(d1, now)`: count approved + pending-past-hold commissions with `paid_at` in last 90 days per referrer (excluding reversed/blocked) → `tier_count_90d`, `tier_rate`.
   - `closePayoutPeriod(d1, env, now)`: runs only when local date (Asia/Saigon) is day 1 and period not yet closed (unique per referrer+period makes it idempotent). For each referrer with `balanceCents ≥ threshold` and a `verified` payout profile: create `referral_payouts` row (gross = balance, deduction by method from settings, net; VN converts with `USD_VND_RATE`) and ledger `payout` line (−gross). Negative balances carry over automatically.
2. Endpoint `POST /api/v1/referrals/jobs/run` (CRON_SECRET via existing `isCronCaller`, `src/pages/api/v1/articles/notifications/dispatch.ts:9`) runs all three; add path to `JOBS` in `workers/scheduler/src/index.ts:23` (jobs are cheap and idempotent at 5-min cadence; each job no-ops when nothing changed).
3. Admin payout actions (`src/lib/referrals/payouts.ts`): list period, `markPaid(id, transaction_ref, adminEmail)` → `paid` + email via `sendLoggedEmail` (`src/lib/members/email.ts:28`), `cancelPayout` → ledger `adjustment` +gross. CSV export of a period.
4. Payout profiles (`src/lib/referrals/payout-profiles.ts`):
   - Add R2 binding `REFERRAL_KYC` in `wrangler.toml` and `src/env.d.ts`; bucket `zuey-referral-kyc` (private, no public domain).
   - Member: save VN (full_name, bank_name, bank_account, national_id, address) or PayPal email; upload front/back images (≤ 5 MB, jpeg/png/webp) via server-side `PUT` into R2 with random keys; status `submitted`.
   - Admin: view images through a short-lived proxy endpoint (admin-only, `Cache-Control: no-store`, logs `referral_events`), `approve` → delete both R2 objects in the same request then set keys NULL + `verified`; `reject(reason)` → delete objects too.
   - Missing binding → explicit 503 naming `REFERRAL_KYC`.

## Tests (`tests/referrals-jobs.test.ts`)
Maturity after 30 days; review stays; 3 successes in 90 days → 25 %; day-1 close VN 10 % / PayPal 18 %; $49.99 carries over; unverified profile skipped; second run idempotent; post-payout reversal deducted next close; approve deletes R2 objects (fake R2 map asserts empty).
