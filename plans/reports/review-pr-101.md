# Code review: PR #101, server-side analytics outbox (issue #62)

- Head reviewed: `8ace296aa78e04d335ae11939af7701dd0e5c9e6` (branch `claude/analytics-outbox`, base `main` @ `2a68729`)
- Reviewer context: isolated, did not write this code
- Date: 2026-10-11

## Verdict: REQUEST_CHANGES

The payment-safety design holds up. Enqueue never throws, the insert runs as its own statement after the state change, there is a unique `dedupe_key` per business fact, the row uuid is reused on retries, there is a lease with reclaim, backoff and a dead letter, and production delivery is gated by hostname. Two problems block the merge. First, the public privacy promise becomes false. Second, a course dispute that is only *opened* is reported as a refund for good.

## Review limits (read first)

- **Gates not run locally.** In this session the Bash tool did not execute any command. Every call returned no output and exit 0, including `exit 3` and `git --version`. So I could not create a worktree, run `bun test` or `bun run build`, run the local D1 end-to-end drain, or post the PR comment with `gh`.
- I used other evidence instead:
  - I read the code from the author's existing worktree `D:\www\zuey\zuey-me\.claude\worktrees\agent-a027b35ba4579fbce`. Its HEAD is `8ace296` according to the reflog, and that SHA matches the PR head from the GitHub API. I could not check that worktree for uncommitted changes.
  - I took the file list and the main-branch state from the GitHub API.
  - CI check "Test & Build" on `8ace296` is **success** (https://github.com/mrgoonie/zuey-me/actions/runs/38136645058/job/114461767834). I could not confirm that CI enforces 0 astro-check warnings.
- The comment for PR #101 is not posted yet. The text is at the end of this file for the lead to post.

## Findings by severity

### High

**H1. The privacy page and docs promise that analytics can be turned off, but server events ignore that choice.** Files: `src/pages/privacy.astro:256` (EN, and the VI equivalent around line 127-135), `:293`, `docs/analytics-events.md:49,132`.
- The privacy page says: "Analytics does not run when your browser sends Do Not Track or Global Privacy Control, or when you turn it off here." It also lists the PostHog data as "Page views, interaction events, … member id".
- This PR sends `sign_up`, `login`, `purchase` (amount, currency, plan), `refund`, `payment_failed` and the subscription lifecycle events to PostHog. They are keyed by the member id and sent from the server whatever the member's DNT, GPC or opt-out setting is. The browser has already linked that member id to the member's browsing through `identify()`.
- `privacy.astro` is not in the PR's file list.
- This is a product or compliance decision. The options are:
  - (a) Update the VI and EN privacy copy and the docs to disclose server-side business events, and that the browser toggle does not cover them.
  - (b) Store a member-level analytics opt-out and skip enqueueing for opted-out members.
  - (c) Send revenue events without a person-linked `distinct_id`, for example aggregate or anonymous ids.
- At minimum, (a) is needed before this ships.

**H2. A course `dispute.opened` is reported as a final chargeback, and winning the dispute never undoes it.** Files: `src/lib/courses/course-payment-webhooks.ts:94,146-147` → `src/lib/courses/course-order-payments.ts:144-152`; `fulfilCourseOrder` comment at `:78-79`.
- `DISPUTE_REVOKE` includes `dispute.opened`. `reverseCourseOrder(…, 'charged_back')` then queues `refund` with `reason: 'chargeback'` and the full amount.
- When the dispute is won, `restoreCourseOrder` → `fulfilCourseOrder` reuses the dedupe key `purchase:<provider>:course_order:<id>`, which is already used, so it queues nothing. PostHog ends up showing permanent negative revenue for money that was kept.
- This is inconsistent with the PR's own rule for membership (`dodo-billing.ts:581`) and bookings (`booking/store.ts:750`): "An opened dispute may still be won; only money that actually went back is a refund". It also contradicts `docs/analytics-events.md:96` ("refund or lost chargeback").
- Fix: in `reverseCourseOrder`, skip `queueRefund` when the trigger is `dispute.opened`, or pass a flag from the webhook. Queue the refund on `dispute.lost`, `dispute.accepted` or `dispute.expired`; their key `course_order:<id>:charged_back` is still unused. Add a test for opened → won.

### Medium

**M1. A Dodo charge that was collected but flagged never produces a `purchase`.** File: `src/lib/payments/dodo-billing.ts:489-497` and `:511-523`.
- `payment.succeeded` with `amount_mismatch`, or with a discount that was not applied, returns before `queuePurchase` (`:525-530`). The money was taken, and in the discount case the commission and promo were already captured.
- No admin-resolve path for cards emits the purchase later. SePay does emit it: admin resolve → `fulfilOrder` → `queuePurchase`.
- Result: card revenue is undercounted, and the docs (`analytics-events.md:95`, "Dodo charge (first or renewal)") overstate the coverage.
- Fix: queue `purchase` for every verified `payment.succeeded` with a `user_id`, keyed by `paymentId`, either way. Or document the exclusion and emit the purchase when the card is resolved.

**M2. Dead letters and silent skips do not reach the scheduler as failures.** Files: `workers/scheduler/src/index.ts:32-34`, `src/pages/api/v1/analytics/outbox/drain.ts:34-35`.
- The scheduler treats a job as failed only on non-2xx or `"status":"error"`. The drain never returns `error`.
- So a run with `dead > 0`, a run where every claimed row was `retried` (PostHog down or a rotated key, both 401/403), or `skipped_reason: "analytics_disabled"` on zuey.me (missing key in production) all log as success. Rows can pile up or dead-letter without anyone noticing.
- Fix: make the drain return a signal the scheduler already understands when `dead > 0`, when every claimed row failed, or when production is skipped as `analytics_disabled`. Alternatively, have the scheduler parse `dead` and `skipped_reason`.

**M3. The per-invocation D1 query budget is not bounded, and the sweep runs outside the time budget.** File: `src/lib/analytics/outbox.ts:254-279` (sweep) and `:301-334` (drain).
- `sweepExpiredSubscriptions` runs one SELECT and then up to `SWEEP_LIMIT = 500` separate INSERTs, one by one, before the delivery loop.
- With the default `limit` of 100, a single invocation can reach about 612 D1 queries (500 inserts + 10 claims + 100 settles + compaction), plus 100 PostHog fetches.
- That fits the 1,000 D1-queries-per-invocation limit on Workers Paid only by a margin. On the Free plan (50) it would fail as soon as volume picks up. Which plan this project uses is unconfirmed.
- Fix: run the sweep as a single `INSERT … SELECT … ON CONFLICT DO NOTHING`, or lower `SWEEP_LIMIT` a lot. Group each batch's `settle` updates with `d1.batch`.

**M4. Outbox rows are kept forever, and the compaction query scans every sent row on every tick.** Files: `src/lib/analytics/outbox.ts:42,287-294`, `migrations/0022_analytics_outbox.sql:27`, `src/lib/analytics/commerce-events.ts:224`.
- Rows are never deleted. `login` adds one row per session, and its key, `login:<session_id>`, can never repeat, so keeping it has no value.
- `compactSent` filters on `status='sent' AND sent_at < ? AND properties <> '{}'`. The only usable index is `(status, next_attempt_at)`, so every 5-minute tick reads all sent rows. D1 rows-read cost grows in step with total history.
- Fix: delete `login` and `sign_up` rows, and possibly `dead` rows, after the retention window. Add `CREATE INDEX … ON analytics_outbox(status, sent_at)`. That index should go in this new migration, since 0022 is not applied yet.

### Low

- **L1. Server events can overwrite member GeoIP.** File: `src/lib/analytics/destinations/posthog.ts:217-223`. The server capture sends no `$ip` or `$geoip_disable`, so PostHog geolocates the Cloudflare egress IP. Those values can overwrite the identified member's person `$geoip_*` properties that came from the browser. Add `$geoip_disable: true`, or `$ip: null`, to server events.
- **L2. Every booking creates a new person profile.** Booking guests get one `guest_<hash>` per booking, and server events create a person profile by default. Consider `$process_person_profile: false` for `guest_` ids.
- **L3. Merge conflict with PR #98.** Both PRs add `workers/scheduler/src/jobs.ts` (add/add conflict) and edit `workers/scheduler/src/index.ts`. Whichever merges second has to rebase and keep both jobs. The migration numbers do not collide: 0022 here, 0023 there.
- **L4. The docs contradict themselves on transactions.** `docs/analytics-events.md:89` says events are written "inside the verified state transition", while `:112` correctly says the insert is "a separate statement after". There is also a typo at `:114`: "a payload the taxonomy no longer accepts it".
- **L5. Some course refunds are dropped.** A second partial Dodo refund on a course order produces no event, because `reverseCourseOrder` only changes rows that are `paid` or `needs_attention`. The same happens for refunds of renewal charges, which is already tracked in #100.
- **L6. Delivery dedupe is eventual.** PostHog removes duplicate events by `uuid` only eventually, through ClickHouse merges. A delivery that was retried after a timeout, where PostHog had in fact accepted the first send, can briefly show twice. Delivery is at-least-once with eventual dedupe, not strict exactly-once. The docs should say "exactly once per business fact in the outbox".

## Verified OK (risk calibration)

- **Payment safety.** `enqueueServerEvent` catches every error (`outbox.ts:80-106`), and every `queue*` helper goes through it. The insert is never inside a D1 batch with the payment write. The test `still pays and grants access when the outbox cannot be written` drops the table and confirms the payment still goes through. On the Dodo, booking and course webhook paths the enqueue sits inside the `try` that releases the idempotency record, but it cannot throw, so the release cannot be triggered by analytics.
- **Idempotency.**
  - Purchase keys: billing and course order ids (one payment per order), the Dodo `paymentId` (each renewal charge has its own), and the booking transaction (the `changes === 1` guard means one purchase).
  - Lifecycle keys include the resulting `period_end`.
  - The sweep and the recompute share `subscriptionExpiredKey`.
  - Tests cover a webhook replayed several times plus reconcile, and redelivery under a different webhook id.
- **Retry and dead letter.** Backoff is 5→320 min, then 6 h twice; a row goes dead on the 10th failure, about 22.6 h, which matches the docs and OpenAPI. 400/413/422 dead-letter at once; 401/403 are retried. The lease token is checked in `settle`, so a run whose lease lapsed cannot overwrite a newer claim. The claim is one atomic `UPDATE … WHERE id IN (SELECT … LIMIT) RETURNING`.
- **Budget.** Rows go out in batches of 10 concurrent sends with a 2.5 s timeout each. The 20 s budget is checked between batches, so a run takes about 22.5 s at worst.
- **PII.**
  - Taxonomy validation and the PII guard run both at enqueue time and at send time.
  - `distinct_id` is `users.id`, or `guest_` plus 24 hex characters of SHA-256 of the booking id.
  - `last_error` holds only destination, reason and status, never a message or secret.
  - The session id used in the `login` dedupe key is the row id, not the token, which is stored hashed (`session.ts:96`).
  - Tests assert that no email or order code appears in any row.
- **Auth.** The drain endpoint uses `isCronCaller` (constant-time Bearer `CRON_SECRET`) or `requireAdminActor`, the same pattern as the other cron jobs. `GET` returns 405, and `limit` is validated.
- **Migration.** New file `0022`, with `CREATE TABLE/INDEX IF NOT EXISTS`. It does not touch existing migrations and is safe on a live DB. The PR's deploy order (restore point → migrate → merge) is correct. If the code were deployed first, enqueue would degrade safely and the drain would answer 500.
- **Preview gate.** Delivery only happens for the `zuey.me` and `www.zuey.me` hosts in a production build. On `*.pages.dev` the drain returns `skipped` and the rows stay pending; a test covers this.
- **OpenAPI.** The fragment is registered, and the response schema matches `DrainResult` plus `skipped_reason`.
- **TypeScript.** No `any` and no unchecked member-access casts in the new source. Tests use the repo's existing `as unknown as APIContext` pattern.

## Edge cases checked

- Concurrent recomputes that write the same end share one key, so the second is a duplicate.
- Revocation caps `current_period_end` at now and queues `subscription_expired`; the sweep then finds the same key and skips it.
- A card renewal grace toggle (24 h) is below the 7-day renewal threshold, so it emits no `renewed` event.
- Purchasing again after natural expiry gives `wasActive = false` and emits `activated`.
- A drain crash in the middle of a batch: the lease lapses after 2 minutes, the rows are reclaimed, and attempts count up.

## Recommended actions

1. **H1:** decide on the privacy disclosure or a member-level opt-out, then update `privacy.astro` (VI and EN) and the docs.
2. **H2:** do not queue `refund` on course `dispute.opened`, and add a test for opened → won.
3. **M1:** queue `purchase` for every verified Dodo charge, or document the exclusion.
4. **M2:** surface `dead`, all-failed runs and production `analytics_disabled` skips to the scheduler as errors.
5. **M3 and M4:** turn the sweep into one set-based insert, batch the settles, add the `(status, sent_at)` index and a retention purge.
6. Re-run `bun test` and `bun run build` locally, plus a local D1 drain end to end with a stubbed destination. This session could not run them.

## Unresolved questions

- Is the Pages project on Workers Paid? M3 depends on the 1,000 versus 50 D1 queries per invocation limit.
- Product decision for H1: disclose, honour the opt-out on the server, or anonymise revenue events?

---

## PR comment text (to post with `gh pr comment 101 --repo mrgoonie/zuey-me`)

```
Isolated review of 8ace296: REQUEST_CHANGES

Payment safety, dedupe keys, lease/backoff/dead-letter, preview gate and drain auth all check out. CI "Test & Build" is green. I could not run local gates in my session: the shell tool did not execute anything.

High
1. src/pages/privacy.astro:256 (+ the VI copy) and docs/analytics-events.md:49,132 still promise "Analytics does not run when your browser sends DNT/GPC or when you turn it off here". This PR sends sign_up/login/purchase/refund/subscription events to PostHog keyed by member id whatever that choice is. Either disclose the server events (VI+EN), honour a member-level opt-out, or anonymise them.
2. src/lib/courses/course-payment-webhooks.ts:94,146 → course-order-payments.ts:144-152: course `dispute.opened` queues a `refund` (chargeback, full amount). A won dispute then re-uses the used purchase key and queues nothing, so the revenue loss stays for good. Membership and bookings skip opened disputes; courses should do the same (refund only on lost/accepted/expired).

Medium
3. src/lib/payments/dodo-billing.ts:489-497,511-523: a Dodo charge that was collected but flagged (amount_mismatch, discount not applied) never emits `purchase`, and card resolve does not emit it later either.
4. workers/scheduler/src/index.ts:32-34 / drain.ts:34: dead>0, all-retried runs and `analytics_disabled` on zuey.me all count as success, so outages and dead letters go unnoticed.
5. src/lib/analytics/outbox.ts:254-279: the sweep runs up to 500 single INSERTs outside the time budget, so one run can reach ~612 D1 queries (limit 1000 Paid / 50 Free). Use one INSERT…SELECT and batch the settles.
6. outbox.ts:287-294 + migration:27: rows are never deleted (login = 1 row per session), and compaction scans every sent row on every tick with no (status, sent_at) index.

Low
- posthog.ts:217-223: server events carry no $geoip_disable/$ip, so the Cloudflare egress geo can overwrite member person props.
- guest_ ids create one person per booking; consider $process_person_profile:false.
- workers/scheduler/src/jobs.ts: add/add conflict with #98.
- docs/analytics-events.md:89 contradicts :112 (inside vs after the state change); typo at :114.
- Delivery is at-least-once with eventual uuid dedupe in PostHog; "exactly once" applies to the outbox, not to delivery.
```
