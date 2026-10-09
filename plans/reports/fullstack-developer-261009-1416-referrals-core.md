# Referrals core: phases 1–2 (schema, rates, ledger, attribution, eligibility)

Status: DONE. `bun test` 397/397 pass. `astro check` 0 errors / 0 warnings; the only new hints are the `await expect().rejects` pattern already used in other tests. `astro build` completes. Nothing committed and the remote DB was not touched.

## Files
- `migrations/0014_referrals.sql` (new, add-only)
- `src/lib/referrals/config.ts`, `rates.ts`, `codes.ts`, `ledger.ts`, `eligibility.ts`, `attribution.ts`, `resolve-checkout-referral.ts` (new)
- `src/pages/r/[code].ts` (new)
- `src/lib/members/login-tokens.ts`: `ipHash` is now exported (one word plus a doc comment), so the signup IP hash reuses the existing salt pattern.
- `src/lib/members/oauth.ts`: `handleMemberOAuthCallback` calls `bindReferrerOnSignup` when `created` is true and appends the cookie-clearing header.
- `src/pages/api/members/auth/magic-link/verify.ts`: the same hook when `created` is true.
- `tests/referrals-core.test.ts` (13 tests), `tests/referrals-attribution.test.ts` (9 tests)

## Schema summary
- `referral_settings` is a single row `'default'`, seeded with `INSERT OR IGNORE`. It holds the tiers JSON, hold_days 30, booking_rate 10, threshold 5000, vn 1000 bp, paypal 1800 bp and cookie_days 30.
- `referral_profiles` uses `user_id` as PK. `code` is UNIQUE with a CHECK for lowercase and 6–16 characters. It also has the discount, override (0–50), admin_enabled, lock fields, opt-out and the tier_* fields.
- `users` gains `referred_by_user_id`, `referred_at` and `referral_signup_ip_hash`, plus the index `idx_users_referred_by`.
- `billing_orders`, `card_subscriptions` and `bookings` gain the six snapshot columns. `card_subscriptions` also gains `first_payment_id`, with a partial index.
- `referral_commissions` has UNIQUE(source_kind, source_id), CHECKs on status and source_kind, and the 3 indexes from the spec.
- `referral_ledger` is AUTOINCREMENT, with a partial UNIQUE(kind, commission_id) WHERE commission_id IS NOT NULL.
- `referral_payout_profiles`, `referral_payouts` (UNIQUE referrer+period) and `referral_events` follow the spec.

## Exported API
```ts
// config.ts
interface ReferralTier { min: number; rate: number }
interface ReferralSettings { tiers; hold_days; booking_rate; payout_threshold_cents; vn_deduction_bp; paypal_deduction_bp; cookie_days; updated_at }
MAX_REFERRAL_RATE = 50; DEFAULT_TIERS; DEFAULT_REFERRAL_SETTINGS
parseTiers(value: unknown): ReferralTier[] | null
getReferralSettings(d1): Promise<ReferralSettings>
updateReferralSettings(d1, patch: Record<string, unknown>): Promise<ReferralSettings>   // AppError 400 invalid_field / invalid_request
// rates.ts (pure)
tierRateFor(count, tiers): number
effectiveRate(profile: {admin_rate_override, tier_count_90d}, settings: {tiers}): number
clampDiscount(d, R): number
membershipSplit(d, R): { discountPercent, commissionPercent }
bookingSplit(d, R, bookingRate): { discountPercent, commissionPercent }
applyPercent(amount, percent, currency: 'USD'|'VND' = 'USD'): number   // returns the discounted amount
// codes.ts
interface ReferralProfile {...}; REFERRAL_CODE_RE
normalizeReferralCode(raw): string | null; generateReferralCode(): string
getReferralProfile(d1, userId); getReferralProfileByCode(d1, code); ensureReferralProfile(d1, userId): Promise<ReferralProfile>
normalizeEmailForSelfCheck(raw): string | null
// ledger.ts
type LedgerKind = 'commission'|'reversal'|'payout'|'adjustment'
appendLedger(d1, { referrerUserId, kind, amountCents, commissionId?, payoutId?, note? }): Promise<{ inserted: boolean }>
balanceCents(d1, userId): Promise<number>
heldCommissionCents(d1, userId): Promise<number>
logReferralEvent(d1, { actor, action, subjectUserId?, detail? }): Promise<void>
// eligibility.ts
isActiveReferrer(d1, userId): Promise<boolean>
isEligibleReferee(d1, { userId?, email? }): Promise<boolean>
isSelfReferral(d1, referrerUserId, { userId?, email? }): Promise<boolean>
// attribution.ts
REF_COOKIE = 'zr_ref'; readRefCookie(request): string | null
refCookieHeader(code, days); clearRefCookieHeader()
activeReferrerByCode(d1, code): Promise<ReferralProfile | null>
handleReferralLink(d1 | undefined, request, rawCode): Promise<Response>
bindReferrerOnSignup(d1, user: {id, email}, request, env): Promise<string | null>   // the Set-Cookie value that clears the cookie; never throws
bindReferrerByCode(d1, userId, code): Promise<{bound:true, referrerUserId} | {bound:false, reason:'already_bound'|'invalid_code'|'self_referral'|'not_eligible'}>
// resolve-checkout-referral.ts
resolveReferralForCheckout(d1, { userId?, email?, cookieCode?, enteredCode?, product: 'membership'|'booking' })
  : Promise<{ referrerUserId, code, rate, discountPercent, commissionPercent, source: 'bound'|'entered'|'cookie' } | null>
```

