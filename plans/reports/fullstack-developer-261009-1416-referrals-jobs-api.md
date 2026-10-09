# Referral jobs, payouts, profiles and API surfaces: phases 5–6

Status: DONE_WITH_CONCERNS. `bun test` passes 449/449, including 28 new tests. `bun run build` reports 0 errors and 0 warnings, and its 37 hints are the same pre-existing ones. Nothing was committed, no remote calls were made, and no R2 bucket was created. Plan and phase status are left for the orchestrator to set through `ak plan`.

## Files
New, under `src/lib/referrals/`:
- `jobs.ts`
- `payouts.ts`
- `payout-profiles.ts` (member side)
- `payout-profile-review.ts` (admin side; split out to keep files under about 250 lines)
- `leaderboard.ts`
- `member-api.ts`
- `admin-api.ts`
- `admin-route.ts`
- `saigon-calendar.ts`
- `openapi.ts`
- `mcp.ts`

New elsewhere:
- `src/lib/cron-auth.ts`
- Routes under `src/pages/api/v1/referrals/`: `me`, `bind`, `leaderboard`, `payout-profile/index`, `payout-profile/id-images/[side]`, `jobs/run`
- 11 route files under `src/pages/api/v1/admin/referrals/`
- Tests: `tests/referrals-jobs.test.ts` (15 tests), `tests/referrals-api.test.ts` (13 tests), and the helper `tests/helpers/r2.ts` (an in-memory fake R2 bucket)

Modified:
- `src/env.d.ts`: adds `R2BucketLike` and `R2ObjectBodyLike`, and `REFERRAL_KYC?: R2BucketLike`.
- `wrangler.toml`: adds an `[[r2_buckets]]` entry with binding `REFERRAL_KYC` and bucket name `zuey-referral-kyc`.
- `src/lib/openapi/registry.ts` and `src/lib/mcp/registry.ts`: register the new fragment and module.
- `workers/scheduler/src/index.ts`: adds `/api/v1/referrals/jobs/run` to `JOBS`.

These files were also modified but are **outside my ownership list**:
- `src/lib/cron-auth.ts` plus `src/pages/api/v1/articles/notifications/dispatch.ts`: `isCronCaller` was a private function in dispatch.ts. I moved it unchanged into the new shared module and dispatch.ts now imports it.
- `src/lib/oauth/tool-access.ts`: the 8 new tools are added as ADMIN. This is required because the existing test `oauth-mcp.test.ts:619` fails if any registered tool is missing from the map.
- `src/lib/members/email.ts`: `'referral_payout'` is added to the `EmailKind` union. The `email_log.kind` column has no CHECK constraint, so no migration is needed.

## Endpoints
Member endpoints. Session means the `zuey_member` cookie with a same-origin request, or a `zk_` key with the listed scope.

| Method | Path | Auth |
|---|---|---|
| GET | `/api/v1/referrals/me` | account:read |
| PATCH | `/api/v1/referrals/me` with `{discount_percent?, leaderboard_opt_out?}` | account:write |
| POST | `/api/v1/referrals/bind` with `{code}` | account:write. Errors: 400 `referral_code_invalid` (`reason`), 409 `referral_already_bound` |
| GET | `/api/v1/referrals/payout-profile` returns `{profile \| null}` | account:read |
| PUT | `/api/v1/referrals/payout-profile` | **browser session only** (the `account:security` action) |
| PUT | `/api/v1/referrals/payout-profile/id-images/{front\|back}` (raw image body) | browser session only |
| GET | `/api/v1/referrals/leaderboard?month=YYYY-MM` | public, `Cache-Control: public, max-age=300` |
| POST | `/api/v1/referrals/jobs/run` | `Bearer CRON_SECRET`, otherwise admin |
| GET | `/api/v1/referrals/quote` (from phase 3) | now documented in OpenAPI |

Admin endpoints, all under `/api/v1/admin/referrals`. Each requires an admin member session, a Studio session or an admin API key, and responses are `no-store`.

