# Code review: referral program (`claude/zuey-referral-program-268600`)

Scope: `git diff main...HEAD` (5 commits, 122 files, ~9.3k LOC). Spec: `plans/261009-1416-referral-program/`. Timezone Asia/Saigon.
Verification: `bun test` = 463 pass / 0 fail. `bun run build` = exit 0. Open redirect reproduced with a scratch bun test, not committed.

Tags: CONFIRMED = traced through code or reproduced. PLAUSIBLE = depends on external behaviour or on product intent.

## Overall

The ledger core holds up. Commission credit is a single guarded `INSERT…SELECT` (`jobs.ts:26-35`), and reversal flips status before checking for a credit. Payout lines use NOT EXISTS guards, and UNIQUE(referrer, period) protects them. That combination makes maturity/reversal/close races safe, and webhook retries are idempotent. Math matches the spec: prepay discount, then referral discount (USD floor to cents, VND floor to 1,000), booking `round(10·d/R)`, commission on `min(paid, owed)`.

The real defects sit at the edges:
- payee data is read live at payout time;
- KYC approval has no version guard;
- an open redirect on `/r/`;
- admin-resolved payments skip commission capture;
- account deletion breaks the "previously paid" rule;
- several fraud signals measure the wrong window or have no data.

No critical issues found.

---

## High

### H1. Payout payee details are read live, and mark-paid does not require a verified profile. CONFIRMED
- `src/lib/referrals/payouts.ts:95-98` (`ADMIN_SELECT` LEFT JOINs the current `referral_payout_profiles`), `:160-171` (CSV), `:206-247` (`markPayoutPaid`, no profile check). UI: `src/components/studio/referrals/PayoutsPanel.tsx:82-94` shows the live payee with no status.
- Scenario:
  1. Day-1 close creates a pending payout while the profile is `verified` with account A.
  2. On day 2 the referrer (or someone holding a stolen session) PUTs a new `bank_account` B. `savePayoutProfile` sets status `submitted`/`draft`.
  3. The Studio payouts list and the accountant CSV now show B, with no hint that B is unverified.
  4. The admin pays B by hand and marks it paid. The money goes to an unreviewed account, and the tax CSV records B's name/CCCD instead of the verified identity.
- Fix: snapshot the payee (method, full_name, bank_name, bank_account, national_id, address, paypal_email, `verified_at`) onto `referral_payouts` at close. Alternatively, refuse `markPayoutPaid` (409) when the current profile is not `verified`, or when it changed after `payout.created_at`. Show the profile status in the panel and the CSV.

### H2. KYC approve/reject has no optimistic-concurrency guard: unseen data gets verified and ID images can be orphaned in R2. CONFIRMED
- `src/lib/referrals/payout-profile-review.ts:77-108`. It reads the profile, deletes the keys it read, then runs `UPDATE … WHERE user_id = ?` with no status or `updated_at` guard. `KycReviewPanel.tsx:58` sends no version.
- Scenario A: the admin opens the queue (account A, images I1/I2). The member then edits the bank account to B; status stays `submitted`. The admin clicks Approve, and B becomes `verified` without ever being displayed.
- Scenario B: a member `uploadIdImage` lands between the admin's read and the UPDATE. The new key K3 is written, then the admin UPDATE sets `id_front_key = NULL`. K3 is never deleted, so a national-ID image stays in R2 indefinitely. This violates the "deleted on approval" rule.
- Fix:
  - Include the expected `updated_at` from the panel in the request body.
  - Use `UPDATE … WHERE user_id = ? AND updated_at = ? AND status = ?` and return 409 when it changes 0 rows.
  - Delete the objects only after the guarded UPDATE succeeds; keep the deleted key list from the same read.
  - Alternatively, block member writes while a decision is in flight.

### H3. Dodo referral discount relies on unverified behaviour (`allow_discount_code: false` plus `discount_codes`). PLAUSIBLE
- `src/lib/payments/dodo.ts:111-121` (comment: "NOT YET VERIFIED"). `plans/reports/fullstack-developer-261009-1416-referrals-payments.md:109-110`.
- Scenario: if Dodo ignores pre-applied codes when the input is hidden, the referee is charged list price after being shown the discounted price.
  - `applyPaymentEvent` accepts it, because `totalAmount >= expected`.
  - Commission is still `R − d` on the full price.
  - Nothing flags it.