## Behaviour notes and deviations
1. **`effectiveRate`** recomputes the tier from `tier_count_90d` against the current settings table instead of reading the stored `tier_rate`. An admin edit of the tier table therefore applies immediately. `tier_rate` stays as the job-refreshed display value.
2. **`resolveReferralForCheckout`** takes no `env` argument because nothing in it needs env. It lives in its own file, `resolve-checkout-referral.ts`, rather than in `attribution.ts`, to keep files under 200 lines. Resolution order:
   - A bound account always uses its bound referrer, and a typed code cannot switch it.
   - Otherwise the entered code is tried first, then the cookie.
   - The result is null when the referrer is locked or lapsed, on self-referral, when the referee is ineligible, or when R is 0.
3. **`approvedUnpaidCents`** was not added. Ledger credits happen only on approval, so `balanceCents` already equals approved-and-unpaid. `heldCommissionCents` covers the pending and review commissions that are not yet in the balance.
4. **`applyPercent` rounding:** the discount is rounded down to whole cents for USD, or to whole 1,000 VND, so the payer never gets more than the stated percent and VND prices stay multiples of 1,000. The phase 3 examples check out: 18240 at 15% gives 15504, and 199900 at 5% gives 189905.
5. **`bookingSplit` with R = 0** returns 0/0.
6. **Paid-before checks in `isEligibleReferee`:**
   - Billing orders: `status='paid' OR paid_at IS NOT NULL`.
   - Card subscriptions: status in active/on_hold/paused/expired, or `first_payment_id` set.
   - Bookings: `confirmed` or `amount_paid > 0`.
   - Matching is by user id plus every account, card `customer_email` and booking `guest_email` with the same canonical mailbox. SQL narrows by exact domain suffix and the canonical comparison runs in JS. For gmail.com that scans every address on the domain, which is fine at the current scale and worth revisiting if it grows.
7. **`isSelfReferral`** compares the account ids and the canonical mailboxes on both sides: the account email plus `user_identities.email`. Two accounts cannot share a provider subject (UNIQUE(provider, subject)), so the identity email is the effective "shared OAuth identity" signal.
8. **Conditions for setting or binding:**
   - The `/r/{code}` cookie is set only when the owner passes `isActiveReferrer`, so a lapsed referrer's link is paused.
   - Signup binding also requires an active referrer and not self.
   - Binding is a conditional UPDATE (`referred_by_user_id IS NULL`) and is logged in `referral_events`.
9. **Studio login is not hooked:** `memberCookieForStudioLogin` (owner-only Studio sign-in, no env in scope) does not bind a referrer.
10. **Ledger invariant violations** (wrong sign, or a missing commission id on commission/reversal lines) throw `AppError` 500 because they are programmer errors, not user input.

## Unresolved questions
- None blocking. Phase 3 should use `resolveReferralForCheckout(d1, input)` without `env`, and may call `bindReferrerByCode` when a signed-in, unbound member enters a code.