| Method | Path |
|---|---|
| GET, PATCH | `/settings` |
| GET | `/referrers?q=&limit=` |
| PATCH | `/referrers/{email}` with `{admin_rate_override: null\|0–50, admin_enabled, locked, lock_reason}`. Locking requires `lock_reason`. |
| GET | `/commissions?status=&limit=` |
| POST | `/commissions/{id}/{approve\|reject\|reverse}` with `{note?}` |
| GET | `/payout-profiles?status=` (defaults to `submitted`; `all` returns every status) |
| GET | `/payout-profiles/{userId}/id-images/{side}`: returns image bytes with no-store and nosniff headers, and writes the `payout_profile.image_viewed` audit event |
| POST | `/payout-profiles/{userId}/{approve\|reject}` with `{reason}` (required for reject) |
| GET | `/payouts?period=&status=` |
| GET | `/payouts.csv?period=` (period required) |
| POST | `/payouts/{id}/paid` with `{transaction_ref}` |
| POST | `/payouts/{id}/cancel` with `{reason?}` |

## MCP tools
All admin-only, in `referralsMcpModule`:
- `referral_settings_get`, `referral_settings_set`
- `referral_referrer_update`
- `referral_review_list`: returns review commissions plus submitted profiles, with `has_id_*` flags only and never images or storage keys
- `referral_commission_decide`
- `referral_payouts_list`, `referral_payout_mark_paid`
- `referral_leaderboard`

## Response shapes for the UI (phase 7)
All money is USD cents.

**`GET me` returns `ReferralMeView`:**
- `eligible`, `locked`
- `code`, `link`: `${PUBLIC_SITE_URL}/r/{code}`, or null when the member has no profile
- `rate` (R), `admin_rate_override`
- `tier`: `{count_90d, rate, window_days: 90, next: {min, rate, remaining} | null}`
- `discount_percent`
- `membership_split` and `booking_split`, each `{discount_percent, commission_percent}`
- `leaderboard_opt_out`
- `balance`: `{pending_cents, approved_cents, processing_cents, paid_cents}`
  - `pending_cents` covers commissions in their hold or in review.
  - `approved_cents` is the ledger balance and can be negative.
  - `processing_cents` covers closed payouts the admin has not paid yet.
- `commissions[]` (last 20): `{id, source_kind, referee (masked as "la***@x.com"), base_amount_cents, commission_percent, commission_cents, status, paid_at, hold_until, approved_at, reversed_at}`
- `payouts[]` (last 20): `{id, period, method, gross_cents, deduction_bp, deduction_cents, net_cents, net_vnd, status, transaction_ref, paid_at}`
- `payout_profile`: `{status, method} | null`
- `next_close_date`: `YYYY-MM-01`
- `program`: `{tiers, hold_days, booking_rate, payout_threshold_cents, vn_deduction_bp, paypal_deduction_bp}`

**`PATCH me`** returns the same view. When the discount is above R it fails with 400 `invalid_field`, and `max` holds R.

**Leaderboard:** `{month, entries: [{rank, name: "Duy N.", referrals}]}`. Tied counts share a rank (1, 1, 3).

**Payout profile:** `{user_id, method, status, full_name, bank_name, bank_account, national_id, address, paypal_email, has_id_front, has_id_back, verified_at, reject_reason, updated_at}`. The admin view adds `email`, `name`, `verified_by` and `created_at`.

**Admin lists:**
- `{referrers: [{user_id, email, name, code, rate, tier_count_90d, tier_rate, admin_rate_override, admin_enabled, discount_percent, locked_at, lock_reason, leaderboard_opt_out, balance_cents, held_cents, referred_count, created_at}]}`
- `{commissions: [ReferralCommission + referrer_email]}`
- `{profiles: [...]}`
- `{payouts: [payout + email, name, payee: {full_name, bank_name, bank_account, national_id, address, paypal_email}]}`

