---
phase: 2
title: "Attribution and referee eligibility"
status: pending
priority: P1
effort: 4h
dependsOn: [1]
---

# Phase 2 — Attribution and referee eligibility

## Objective
Capture `?ref=CODE` into a 30-day cookie, bind the referrer permanently when a member account is created, allow code entry at checkout for unbound eligible users, and decide referee eligibility.

## Steps
1. `src/lib/referrals/attribution.ts`:
   - `REF_COOKIE = 'zr_ref'`; `readRefCookie(request)`; `refCookieHeader(code, days)` (HttpOnly, Secure, SameSite=Lax, Path=/).
   - Capture: referral links are `https://zuey.me/r/{code}` → `src/pages/r/[code].ts` returns 302 to `/` (or a safe same-origin `?next=`) with `Set-Cookie` and `Cache-Control: no-store`. Never set cookies from middleware on cacheable pages (`/pricing` is `public, max-age=300`; a cached Set-Cookie would leak one referrer to everyone). `?ref=CODE` on any page is handled client-side by redirecting to `/r/CODE`. Unknown/locked code → redirect without cookie. First valid cookie is not overwritten while unexpired.
   - `bindReferrerOnSignup(d1, user, request, env)`: called right after `findOrCreateVerifiedUser` returns `created: true` (magic-link verify and `completeOAuthLogin` call sites, `src/lib/members/users.ts:52`, `src/lib/members/oauth.ts:201`). Sets `referred_by_user_id`, `referred_at`, `referral_signup_ip_hash` (reuse the `ip:` hash pattern from `login-tokens.ts:35`) only if the code's owner ≠ new user. Clears cookie.
   - `bindReferrerByCode(d1, userId, code)`: for checkout code entry; only if user unbound AND eligible referee AND not self.
2. `isEligibleReferee(d1, {userId?, email})`: no paid `billing_orders`, no card subscription that ever reached `active`, no `bookings` confirmed for that email (or the user's email). Email compared normalized.
3. `resolveReferralForCheckout(d1, env, {userId?, email, cookieCode?, enteredCode?, product})` → `{referrer, rate R, discountPercent, commissionPercent} | null`. Rules: referrer must pass `isActiveReferrer`; referee must be eligible; booking uses `bookingSplit`; hard-block self (same user id, normalized email equal, shared OAuth identity subject) returns null.

## Tests (`tests/referrals-attribution.test.ts`)
Cookie set only for valid codes; binding on created user only; no rebind; self-code ignored; previously paid user ineligible; lapsed referrer → null quote; booking guest resolves via cookie/entered code + email.

## Validation
New tests pass; existing auth tests unchanged.
