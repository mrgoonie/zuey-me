# Review round 2: PR #252, GA4 destination

- PR head: `9aafed9` (`feat/64-ga4-destination`). Round 1 reviewed `1edd504`; the round 2 delta is commit `9aafed9` on top of `47cb899`. Closes #64.
- Reviewer: isolated agent; did not write this code. Date: 2026-10-23 (Asia/Saigon).
- Round 1 report: `plans/reports/review-pr-252.md`.

## Verdict

**Changes requested: one blocker.**

- **B1.** Account deletion fails with a 500 until migration 0031 is applied, because the new `DELETE` runs inside the atomic deletion batch.
- No majors remain. M1, M2 (code side), M3, m1, m3, m4, m5, m6 and n1 are fixed.
- M2 is closed in code. It still depends on an owner step, enhanced measurement off, which must happen **before** the merge, not after it. `PUBLIC_GA4_MEASUREMENT_ID` is already set as a repo variable, so merging switches gtag on immediately (Q3).

## Verification

| Check | Result |
|---|---|
| `bun install` | 742 packages OK |
| `bun test` | **1683 pass, 0 fail** (102 files) |
| `bun run build` | astro check: 0 errors, 0 warnings, 69 hints. Build: Complete |
| `git merge-tree` vs `origin/main` (`b13aa28`, #253) | Clean (exit 0) |
| Probe test, 16 cases. It ran from the scratchpad against the temporary worktree and was deleted afterwards. | 15 pass. **1 fails, by design: it shows B1.** |
| `gh variable list` (read only) | `PUBLIC_GA4_MEASUREMENT_ID=G-SS6M7YDZX0`, set 2026-10-23 |

## Findings

### Blocker

**B1. Before migration 0031 is applied, account deletion fails with a 500 and nothing is deleted.**
`src/lib/members/users.ts:256`, inside the `d1.batch([...])` at `:241`.
- The new `DELETE FROM analytics_ga4_clients WHERE user_id = ?` runs inside the single D1 batch that deletes the account. A D1 batch is one transaction, so the "no such table" error rolls back the whole batch.
- `DELETE /api/v1/me` (`src/pages/api/v1/me/index.ts:36`) then answers 500, and the member cannot delete their account.
- Probe evidence: run against a real SQLite DB with every migration applied and `analytics_ga4_clients` dropped.
  - `deleteAccount` rejected with `SQLiteError: no such table: analytics_ga4_clients`.
  - The user row stayed `{"email":"probe@example.com","deleted_at":null}`, and the session count stayed 1.
- Why it matters:
  - A merge to `main` deploys production at once, and `deploy.yml` does not apply D1 migrations.
  - The PR marks the migration "required before deploy". If the owner runs it after the merge, or forgets, every account deletion fails in the meantime.
  - Account deletion is a privacy right, so it must not depend on an analytics table existing.
- Fix:
  - Take the statement out of the batch.
  - Run it after the batch commits, as a best-effort step: `try { await d1.prepare('DELETE FROM analytics_ga4_clients WHERE user_id = ?').bind(user.id).run(); } catch (err) { console.warn(...) }`. This is the same pattern as `deferChannelAccessPush` at `:264`.
  - Add a test that drops the table and asserts that the deletion still succeeds.
  - A weaker alternative is to apply 0031 to production **before** the merge, which is safe because the migration is additive. That depends on a manual step, though, so the code fix is preferred.

### Minor

**m-a. The `_ga` ids outlive account deletion in `analytics_outbox` rows.**
`src/lib/analytics/commerce-events.ts:91,147` copies `ga_client_id`/`ga_session_id` into the outbox row's `properties`.
- `deleteAccount` does not touch `analytics_outbox`.
- `purgeSent` (`outbox.ts:318`) deletes `sent` rows only 30 days after delivery, and never deletes `pending` or `dead` rows.
- Probe: after `deleteAccount`, the purchase row still held `"ga_client_id":"1234567890.1700000000","ga_session_id":"1700000500"`.
- `/privacy` (vi `:137`, en `:275`) says the ids "are deleted with your account".
- The member id already lives in the outbox before this PR, so this is not a new kind of exposure, but the sentence is inaccurate.
- Fix, either:
  - qualify the sentence ("copies in the delivery queue are removed within 30 days after sending"); or
  - scrub `ga_*` from the member's outbox rows in `deleteAccount`, best effort.

**m-b. Retention of `analytics_ga4_clients` is enforced only by the next checkout.**
`src/lib/analytics/ga4-attribution.ts:65-80`.
- Expired rows are deleted only inside `rememberGa4Client`. With no checkout for weeks, ids older than 30 days stay in D1. `ga4OutboxProperties` refuses to use them (`:98-99`), but they are still stored.
- `/privacy` says they are stored "for up to 30 days".
- Fix: add the same `DELETE … WHERE updated_at < ?` to the outbox drain tail (which runs on the cron), best effort.

**m-c. A missing table is logged at `debug`, not `warn`.**
`ga4-attribution.ts:78` (`console.debug`). A missing table or a D1 failure on the checkout write is invisible at the default Workers log level. Use `console.warn`, as the task brief expects for a missing table.

### Nit

- **n-a.** `docs/analytics-events.md:200` and the PR owner step say "turn off Page views (or at least …)". In the GA4 UI, the Page views toggle under enhanced measurement cannot be disabled on its own; only "Page changes based on browser history events" can. The clearest instruction is to **turn off the Enhanced measurement master switch**. That disables every automatic event, including history-change page views. The code already sends its own `page_view`.
- **n-b.** `bootAnalytics` passes the member id cached in localStorage to the first `page_view`. If that member signed out in another tab, one `page_view` can carry a stale `user_id` before `syncIdentity` resets it. PostHog's persisted distinct id had the same behaviour before this PR. Acceptable.

## Round 1 findings: status

### M1: per-destination delivery. **Fixed.**

`src/lib/analytics/server.ts:142-155`, `destinations/types.ts` (`secondary`), `ga4.ts:310` (`secondary: true`).
- Delivery is decided by PostHog alone.
  - `delivered = primaryResults.every(r => r.ok)`.
  - Secondaries (GA4) run only after the primaries have succeeded. Their results never affect `delivered`.
  - The outbox settles from `result.delivered` (`outbox.ts:231`).
- GA4 is sent once.
  - A failed PostHog attempt returns before the secondaries run.
  - After a success the row is `sent` and never reclaimed.
- Probe: PostHog 503 combined with each GA4 outcome (204, 500, 400, network throw, hang until timeout), for both `purchase` and `refund`. That is 10 cases, all passing:
  - First drain: `{sent:0, retried:1, dead:0}`, fetch calls `['posthog']` (GA4 not called), row `pending`.
  - Second drain, PostHog 200: `{sent:1}`, calls `['posthog','posthog','ga4']`, row `sent`.
  - Third drain: no new calls.
- Probe: with PostHog 503 on every attempt, the row was dead-lettered on PostHog alone after 10 attempts, and GA4 was never called.
- Trade-off, now documented: when GA4 fails after PostHog accepted, the GA4 copy is lost and never retried. This is acceptable for a best-effort secondary.

### m1: PostHog misconfigured. **Fixed.**

- `serverDestinations` returns `[]` when the PostHog config is null (`server.ts:75-80`), so the drain is `skipped` and rows stay pending.
- `drain.ts:34` reports `skipped_reason: 'analytics_disabled'` on production hosts, so the alarm still fires.
- Probe: a bad key plus the GA4 secret gave `{status:'skipped', pending:1}`.

### M2: URL handling and privacy text. **Fixed in code; owner step still required (see Q3).**

- `ga4PageFields` → `dropSearchParams(scrubUrl(...))` (`ga4.ts:95-115`) removes `q`, `s`, `search`, `query`, `keyword(s)`, `term`, `search_term` and `searchterm` (case-insensitive) from `page_location` and `page_referrer`. An unparsable URL loses its whole query string.
- `config` has `send_page_view: false`. The order is: `set` scrubbed fields, optional `set user_id`, `config`, then `event page_view` with the scrubbed fields (`ga4.ts:~183-196`). Covered by tests.
- `/privacy`, vi `:137` and en `:275`:
  - Now accurate on: search words removed, Google as processor ("possibly in the US"), the `_ga` id storage and its 30-day limit, and server events sent even under DNT/GPC (m6 is fixed).
  - Two caveats remain. "Auto-collected events are turned off" is true only once the owner has done step 2. "Deleted with your account" is inaccurate (B1 and m-a).
  - The processor rows (`:172`, `:310`) mention the stored `_ga` ids.

### M3: `_ga` client and session ids. **Fixed, apart from B1, m-a and m-b.**

- **Capture conditions.** Capture happens only when GA4 is configured and the request has neither `DNT: 1` nor `Sec-GPC: 1` (`ga4-attribution.ts:58-66`), and only when a valid `_ga` cookie exists.
  - The site opt-out cannot be seen by the server.
  - It is covered by `bootAnalytics`, which deletes `_ga*` on every page load without consent (`client.ts:388-396`), and by the opt-out path itself.
- **Storage.**
  - It is the `analytics_ga4_clients` table (migration 0031), one row per member, upserted.
  - The 30-day window is enforced on read (`:98-99`) and purged on write (`:80`; see m-b).
  - Deletion with the account: **verified by probe.** With two members' rows present, `deleteAccount` left only the other member's row. This holds only when the table exists (B1).
- **Not copied into PostHog.** `GA4_ONLY_PROPERTIES` is stripped in the PostHog server adapter (`posthog.ts:296-318`). The existing test asserts that no PostHog body contains the id.
- **24-hour rule.**
  - `ga_session_id` is added only when `withSession` holds (purchase, not a renewal) and the stored row is 24 hours old or less (`:100`).
  - Refunds never carry the session.
  - In the MP payload, `session_id` is set only from `ga_session_id` and must match `^\d{1,20}$` (`ga4.ts:~294`). `client_id` falls back to the hash.
- **Guests are skipped.**

### Other round 1 items

| Item | Status | Evidence |
|---|---|---|
| m3 | Fixed | `client.ts:400-406` passes the cached member id; `ga4.ts` `start` sets `user_id` before `config` and `page_view`. |
| m4 | Fixed | GA4 `start` records `userId = memberId`, so the `distinctId()` guard matches and `identify` is not re-run. Test: "client identity with GA4 started for a known member". |
| m5 | Fixed | `measurementProtocolPayload` returns null for a refund without `transaction_id` (`ga4.ts:~279-280`). The send returns `invalid`, which is secondary, so the PostHog copy is still delivered. |
| m6 | Fixed | See M2. |
| n1 | Fixed | `deleteGaCookies` on boot without consent, wrapped in try/catch. |

## New questions

### Q1. Deploy-order hazard for migration 0031

| Path | Without the table | Evidence |
|---|---|---|
| `POST /api/v1/billing/orders`, `POST /api/v1/courses/{course}/checkout` | **Safe.** `rememberGa4Client` runs after the checkout is created, inside a catch-all. The checkout still returns 201. | Probe: no throw; it logged `analytics: could not store GA4 client ids no such table` (at debug level, m-c). |
| Webhooks: `queuePurchase` / `queueRefund` | **Safe.** `ga4OutboxProperties` catches and returns `{}`. | Probe: `queuePurchase` → `"queued"`; 2 rows queued. |
| Outbox drain | **Safe.** The drain never reads the table; ids are already in the row. | Probe: `{sent:2, dead:0}`. |
| Account deletion (`deleteAccount`) | **Fails (500), nothing deleted.** | Probe, see **B1**. |

Checkout never fails because of analytics. Account deletion does, and that is the blocker.

### Q2. Is the migration additive, and is 0031 free?

- **Additive only.** It contains `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`. It has no ALTER, DROP or data change, and it is safe to apply before the merge, because old code ignores the table.
- **0031 is free.**
  - `origin/main` (`b13aa28`) ends at `0030_lab200_catalogs.sql`.
  - Among open PRs, only #235 adds a migration (`0029_drop_channel_link_tables.sql`).
  - #252 is the only one with 0031.
  - The out-of-order 0029 from #235 is #235's concern, not this PR's.

### Q3. Enhanced measurement and rollout

- **What `send_page_view: false` covers.** It suppresses only the `page_view` that `config` would send automatically.
- **Enhanced measurement is configured per stream.** gtag.js reads the settings at load and attaches its own listeners: outbound `click` with `link_url`, `scroll`, `view_search_results`, `form_start`/`form_submit`, `file_download`, `video_*` and history-change `page_view`. These fire regardless of `send_page_view` ([Enhanced measurement events](https://support.google.com/analytics/answer/9216061)).
- **Consequence.**
  - With the stream's defaults on, the first deploy sends outbound `link_url` values to Google. That includes `chatgpt.com/?q=<prompt>`, `claude.ai/new?q=…` and `gemini…?q=…` from `ArticleActionBar.tsx`.
  - It possibly also sends site-search `search_term`, read from the real URL.
  - That contradicts the new `/privacy` sentence that these events "are turned off".
  - The repo variable is **already set**, so merging is enough to trigger it.

Recommended safe rollout:

1. **Before merging, the owner checks the stream settings.** In GA4 Admin → Data streams → zuey.me web stream, turn **Enhanced measurement off** (master switch).
   - If the owner cannot confirm this before the merge, **delete or blank the `PUBLIC_GA4_MEASUREMENT_ID` repository variable first.**
   - The variable is inlined at build time; when it is empty, `resolveGa4MeasurementId` returns null, so no gtag loads and no `_ga` capture happens. The server MP path also needs the id, so it stays off too.
2. **Apply migration 0031 to production D1 before merging**, even after B1 is fixed, so attribution works from the first checkout.
   - Record `wrangler d1 time-travel info zuey_me_db` first, with the `.env` account credentials exported.
3. **Merge.** With the variable unset, this is a no-op for GA4.
4. **Set the variable** (or re-run the deploy if it was never removed).
   - Verify in DebugView:
     - `/articles?q=test` → a single `page_view` with no `q`;
     - an outbound or share-to-AI click → no `click` event;
     - no `scroll`, `view_search_results` or `form_*` events.
   - Only then is the `/privacy` text true.
5. **Set the optional `GA4_API_SECRET`** last.

### Q4. Regressions in PostHog delivery or existing analytics tests

None found.
- PostHog stays the sole decider of retry and dead-lettering. Server events only lose the `ga_*` keys, which never existed before this PR.
- Changes to existing tests (`analytics-outbox`, `booking`, `referrals-commissions`) only **add** `transaction_id` expectations; no assertion was weakened.
- The full suite passes: 1683 pass, 0 fail.
- Behaviour change, intended: a primary-less event now returns `delivered:false` instead of `true`. That case is reachable only through tests, because `serverDestinations` never returns GA4 without PostHog.
- The drain row limit still divides by the destination count (20 rows/run with GA4). Round 1 m2 is unchanged and acceptable.

## Unresolved questions

1. Will the owner turn off enhanced measurement before the merge, or should `PUBLIC_GA4_MEASUREMENT_ID` be removed until they confirm it (Q3)?
2. For m-a, is qualifying the `/privacy` sentence enough, or should `deleteAccount` scrub `ga_*` from outbox rows?

Status: DONE
Summary: Changes requested; one blocker. B1: `deleteAccount` fails with a 500 (nothing deleted) until migration 0031 exists, because the new DELETE is inside the atomic batch. Checkout, webhooks and the drain are best-effort and safe. Round 1 M1 (probed: PostHog 503 with every GA4 outcome), M2 code, M3, m1, m3-m6 and n1 are fixed; no regressions (1683 pass, build clean). Rollout: enhanced measurement off, or blank the already-set `PUBLIC_GA4_MEASUREMENT_ID` variable, plus migration 0031 applied, both before the merge.