**Decision responses:**
- Commission decision: `{outcome: approved | released_to_hold | rejected | reversed | already_reversed, commission}`
- Mark paid: `{outcome: paid | already_paid, payout, email: sent | skipped | failed | duplicate | null}`
- Cancel: `{outcome: cancelled | already_cancelled, payout}`

## Behaviour notes
- **Maturity:** `pending` commissions past their hold become `approved`, except those of locked referrers.
  - The ledger credit is a single `INSERT … SELECT … WHERE status = 'approved' AND NOT EXISTS`. A commission reversed at the same moment is therefore never credited, and an interrupted approval is repaired on the next run.
  - Zero-cent commissions are approved but get no ledger line.
  - `review` is never approved automatically.
- **Tiers:** a success is a commission with `paid_at` in the last 90 days that is approved, or pending with its hold passed. Only profiles whose values changed are written.
- **Close:** it runs only when the Asia/Saigon local date (a fixed UTC+7 offset) is day 1.
  - The period label is the month that just ended: the Nov 1 close produces period `2026-10`.
  - The threshold comes from settings, with a minimum of 1 cent. Gross is the full balance.
  - `deduction = round(gross·bp/10000)`. `net_vnd = round(net·USD_VND_RATE/100)`, rounded to whole VND.
  - The ledger books a −gross line. Every run also repairs any payout that is missing its ledger line.
- **Admin approve on a review commission:** it becomes `approved` (and credited) when its hold has passed. Otherwise it becomes `pending` (`released_to_hold`) so maturity handles it.
- **Admin reject:** a review or pending commission becomes `blocked`, and `admin_rejected` is appended to `review_reasons`. Approved commissions must use reverse instead.
- **Payout profiles:**
  - Any member edit clears verification. VN profiles stay `draft` until both images are present, then become `submitted`. PayPal profiles become `submitted` at once, and switching to PayPal deletes stored images.
  - Image uploads check the `Content-Type` (jpeg, png or webp), the Content-Length and actual byte count against 5 MB, and the file's magic bytes. Objects are stored under the random key `kyc/<32 base64url>`, and a replaced image is deleted.
  - On approve or reject, the R2 objects are deleted **before** the keys are cleared. If the delete fails, the decision is left undone and can be retried.

## Deviations
1. **Files outside the ownership list:** `tool-access.ts`, `email.ts`, `dispatch.ts` and the new `src/lib/cron-auth.ts`, each a minimal change explained above. Phases run sequentially, so this should not conflict with another phase.
2. **Locked referrers:** they are skipped at close (`referrer_locked`) and left off the leaderboard. A locked referrer is a fraud suspect, so this is fail-closed; an admin can unlock them.
3. **Payout profile writes are session-only:** PUT and image PUT reuse the `account:security` action, so a leaked `zk_` key cannot redirect payouts.
4. **Extra `me` fields:** `processing_cents` and `payouts[]` were added to `GET me` so the UI can show money that is closed but not yet paid, and payout history.
5. **Name masking:** "first word + initial of last word". This gives "Duy Nguyen" → "Duy N." and "Nguyễn Văn Đức" → "Nguyễn Đ.". With no name, it shows the email's first letter plus `***`.

## Unresolved questions
- The `zuey-referral-kyc` bucket must be created (private) before deploy (phase 8). Until then the routes return 503 naming `REFERRAL_KYC`.
- Should a referrer who misses the day-1 close (for example an unverified profile verified on day 2) wait for the next month? The current behaviour is yes, per the locked spec.
- Rejecting a review commission sets it to `blocked`. Confirm that is the intended terminal state, rather than `reversed`.

Status: DONE_WITH_CONCERNS
Summary: Phases 5 and 6 are implemented: idempotent jobs for maturity, tiers and the day-1 close; payouts; payout profiles with KYC images in R2 that are deleted on decision; the public leaderboard; member and admin REST; OpenAPI; and admin MCP tools. Full tests and build are green. The concern is four small edits to files outside the ownership list, which were needed for DRY and to keep the existing tool-access test green.
