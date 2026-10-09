# Code review: courses branch, referral wiring + merge resolutions

Branch `claude/courses-learning-widgets-cfcd72` vs `origin/main` (merge base). Read-only review.

## Verification run
- `bun test`: 553 pass, 0 fail (32 files).
- `npx tsc --noEmit -p .`: clean (the 3 known middleware errors no longer show up).
- Migration 0018 tail replayed on real SQLite (bun:sqlite, `PRAGMA foreign_keys=ON`). I applied 0001–0017, seeded a `referral_commissions` row and a `referral_source_reversals` row, then applied 0018. Rows were preserved, the 3 named indexes and the UNIQUE autoindexes were recreated, `foreign_key_check` came back empty, and inserting `'course_order'` now works.

## Findings (ranked)

### 1. MEDIUM-HIGH: a bound account skips every "never paid" check on courses, including the canonical-mailbox and deleted-account checks
- `src/lib/courses/referral-bridge.ts:46-58` (`boundReferral`) checks only locked, active, self and rate. It never calls `isEligibleReferee`. Memberships do call it for bound accounts (`resolve-checkout-referral.ts:61`).
- `src/lib/referrals/fraud-signals.ts:105-107` forces `refereePreviouslyPaid=false` for any `course_order` whose buyer is bound to the referrer. This also skips the `isPaidEmailRecorded` and canonical-mailbox checks inside `isEligibleReferee`.
- Signup binding (`attribution.ts:82-95`, `bindReferrerOnSignup`) has no eligibility check. `normalizeEmail` (`users.ts:23`) only lowercases, so `a.lice@gmail.com` is a different account from `alice@gmail.com`.
- Scenario: Alice has paid before as `alice@gmail.com`, or deleted that account after paying (her hash is in `referral_paid_email_hashes`). She signs up as `a.lice@gmail.com` through a friend's link and is bound at signup. Membership checkout correctly refuses her the discount. Course checkout gives her the referee discount on every course and creates a `pending` commission each time, because the fraud snapshot reports "not previously paid".
- Fix: bound accounts should pass the first-order check once, as of their binding. Check `isEligibleReferee` against payments made before `users.referred_at` by other accounts on the same mailbox, plus the paid-email hash. A simpler alternative: run `isEligibleReferee` (excluding the account's own post-binding orders) in `boundReferral`, and make `repeatOrdersOfBoundReferee` skip only the same-account check.

### 2. MEDIUM: the payer-name fraud signal is dropped on course orders, which are now the path that pays repeatedly
- `commission-source-facts.ts:97-99` (course branch) hardcodes `payerText: null, payerEmail: null`.
- `CourseTransferNotice` (`course-payment-webhooks.ts:16-23`) has no `payerText`, and neither `sepay.ts` (course branch) nor `reconcileSepay` passes the transfer content to `applyCourseSepayPayment`. Membership passes it (`billing.ts:369`, `billing.ts:445`).
- Scenario: a referrer creates a dummy account bound to their own link (different mailbox) and pays for its courses from their own bank account. They get the referee discount plus `R-d` commission on every course, which is effectively `R`% off everything. The transfer content showing the referrer's name, which flags this for memberships, is never checked.
- Fix: add `payerText` to `CourseTransferNotice`, store it or pass it through `onCourseOrderPaid`, and add `payerText` to the `course_order` `CommissionSource`. For Dodo, pass `customer.email` as `payerEmail`.

### 3. LOW-MEDIUM: a refund of a Dodo course payment that was flagged instead of paid is misrouted and lost
- `applyDodoCoursePayment` (`course-payment-webhooks.ts:155-157`) handles the underpaid and provider-mismatch cases with `markCourseOrderAttention`, which sets `payment_ref` but not `provider_payment_id`.
- `orderByPaymentId` (`:94-97`) looks up refunds and disputes only by `provider_payment_id`. So `refund.succeeded` for that payment returns null and falls through to the membership `applyDodoReversal`, which finds nothing.
- The order stays `needs_attention`. An admin could later `grant` it (`course-order-payments.ts:130-134`), giving access and a commission on money that was already refunded.
- Fix: set `provider_payment_id` in the attention path too, or look up by `provider_payment_id OR payment_ref`.

### 4. LOW: a won dispute restores access but not the commission
- `restoreCourseOrder` calls `fulfilCourseOrder` and then `recordReferralCommission`. That returns the existing `reversed` row, or `isSourceReversed` blocks it, so the referrer permanently loses the commission after `dispute.won` or `dispute.cancelled`.
- This matches membership behaviour, which does not handle `dispute.won` at all. Flagging it as a product decision.

### 5. LOW: `payment.succeeded` whose `metadata.user_id` doesn't match is silently "unmatched"
- `course-payment-webhooks.ts:115` sets `order=null`, records the event, and returns `unmatched`.
- Captured card money for a real order leaves no attention flag and no activity log. Better to mark the order `needs_attention` (`metadata_mismatch`).

### 6. LOW / informational
- Dodo commission base is `min(total_amount, amount_usd_cents)` (`commission-source-facts.ts:91`). If the course PWYW product is tax-inclusive, commission is paid on the tax portion. Membership subtracts `tax` (`dodo-billing.ts:434`). Store `tax` on the course order, or confirm the product is tax-exclusive.
- An abandoned Dodo course checkout (24h TTL, `course-orders.ts:28`) blocks the referral for any other checkout by an unbound referee for 24h. A typed code is then silently ignored with no 400 (`checkout.ts:75`, which returns before the entered-code error). The behaviour already existed but is now much easier to hit.
- `src/pages/api/v1/courses/jobs/github-invites.ts:7-10` reimplements `isCronCaller` instead of importing `lib/cron-auth`.
- The `COURSE_FILES` R2 binding is commented out in `wrangler.toml`, so R2 course media returns 503 until the bucket exists. This is a deploy checklist item.

## Verified OK (no defect found)
- **Migration 0018 tail:**
  - Column list, types, CHECKs, UNIQUE and the 3 indexes match `0016_referrals.sql` exactly.
  - No table has an FK to either rebuilt table (`referral_ledger.commission_id` is not an FK).
  - Safe with existing data and with FKs on, as replayed above.
  - Renaming `0016_courses` to `0018` leaves no name or column collisions with 0016/0017.
- **Dodo webhook order:**
  - The course handler claims refund and dispute events only when `course_orders.provider_payment_id` matches, so membership payment ids fall through.
  - It claims `payment.*` events only when `metadata.course_order` is present.
  - So a membership refund cannot hit a course order, and a course refund (with `provider_payment_id` set) cannot hit membership reversal.
  - Only one handler writes `payment_events` per webhook id.
- **Referral pricing:**
  - Subscriber vs referral discount takes the max (`course-pricing.ts:91-93`).
  - SePay commission base is `min(paid, amount_vnd)` at the snapshotted rate; Dodo base is capped at the price.
  - A commission failure is caught twice (`captureReferralCommission`, plus the try/catch in `fulfilCourseOrder`), so the payment path is unaffected.
  - Refund, chargeback and admin refund reverse the commission, or mark the source as reversed before any commission exists.
  - Recapture covers `course_order`.
  - `isEligibleReferee` now counts paid course orders. Account deletion records the paid-email hash through it.
- **Typed code:** `bindEnteredReferral` binds after the order insert. A bound account keeps its referrer, and a typed code fails only when nothing applies. Tests cover both.
- **Paid-lesson access:**
  - `lessonDenial` requires `member_session` or `studio_session` for non-trial lessons, so `zk_` keys and OAuth get `browser_only`.
  - MCP `course_lesson_get` goes through the same `lessonView`. `.md` renders as `anonymousPrincipal()` with trial lessons only.
  - The tutor uses `requireReadableLesson`. The search and AI indexes read only `article_editions`.
  - Quiz `correct` and `explanation` are stripped by `publicLessonDocument` and revealed only in the grade response.
  - Admin lesson views are behind `requireCan(admin)`.
- **Session cap:** keeps the new session plus the most recent other one. `user_activity(user_id, created_at)` is indexed. The flag threshold is fine.
- **Other merges:** the `env.d.ts` R2 types are a superset, and the KYC usage still type-checks. `StudioApp` swaps Workflows for Courses cleanly. The scheduler job route exists and uses `CRON_SECRET`.

## Unresolved questions
1. Does Dodo copy checkout-session `metadata` onto the `payment.succeeded` payload for one-time PWYW products? Course matching depends entirely on `metadata.course_order`. Tests use mocked payloads.
2. Is the course PWYW product in Dodo tax-inclusive or tax-exclusive? This affects finding 6.
3. Product intent: should a referee's first course purchase use up their membership referral discount? It does now, via `isEligibleReferee`.

Status: DONE_WITH_CONCERNS
Summary: Tests and typecheck pass, migration 0018 is safe on existing data, webhook routing and paid-lesson gating are correct. Two referral-abuse gaps on the "every course" path should be fixed before launch: no mailbox/paid-before check for bound accounts, and no payer-name signal.
Concerns: Findings 1 and 2 (referral abuse); finding 3 (a refund lost for flagged Dodo orders).
