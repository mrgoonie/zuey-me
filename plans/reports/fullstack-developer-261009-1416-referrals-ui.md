# Phase 7 – Referral UI (OS app, checkout surfaces, Studio admin)

Plan: plans/261009-1416-referral-program/phase-07-ui-os-app-admin.md · Status: completed, not committed.

## Outcome
- **Zuey OS app** `referral` (stage slot, dock 10th, Gift glyph) and a standalone `/referral` page, both rendering `ReferralApp`.
- **ReferralApp** has three tabs: Program, Get paid and Leaderboard.
  - It covers the signed-out CTA, the not-eligible and locked notices, the tier card with 90-day progress and the tier ladder, and the link with copy and QR.
  - It has the split slider 0..R ("Bạn nhận X% · Bạn bè giảm Y%") with a booking preview at the 10% rate, plus the opt-out toggle.
  - Earnings show balances (pending, approved, processing, paid), commissions and payouts.
  - The payout profile form covers VN bank (full name, bank, account, CCCD, address, CCCD front/back upload with status) and PayPal. Deduction labels ("Thuế TNCN 10%" / "Phí xử lý & thuế 18%") come from program settings.
  - The leaderboard has a 12-month selector.
- **Checkout surfaces**
  - `/pricing` uses a client island that calls `GET /api/v1/referrals/quote` (no per-user SSR). It shows the struck price, the referral price and a "Mã giới thiệu" field.
  - Billing checkout and the booking hold send an optional `referral_code`. BillingStatus and BookingWidget show the discount line the server returns.
  - `?ref=CODE` triggers an inline base-layout script that redirects to `/r/CODE?next=<path without ref>`. The client sets no cookies.
- **Studio ReferralsTab** has five sections:
  - Review queue (approve / reject / reverse with a note).
  - KYC (details, ID image viewer through the admin proxy, approve / reject with a reason).
  - Payouts (by period, CSV, mark paid with transaction_ref, cancel).
  - Referrers (search, enable by email, rate override, enable, lock / unlock).
  - Settings (tiers, hold days, booking rate, threshold, deduction bp).

## Files
New:
- src/components/referral/: ReferralApp, ReferralTierShareCard, ReferralSplitCard, ReferralEarnings, ReferralPayoutProfileForm, ReferralIdImageUpload, ReferralLeaderboard, ReferralCodeField, referral-section, referral-api, referral-i18n, referral-quote, ref-redirect
- src/components/studio/ReferralsTab.tsx
- src/components/studio/referrals/: referral-admin-kit, ReferralSettingsPanel, ReferrersPanel, CommissionReviewPanel, KycReviewPanel, PayoutsPanel
- src/pages/referral.astro
- tests/referrals-ui.test.ts

Modified:
- src/components/os/{apps.ts, os-i18n.ts, AppGlyph.tsx, os.css}
- src/pages/index.astro, src/layouts/Layout.astro, src/components/QrCodeModal.tsx
- src/components/members/{PricingTable.tsx, BillingStatus.tsx, member-ui.ts}
- src/components/booking/BookingWidget.tsx, src/components/studio/StudioApp.tsx
- tests/referrals-checkout.test.ts

All new files are under 200 lines except referral-api.ts (206 lines: parsers plus formatters). BookingWidget and StudioApp were already over 200 lines before this phase.

## Backend wiring (trivial; no behavior change)
- src/lib/booking/store.ts: the PayPal `CheckoutResult` now also returns `amount_usd_cents` (the due amount the server already computed), so the widget shows the discounted PayPal amount. The OpenAPI entry in src/lib/booking/openapi.ts is updated.
- src/lib/payments/dodo-billing.ts: `CardSubscriptionView` exposes `referral_discount_percent`, which is null when there is no referrer. The members OpenAPI is updated.
- Both are asserted in tests/referrals-checkout.test.ts.

## Verification
- `bun test` passes: 463 tests, 0 failures (baseline was 449; the new UI tests add 14).
- `bunx tsc --noEmit` is clean.
- `bun run build` finishes with 0 errors and 0 warnings. The 37 hints are in pre-existing files: tests/*.test.ts `await` hints and the plans/ demo JS.
- The built Layout chunk contains the inline redirect with no `__name` injection.
- Visual check:
  - Ran `bun run dev` on :4321 and applied migrations to the worktree-local D1 (`.wrangler`, gitignored).
  - Seeded a local admin-enabled member with a session and 2 commissions.
  - Captured screenshots with headless Chrome over CDP: /referral at 1280px and 375px, the Get paid tab at 375px, signed-out at 375px, the OS window via `/#referral` at 1280px, and `/pricing?ref=visual234`.
  - All layouts render without overflow.
  - The `?ref=` redirect landed back on /pricing with the param removed, and the quote card showed "Ưu đãi giới thiệu −10% · mã visual234" from the zr_ref cookie.
  - The dev server (PID 40907) and Chrome (PID 53438) are stopped.
  - Not visually checked: the Studio tab (needs an admin session; type- and build-checked only) and per-plan discounted VND on /pricing (no local USD/VND rate, so `amount_vnd` is null and checkout is closed locally).

## Deviations
- The vi OS label is "Giới thiệu bạn bè" because "Giới thiệu" already labels About.
- The referral app sits 10th in the dock with no Alt shortcut.
- QrCodeModal gains optional `title`, `hint` and `fileName` props; existing callers are unchanged.
- Checkout surfaces (PricingTable, BookingWidget, BillingStatus) are Vietnamese-only, like the existing components. ReferralApp has vi and en. Studio is English-only, like the rest of Studio.
- The phase file and plan status were not edited.

## Unresolved questions
- `referral_code` on the billing order and booking hold request bodies is not yet in OpenAPI. Should phase 8 docs cover it?
- Should referral-api.ts (206 lines) be split into parsers and formatters?
