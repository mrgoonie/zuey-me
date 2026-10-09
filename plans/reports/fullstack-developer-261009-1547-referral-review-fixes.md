# Referral review fixes: implementation report

Source: `plans/reports/code-reviewer-261009-1539-referral-program-review.md`. Commits on `claude/zuey-referral-program-268600` (not pushed):
- `08c0ab8` fix(members): harden next-path redirects and record sign-in IP hashes on sessions
- `25c9a40` fix(referrals): pay the payee snapshotted at close and guard KYC decisions
- `13d03b6` fix(referrals): close commission capture gaps and tighten fraud and discount rules

Verification: `bun test` 486 pass / 0 fail; `tsc --noEmit` clean; `bun run build` succeeds (only pre-existing warnings in `plans/*.js`).

## Fixed

| Item | How | Test(s) |
|---|---|---|
| H1 payee snapshot | `referral_payouts.payee_*` + `payee_verified_at` (0014). Close copies the verified profile (`jobs.ts`, `payout-payee-snapshot.ts`). List/CSV/Studio read the snapshot; CSV gains `payee_verified_at`. `markPayoutPaid` → 409 `payee_unverified` without a verified snapshot. | jobs: "pays the payee snapshotted at close…", "refuses mark-paid for a payout without a verified payee snapshot", "exports a period as CSV…" |
| H2 KYC race | Panel sends `updated_at`. `decidePayoutProfile` requires it (400) and rejects a mismatch (409 `profile_changed`). The guarded UPDATE matches updated_at, status, method, every payee field and both image keys (`IS ?`). 0 rows → 409. R2 deleted only after success; a delete failure is logged as `payout_profile.image_delete_failed` with the keys. | jobs: "refuses a decision on details changed since the admin loaded them…"; api: approve 400/409 path |
| H3 discount not applied | `dodo-card-referral-pricing.ts`: when the first charge net of tax is above the discounted price, the card goes to `needs_attention` / `referral_discount_not_applied` and the commission is captured on the amount collected. No Dodo calls. | checkout: "flags a first charge above the quoted discounted price…" |
| M1 safeNextPath | Trims input. Rejects anything not starting with `/`, over 300 chars, with control chars, whitespace or `\`. Resolves against a fixed origin and requires the same origin. | attribution: "only follows same-site paths" (`/%09/evil.com`, `%5C`, `//`), "safeNextPath rejects control characters…" |
| M2 admin paths | `activate` captures; booking `resolve` captures; booking `cancel` reverses with `'admin_cancel'` and actor `admin`. | commissions: "captures the commission when an admin activates…", "captures on an admin-resolved booking and reverses on an admin cancel" |
| M3 recapture | `recapture-commissions.ts` runs first in `runReferralJobs`. It covers paid orders, confirmed bookings and cards with stored `first_payment_*`. A `referral_source_reversals` tombstone (written when a refund or cancel arrives before any commission exists) blocks recapture. | commissions: "recaptures a commission whose capture failed…, but never one refunded before capture" |
| M4 deleted payers | `referral_paid_email_hashes` stores `sha256('zuey-referral-paid-email:v1:'+canonical)`, recorded on deletion when the member ever paid and checked in `isEligibleReferee`. It is unsalted because eligibility paths have no env and salt rotation would forget customers (documented in the file). Comment fixed. | attribution: "keeps a paying mailbox ineligible after the account is deleted and re-registered" |
| M5 velocity | Window is ±24h around the referee's `referred_at`, with the last 24h as fallback for guests. | commissions: "counts accounts bound around the referee's own binding time…" |
| M6 IP | Code-entry binds pass `ipHash` (checkout and `/referrals/bind`). `member_sessions.ip_hash` is set for magic-link and OAuth sign-ins and included in the shared-IP UNION. | commissions: "flags a referee who entered the code from an IP the referrer signed in from"; attribution: "records the hashed client IP…" |
| M8 deletion/export | `deleteAccount(d1, user, env)` records the paid hash and deletes KYC images first (a missing `REFERRAL_KYC` is logged and tolerated). It then deletes the payout profile and nulls `referee_email`. Payouts keep their snapshot. `exportAccount.referral` added. | jobs: "exports referral data, then deletion removes…", "still deletes the account when the ID-image bucket is not bound" |
| M9 PayPal payer | `parsePayer` reads the payer; capture-on-return passes name→`payerText` and email→`payerEmail`. The email is matched against the referrer's mailboxes and PayPal payout email. | commissions: "flags a booking paid from the referrer's own PayPal account" |
| L2 one pending discount (user decision) | `pending-referral-checkout.ts` covers a pending unexpired order, a pending card checkout within TTL, or an unexpired guest hold on the same canonical email. Checkout and quote then use list price with no snapshot and no error. | checkout: "gives list price with no referral snapshot while…", "counts a guest booking hold on the same canonical mailbox" |
| L3 bind after persist | `bindEnteredReferral` is called after the order/card row exists. | checkout: "binds a typed code only after the card checkout was created" |
| L4 first-only floor | The discounted minimum and subscription amount apply only to the first charge or activation. | checkout: "applies the discounted floor to the first charge only…" |
| L5 MCP masking | `referral_payouts_list` masks national_id (last 3) and bank account (last 4). | api: "masks the national ID and bank account in referral_payouts_list" |
| L6 reconcile payerText | `reconcileSepay` passes `transaction_content`. | commissions: "feeds the SePay reconcile transfer content into the payer check" |
| L7 rate + reschedule | `bookings.usd_vnd_rate` snapshotted at hold and used by commission facts (falls back to env). Reschedule recomputes `hold_until` of pending/review commissions. | commissions: "converts a SePay booking at the rate snapshotted at hold, and moves the hold after a reschedule" |
| Booking always review (user decision) | `manualReview` snapshot flag → `booking_manual_review`; hard blocks still win. | commissions: PayPal booking expects `review` + `booking_manual_review` |

Docs: `docs/env-setup.vi.md` section 12 now covers recapture, the H3 attention reason, the payee snapshot and the mark-paid 409, booking manual review, KYC `updated_at`/409, the one-pending-discount rule, and image deletion on account deletion.

## Not changed (per instruction)
- L1: full reversal on refund and dispute.opened stays as is (user decision).
- M7: untouched.

## Concerns
- H3: a `needs_attention` card loses member access until an admin acts, and the existing attention queue treats card rows as read-only, so the admin resolves them at Dodo and in the DB. A Studio action for card rows may be needed.
- M9: the payer signal only exists on the capture-on-return path. The PayPal webhook capture resource has no payer, so a webhook-first confirmation misses it.
- L5: only `referral_payouts_list` is masked. The MCP `referral_review_list` still returns unmasked payout profile fields (it already omitted images).
- M4: the hash is unsalted SHA-256 of a canonical email, so it can be brute-forced against known emails. That was accepted as the trade-off (see the file comment).
- Recapture does not have the original SePay payer text, so that one soft signal is missing on recaptured order commissions.
- Migration 0014 was edited in place (add-only). It is safe only if 0014 has not been applied to the remote D1 yet.