- The plan lists this as a "Stop and ask" gate.
- Fix:
  - Verify with `POST /checkouts/preview` (`current_breakup.discount`) in test mode before launch.
  - Add a guard: when a referral card's first `payment.succeeded` has `totalAmount − tax` above `cardFirstChargeCents`, mark the card `needs_attention` (`referral_discount_not_applied`) so the admin can refund the difference.

---

## Medium

### M1. Open redirect via `/r/{code}?next=/%09/evil.com`. CONFIRMED (reproduced)
- `src/lib/referrals/attribution.ts:45` uses `safeNextPath` (`src/lib/members/runtime.ts:101-106`), which only rejects `\r\n`, `//` and `/\`. Browsers strip TAB (and LF/CR) when parsing URLs.
- Repro: `handleReferralLink(undefined, new Request('https://zuey.me/r/abcdefgh?next=%2F%09%2Fevil.com'), …)` returns `Location: "/\t/evil.com"`, which resolves to `https://evil.com/`.
- Works with any code (valid or not) on an unauthenticated GET. Referral links are designed to be shared publicly, which makes this a good phishing vector. The helper existed before this branch; this branch exposes it on a public GET.
- Fix: in `safeNextPath`, reject any ASCII control character or whitespace (`/[\u0000-\u001F\u007F\s]/`) and backslashes anywhere. Better: resolve with `new URL(v, 'https://x.invalid')`, require `origin === 'https://x.invalid'`, and return `pathname + search + hash`.

### M2. Admin-resolved payments never capture a commission; admin booking cancel never reverses one. CONFIRMED
- `src/lib/members/billing-attention.ts:178-199`: `activate()` flips a needs_attention or dismissed order to `paid` and calls `fulfilOrder`, but never `captureReferralCommission`.
- `src/lib/booking/store.ts:871-878`: `adminUpdateBooking('resolve')` does the same for bookings.
- `src/lib/booking/store.ts:864`: `cancel` leaves the commission to mature.
- Scenarios:
  - A referee underpays by a few thousand VND, or pays 1 minute after expiry. The order goes to attention, the admin activates it, and the referrer silently loses the commission.
  - An admin cancels or refunds a confirmed referred booking. The commission is still credited after `slot_end` + 30 days.
- Fix:
  - Call `captureReferralCommission(d1, env, { kind: 'billing_order', id })` after a successful `activate`, and the booking equivalent after `resolve`. `sourceFacts` already caps the base to collected/owed.
  - On booking `cancel`, call `reverseCommission({sourceKind:'booking'}, 'admin_cancel')`, or at least surface it in the response.

### M3. Commission capture failures are swallowed with no repair path. CONFIRMED
- `src/lib/referrals/commissions.ts:231-238`. Any throw is logged to `referral_events` as `commission.failed`, and nothing retries it. Example throws: a transient D1 error, or a missing `USD_VND_RATE` for a VND booking (`:171`). The test run prints exactly this: `referral commission for booking … failed: USD_VND_RATE is required`.
- Provider retries won't help either, because the order is already `paid`/`confirmed`.
- Fix:
  - Add a reconcile step to `runReferralJobs` that recaptures paid referred sources missing a commission:
    - `billing_orders WHERE referrer_user_id IS NOT NULL AND status='paid' AND NOT EXISTS (commission)`;
    - the same for confirmed bookings and for cards with `first_payment_id`.
  - Card recapture needs the collected amount, so store `first_payment_cents`/`tax` on the card row.
  - Or surface `commission.failed` in the Studio review queue.

### M4. "Never paid before" check is bypassed by deleting the account and signing up again. CONFIRMED
- `src/lib/members/users.ts:216-231`: `deleteAccount` rewrites `users.email` to `deleted+<id>@deleted.invalid`.
- `src/lib/referrals/eligibility.ts:53-64` finds "live and deleted accounts" only through `users.email`. The doc comment is false for deleted ones. `billing_orders` has no email column.
- Scenario:
  1. A SePay customer deletes their account.
  2. They re-register with the same email through a friend's `/r/` link.
  3. `isEligibleReferee` is true, so they get the discount and the friend gets a first-order commission.
  - Card customers are still caught via `card_subscriptions.customer_email`, and bookings via `guest_email`. SePay-only payers are not.
- Fix: store a salted hash of the canonical email of any account that ever paid (or keep `referee_email`-style canonical hashes) and check it in `isEligibleReferee`. Also correct the comment.

### M5. Velocity signal is measured at payment time, not around signup. CONFIRMED
- `src/lib/referrals/fraud-signals.ts:44-48` counts bindings in `[now − 24h, now]` at payment.
- Scenario: 20 farm accounts bind on day 1 and pay on day 2 or later. The count is 0 and no review is triggered.
- Fix: count bindings within ±24h of the referee's `referred_at`. Or record a `velocity` flag on the user at bind time (`bindReferrer`) and read it at commission time.

