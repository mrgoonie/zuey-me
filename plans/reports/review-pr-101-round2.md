# Code review round 2: PR #101, server-side analytics outbox (issue #62)

- Head reviewed: `b8ec922f8591c3ebd1795e14aaa4bb229195a8b3` (branch `claude/analytics-outbox`, rebased on main after #98)
- Reviewer context: isolated, did not write this code
- Previous round: `review-pr-101.md` (REQUEST_CHANGES on `8ace296`)

## Verdict: APPROVE

Every High and Medium finding from round 1 is fixed. All Low findings except L5 (tracked in #100) are fixed too. Nothing left in the diff blocks the merge. One new Low gap (booking admin resolve) can be filed as a follow-up.

## Gates (run locally in worktree `D:\www\zuey\rv101b`)

- `git merge-tree --write-tree origin/main HEAD`: clean, exit 0 (tree `57cd2cc`)
- `bun install --frozen-lockfile`: ok
- `bun test`: **874 pass, 0 fail** (47 files)
- `bun run build`: **astro check 687 files: 0 errors, 0 warnings** (63 pre-existing hints), and the build completed

## Round-1 findings: status

| # | Finding | Status | Evidence |
|---|---|---|---|
| H1 | Privacy page promised analytics opt-out covered everything | Fixed | `src/pages/privacy.astro:139-140,275-276` (VI+EN): browser opt-out wording is now scoped to the browser. A new paragraph discloses server account and purchase events, that they ignore the toggle/DNT/GPC, member id only, no email/phone/token, no location, guest ids without a profile. The processors table (`:178,:314`) lists plan, amount, currency and provider. `docs/analytics-events.md` adds the same, plus the production verification note. Matches the code: `SERVER_EVENT_FLAGS` `$geoip_disable: true`, `GUEST_EVENT_FLAGS` `$process_person_profile: false` (`destinations/posthog.ts:213-215,232`). |
| H2 | Course `dispute.opened` reported as a final chargeback | Fixed | `reverseCourseOrder` queues only for `refunded` (`course-order-payments.ts:~148`). `DISPUTE_MONEY_LOST` (`course-payment-webhooks.ts:96,152`) queues the chargeback on lost/accepted/expired, keyed once per order. `restoreCourseOrder` passes `countPurchase: false`. Test: `courses-commerce.test.ts:149`. |
| M1 | Flagged Dodo charge never produced `purchase` | Fixed | `queueCharge(true)` in both flagged branches, keyed by `paymentId`, `flagged: true` (`dodo-billing.ts:~482-490,505,533`). Taxonomy and docs updated. Test `analytics-outbox.test.ts:296`. |
| M2 | Dead letters and silent skips looked like success | Fixed | `workers/scheduler/src/analytics-drain-check.ts` returns `fail` when every claimed row failed or `analytics_disabled` with a backlog, and `warn` on dead > 0, on non-production skips or on an unreadable body. Registered via `scheduledJobs()` with `check` (`jobs.ts:103`). Tests `analytics-outbox.test.ts:544,555`. |
| M3 | Unbounded D1 queries per run | Fixed | The sweep is one `INSERT … SELECT … ON CONFLICT DO NOTHING` (`outbox.ts:~283`). Settles are grouped into one UPDATE per (outcome, error, next_attempt). `MAX_DRAIN_QUERIES = 20` uses a worst-case pre-check per batch. The default limit is 30 and the maximum 40, under 50 subrequests. Test `:425`. |
| M4 | No retention, compaction scanned every row | Fixed | Sent rows are purged after 30 days (500 per run), and the `(status, sent_at)` index is in 0022. Compaction was removed. Test `:461`. |
| L1/L2 | GeoIP overwrite, guest person profiles | Fixed | See H1 evidence. |
| L3 | Conflict with #98 | Fixed | Rebased; merge-tree clean. |
| L4 | Docs contradiction and typo | Fixed | Docs say "separate statement after"; the typo is gone. |
| L5 | Renewal refunds and second partial refunds | Open, known | Documented, tracked in #100. |
| L6 | "Exactly once" wording | Fixed | Docs and the code comment say at-least-once with an idempotent uuid. |

## New findings

### Low

**N1. A booking confirmed by admin `resolve` emits no `purchase`.** `src/lib/booking/store.ts:985` (`adminUpdateBooking` resolve branch).
- A booking flagged `needs_attention` (underpaid, late transfer) has money collected. Its `payment_needs_attention` event is queued at `:667`, but when the admin resolves it nothing queues `purchase`. Membership (`fulfilOrder`) and courses (`fulfilCourseOrder`) do emit on resolve, so booking revenue is slightly undercounted.
- Suggest a follow-up issue: queue `purchase` on resolve, keyed by `payment_ref` (same key as the webhook path), with `amount_paid`. Not a blocker.

**N2. The drain check can fail a cron run on a single transient failure.** `workers/scheduler/src/analytics-drain-check.ts:47`.
- `claimed > 0 && sent === 0` fails the run even when only one row was claimed and it timed out once. That is acceptable (it pages on a real outage quickly), but it may be noisy at low volume.
- Optional: require `claimed >= 2` or `retried > 0 && pending > N`. Not a blocker.

### Info

- **Migration 0022 is additive and safe.** It only has `CREATE TABLE IF NOT EXISTS` plus three `CREATE INDEX IF NOT EXISTS`, and touches no existing table. It sorts before the already-applied `0023_job_cursors.sql`, which is harmless because migrations are applied by file with `wrangler d1 execute`.
- **Required order: apply 0022 remotely (restore point first) BEFORE merging.**
  - If code ships first, payments, webhooks and sign-ins keep working, because enqueue catches the error, logs `analytics outbox: could not queue …` and returns `failed`.
  - However, the events from that window are **lost**, not deferred. The exception is `subscription_expired`, which the sweep back-fills for 3 days.
  - The drain answers 500, which the scheduler reports as a failed job. That failure is noisy but harmless.
  - `docs/env-setup.vi.md` already states "phải chạy trên D1 remote trước khi deploy".
- **Retention vs dedupe.** Purging sent rows after 30 days drops their dedupe keys. I checked every emitter. Each one only enqueues on a guarded state transition (`changes === 1`, a status move, a session creation, a recompute delta), and a won dispute uses `countPurchase: false`. So a key that has been purged cannot be re-queued by normal replays.

## Verified OK

- **Idempotency and claiming.**
  - The unique `dedupe_key` uses `ON CONFLICT DO NOTHING`.
  - The claim is one atomic `UPDATE … WHERE id IN (SELECT … LIMIT) RETURNING`.
  - Settles check `lease_token`, and the 2-minute lease is longer than the 20 s budget.
  - Rows from a crashed delivery stay leased and are reclaimed later.
  - Backoff is 5 min doubling up to a 6 h cap, and a row goes dead on the 10th attempt or at once on 400/413/422. 401/403/404 are retried.
- **The sweep UUID** built in SQL is a valid v4 (version nibble `4`, variant from `89ab`). Its key equals `subscriptionExpiredKey`, so a recompute and the sweep never double-report. Its properties are re-validated at send time.
- **PII.**
  - `distinct_id` is `users.id`, or `guest_` plus a SHA-256 prefix.
  - Reasons are fixed codes such as `promo_discount_not_applied`.
  - `last_error` holds only destination, reason and status.
  - Logs carry the event name and the error message only.
  - No email, phone, token, order code or bank memo is stored or sent. A test asserts this.
- **Auth.** `isCronCaller` (`CRON_SECRET`) or `requireAdminActor`. `GET` returns 405, `limit` is validated, and errors use the `http.ts` envelope.
- **OpenAPI.** The fragment is registered in `src/lib/openapi/registry.ts`. The schema matches `DrainResult` plus `skipped_reason`, and the limits come from constants.
- **Preview gate.** `isServerCaptureHost` uses the production hostname allowlist. A `*.pages.dev` drain is `skipped` and its rows stay queued (test `:485`).
- **Edge runtime.** Only web standards are used (`crypto.subtle`, `crypto.randomUUID`, `fetch`). There is no `any` and no unchecked member-access cast (the drain check uses `in` guards and `Reflect.get`).
