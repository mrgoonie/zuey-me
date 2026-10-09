---
phase: 6
title: "REST, OpenAPI and MCP surfaces"
status: pending
priority: P2
effort: 4h
dependsOn: [5]
---

# Phase 6 — REST, OpenAPI, MCP

Follow `src/lib/members/openapi.ts` + `src/lib/openapi/registry.ts:13` and `src/lib/members/mcp.ts` + `src/lib/mcp/registry.ts:13`. Admin via `requireAdmin()` like `src/pages/api/v1/booking/admin.ts:18`.

## Member endpoints (`src/pages/api/v1/referrals/`)
- `GET me` — eligibility, code, link, R, tier, progress to next tier, discount, balance (pending/approved/paid), recent commissions (masked referee emails), payout profile status, next close date.
- `PATCH me` — `discount_percent`, `leaderboard_opt_out`.
- `GET quote` (public), `POST bind` (code entry while logged in).
- `GET/PUT payout-profile`, `PUT payout-profile/id-images/{front|back}`.
- `GET leaderboard?month=YYYY-MM` (public; `src/lib/referrals/leaderboard.ts`: count commissions with `paid_at` in month, status not reversed/blocked, exclude opt-out, mask "Duy N.", top 10).
- `POST jobs/run` (cron).

## Admin endpoints (`src/pages/api/v1/admin/referrals/`)
- `GET/PATCH settings` (tiers, hold, booking rate, threshold, deduction bp).
- `GET referrers?q=`; `PATCH referrers/{email}` — `admin_rate_override`, `admin_enabled`, lock/unlock (reason).
- `GET commissions?status=review`; `POST commissions/{id}/approve|reject|reverse`.
- `GET payout-profiles?status=submitted`; `GET payout-profiles/{userId}/id-images/{side}`; `POST payout-profiles/{userId}/approve|reject`.
- `GET payouts?period=`, `GET payouts.csv?period=`, `POST payouts/{id}/paid` (`transaction_ref`), `POST payouts/{id}/cancel`.

## MCP (admin scope) `src/lib/referrals/mcp.ts`
`referral_settings_get/set`, `referral_referrer_update`, `referral_review_list`, `referral_commission_decide`, `referral_payouts_list`, `referral_payout_mark_paid`, `referral_leaderboard`. Images are never returned through MCP.

## Tests
Route-level tests for auth (member vs admin vs anonymous), validation errors (discount > R, override > 50), OpenAPI document contains new paths, MCP registry lists tools.