### M6. Shared-IP signal has blind spots. CONFIRMED
- `fraud-signals.ts:22-35` compares the referee's `referral_signup_ip_hash` with the referrer's `login_tokens.ip_hash` (magic links only).
- `attribution.ts:112`: checkout code-entry binding passes `null`, so no IP is stored.
- Effects:
  - A referrer who signs in only with Google/GitHub has no `login_tokens` rows, so shared-IP never fires for them.
  - A referee bound by typed code never has an IP hash.
  - A self-referral through a second mailbox and code entry passes as `ok`.
- Fix:
  - Record `ipHash` in `bindReferrerByCode` (pass the request through).
  - Store an `ip_hash` on `member_sessions` (or reuse `user_activity`) and include it in the referrer-IP lookup.

### M7. Eligibility runs full-table scans on hot paths. CONFIRMED (performance)
- `src/lib/referrals/eligibility.ts:40-51`. `substr(lower(col), -?) = ?` cannot use an index. For `@gmail.com` it returns every Gmail row of `users`, `card_subscriptions` and `bookings` (twice: gmail plus googlemail), and then filters in JS.
- `isEligibleReferee` runs on every signed-in `GET /api/v1/referrals/quote`, which is called on every `/pricing` and booking view. It also runs on every checkout and in every fraud snapshot.
- Cost grows with total users (D1 rows read and latency) and shows up most for Vietnamese Gmail-heavy users.
- Fix: add a `canonical_email` column (or a hash of it) to `users`, `card_subscriptions` and `bookings`, with indexes. Backfill it in the migration or lazily, then query by equality.

### M8. Referral PII is not removed on account deletion. CONFIRMED
- `deleteAccount` (`users.ts:216`) does not touch:
  - `referral_payout_profiles`: full_name, CCCD number, address, bank account, and R2 ID images if they are still `submitted`/`draft`;
  - `referral_commissions.referee_email`;
  - the referral data in `exportAccount`.
- The KYC images are the most sensitive data in the system, and they persist after the member asks for deletion.
- Fix:
  - In `deleteAccount`, delete the R2 objects plus the payout profile row. Keep only what accounting needs, ideally snapshotted on `referral_payouts` per H1.
  - Null or mask `referee_email` for the deleted user.
  - Add referral data to `exportAccount`.

### M9. Guest-booking self-referral with an unverified email. PLAUSIBLE
- `src/lib/booking/store.ts` `createHold` resolves the referral from the guest-typed email only. For PayPal there is no payer-identity check (`payerText` exists only for SePay).
- Scenario: a referrer opens their own `/r/` link and books using a fresh email. They get discount d plus commission (10 − d)% of $1,999, about $200 back per booking. The only checks are a disposable-domain match and a name match on SePay transfer text.
- Fix:
  - Compare the PayPal capture `payer.email_address`/name with the referrer's mailboxes and payout profile (soft `review`).
  - Or route all booking commissions to `review` by default.

---

## Low

- **L1. Full reversal on partial refunds and `dispute.opened`; no restore when a dispute is won.** PLAUSIBLE (policy). `dodo-billing.ts:476-490`, `booking/store.ts:650-660`. A $1 partial refund wipes the whole commission. A won Dodo/PayPal dispute leaves it reversed. Confirm the intent; otherwise pro-rate by `amount`, and handle `dispute.won` through an admin "restore" action.
- **L2. The discount applies to every concurrent pending order or card checkout.** CONFIRMED. Only the first paid order gets commission, but up to `MAX_PENDING_ORDERS` SePay orders plus one card checkout per plan are created while the referee is still "never paid", and each carries the discount. Bounded, but it contradicts "discount on first order". Fix: refuse a referral snapshot when another referred pending order or card exists for the user.
- **L3. A typed code binds permanently before checkout validation can still fail.** CONFIRMED. `billing.ts:246-247` resolves (and binds) before `startCardCheckout` checks `already_subscribed`, the pending limit, or a Dodo outage. The same happens at `billing.ts:182` before insert. Fix: bind after the order or card row is persisted.
- **L4. Referral cards accept the discounted amount on renewals too.** CONFIRMED. `dodo-billing.ts:319` and `:416` apply `expectedFirstChargeCents` to every payment and subscription event, so a renewal charged below list price is no longer flagged. Fix: use the discounted floor only when `isFirstPayment` (or for the first subscription.active); use list price otherwise.
- **L5. MCP `referral_payouts_list` returns national_id, address and bank account to MCP clients.** CONFIRMED (`mcp.ts:117-118`, `payouts.ts:95-114`). This is admin-only, but CCCD numbers then flow into LLM context. Consider masking national_id over MCP.
- **L6. SePay reconcile path drops `payerText`.** CONFIRMED (`billing.ts` `reconcileSepay` passes no `payerText`). Payments recovered by reconcile skip the payer-match fraud signal. Pass `tx.transaction_content`.
- **L7. Booking commission details.** CONFIRMED.
  - The VND base converts at the current `USD_VND_RATE`, not a rate snapshotted at hold (`commissions.ts:168-172`).
  - `hold_until` does not follow a reschedule.
  - Fix: snapshot the rate on the booking at hold, and recompute `hold_until` on reschedule while still pending.
