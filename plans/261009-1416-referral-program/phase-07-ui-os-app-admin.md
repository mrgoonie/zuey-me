---
phase: 7
title: "UI: Zuey OS referral app, leaderboard, checkout and admin"
status: pending
priority: P2
effort: 6h
dependsOn: [6]
---

# Phase 7 — UI

## Zuey OS app
- `src/components/os/apps.ts`: add `referral` to `AppId`, `SlotAppId`, `APPS` (surface `stage`, href `/referral`), `DOCK_APPS`, `SLOT_APPS`.
- `src/components/os/os-i18n.ts` (en :8, vi :66): labels "Referral" / "Giới thiệu".
- `src/pages/index.astro:56-88`: add `<div slot="referral">` rendering `ReferralApp`; confirm `ZueyOS.tsx` renders slot ids generically.
- `src/pages/referral.astro`: standalone route with the same component.
- `src/components/referral/ReferralApp.tsx` (+ small subcomponents, files < 200 lines): signed-out → sign-in CTA; not eligible → explain (needs active plan); eligible → tier card with progress, link + copy + QR (reuse `QrCodeModal`), split slider (0..R, "Bạn nhận X% · Bạn bè giảm Y%", booking preview at 10 %), balances, recent commissions, payout profile form (VN/PayPal tabs, image upload, status), leaderboard tab, opt-out toggle. Deduction labels: "Thuế TNCN 10%" and "Phí xử lý & thuế 18%" read from settings.

## Checkout surfaces
- `/pricing` (`src/pages/pricing.astro`, cached): client island calls `GET /api/v1/referrals/quote` and shows struck-through list + referral price and a "Mã giới thiệu" input.
- Billing checkout + booking widget: optional code field passed as `referral_code`; show discount line returned by server.

## Admin
Studio tab `src/components/studio/ReferralsTab.tsx`: settings form (tiers table), referrer search + override/enable/lock, review queue, KYC review (image viewer → approve/reject), payouts by period with CSV and mark-paid.

## Validation
`bun run build`; manual check in browser preview of OS window at desktop and 375 px width; vi/en strings.