- **L8. Phase 8 acceptance is not met yet.** CONFIRMED. README and `docs/env-setup.vi.md` are not updated, migration 0014 is not applied to remote D1 (Time Travel bookmark), and the `REFERRAL_KYC` bucket creation is not documented. This is expected because phase 8 is pending, but it blocks "Done means" items 1 and 7.

---

## Verified OK (risk calibration)

- **Webhook idempotency**:
  - UNIQUE(source_kind, source_id) plus `ON CONFLICT DO NOTHING`;
  - the partial unique ledger index (kind, commission_id);
  - Dodo/PayPal reversals are idempotent through the status guard plus the unique reversal line.
- **Races**:
  - maturity vs reversal: credit requires `status='approved'` in the same statement as the insert;
  - close vs reversal: gross is snapshotted, and the negative carries;
  - paid vs cancel: guarded `WHERE status='pending'`, adjustment only when `status='cancelled'`.
- **Day-1 close**: Saigon UTC+7 arithmetic is correct, the period label is the previous month, threshold and negative carry-over work, and the VN/PayPal deduction bp come from settings.
- **Authz**:
  - every admin route goes through `requireAdminActor`;
  - member routes use `requireUserId` with the principal's own id (no user-id parameter, so no IDOR);
  - payout-profile PUT and ID upload require `account:security` (session-only, same-origin), so API keys cannot change payout details;
  - MCP tools are ADMIN in `tool-access.ts` and re-checked in `call`.
- **KYC proxy**:
  - `side` is enum-validated and `userId` is only a DB lookup (key comes from the DB, so no path traversal);
  - no-store, nosniff, audited;
  - upload checks magic bytes and the 5 MB cap.
- **Cookies**: `zr_ref` is set only by the no-store `/r/` 302 and cleared on the magic-link/OAuth responses. `/referral` marks members private/no-store. The `?ref=` script only navigates to same-origin `/r/…`, and a `//` pathname is caught by `safeNextPath`.
- **Self-referral checks** (account id, canonical email, OAuth identity emails) run at bind, checkout and commission. Binding after paying is blocked (`isEligibleReferee` in `bindReferrerByCode`).
- **Quote endpoint** returns only the code and percents, never referrer name or email.
- **CSV** quotes every cell and prefixes `= + - @ TAB CR` on strings.
- **No regressions without a referral**: SePay amounts, the booking expected amount, Dodo price checks (allowed set collapses to list price) and PayPal capture parsing are all unchanged.

## Recommended actions (priority)
1. H1: snapshot the payee on the payout, and block mark-paid on an unverified profile.
2. H2: version-guard the KYC decision, and delete objects after the guarded update.
3. M1: harden `safeNextPath`.
4. H3: verify Dodo discount application in test mode, and add the overcharge guard.
5. M2 and M3: capture on admin activation/resolve, reverse on booking cancel, and add a recapture job.
6. M4, M5, M6: fix the fraud and eligibility gaps.
7. M8: clean up KYC/PII on account deletion.
8. M7: add an indexed canonical email column.

## Unresolved questions
- Partial refunds: should the commission reversal be pro-rated, and should a won dispute restore it?
- Should the referee discount apply to only one order (first created), or to any order while "never paid"?
- Should booking commissions default to `review`, given guest emails are unverified?

**Status:** DONE_WITH_CONCERNS
**Summary:** 0 critical, 3 high, 9 medium, 8 low. Tests (463/463) and build pass. Ledger idempotency and race handling are sound. The main risks are payout payee integrity, the KYC decision race, an open redirect, and commission capture/eligibility gaps.
