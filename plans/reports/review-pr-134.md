## Review: PR #134, client funnel events and session attribution (closes #63)

Head `1ea8e50`, reviewed with the latest `origin/main` (`ad23784`) merged in locally.

**Verdict: REQUEST_CHANGES.** There is one Medium PII gap in the UTM allowlist, and the fix is small. Everything else is sound.

### Gates
- **Merge with main:** it conflicts in `tests/analytics-outbox.test.ts`. Only the import lines clash: `identityApi` against `minimumChargeCents`/`AppError`. Keeping both resolves it, but the branch needs a rebase.
- **`bun test` (merged):** 971 pass, 0 fail (54 files).
- **`bun run build` (merged):** 0 errors, 0 warnings, 65 hints.
- **New tests against `origin/main`:**
  - `tests/analytics-funnel.test.ts` fails, because its modules are missing on main.
  - `tests/analytics-funnel-dom.test.ts` fails 10 of 10.
- **Outbox join test:** it is real. It calls the actual identity endpoint, checks that `member_id` equals `users.id`, then pays the order through the SePay webhook. It asserts that the outbox `purchase` and `subscription_activated` rows have the same `distinct_id`.
- **Browser smoke** (dev server on :4453, stopped afterwards):
  - `/pricing` and `/business` hydrate with no JS errors.
  - The only failures were API 500s from the empty local D1 in the fresh worktree (`no such table: referral_settings`). They are environmental.
  - No PostHog requests were made on localhost.

### Findings

**Medium**

1. **The UTM allowlist accepts phone numbers and personal names** (`src/lib/analytics/attribution.ts:309-315`).
   - `UTM_VALUE_RE` allows any run of digits and any letters with spaces, and `containsPii` only checks for email, JWT and secrets.
   - I probed `parseAttribution('?utm_content=0912345678&utm_term=Nguyen%20Van%20A&utm_source=84912345678', …)`. It keeps all three values, and they are sent as `session_utm_*` on every event in the session. The `before_send` scrubber has no phone rule, so nothing strips them later.
   - This contradicts the PR body ("an email, URL, token or free text is dropped"). It also contradicts the PR's own PII rule in `tests/analytics-funnel-dom.test.ts:337-338`, which forbids long digit runs. That test only passes because its fixture UTMs are benign.
   - SMS and CRM tools do put subscriber phones or ids into `utm_content`.
   - Fix: reject values that contain a run of 8 or more digits, using the same `/\d[\d\s.-]{8,}\d/` rule. Add a test for it. Correct the "free text" claim in the PR body and in `docs/analytics-events.md`: `utm_term` is free text by design.

**Low**

2. **`logout` from Studio is never sent** (`src/components/studio/StudioApp.tsx:135`).
   - `/studio` (`src/pages/studio/index.astro`) does not use `Layout.astro`, so `bootAnalytics()` never runs there. The client stays undecided.
   - As a result, `signOutAnalytics('studio')` only adds `logout` to the in-memory queue and then resets. The reset still works, so there is no regression.
   - The `surface: 'studio'` value and the docs row for it describe an event that cannot fire. Either boot analytics on Studio or drop the `studio` surface from the docs.
   - On pages without the layout, the queue is never cleared by `settle()`. It is capped at 50, so this is harmless.
3. **The referrer self-check uses the exact hostname** (`attribution.ts:324`).
   - Moving between `www.zuey.me` and `zuey.me` records the site's own other host as the external `session_referrer`.
   - Fix: compare against `PRODUCTION_HOSTNAMES` (`constants.ts:5`).
4. **Queued events are flushed before identity sync** (`client.ts:147-155`, then `syncIdentity` at `client.ts:388`).
   - Events queued on the first page after sign-in go out under the anonymous id. PostHog merges that id at `identify()`, so the funnel still joins.
   - Informational only.

### Checked and OK
- **Consent:**
  - Nothing is sent before `activate()`. `send()` re-checks `live()`.
  - DNT, GPC, a non-production host and a missing config all reach `settle()` in `bootAnalytics`'s `finally`, which empties the queue.
  - `optOut()` clears the queue, the in-memory attribution and the stored attribution.
  - The queue is capped at `MAX_PENDING_EVENTS = 50`.
- **sessionStorage:**
  - All access goes through the guarded `read`/`write` helpers.
  - Attribution is loaded only after `activate()` with `granted()`, so it is skipped for DNT.
  - Under opt-out the only storage call is a removal.
- **Referrer:**
  - It is reduced to `url.origin`, which also drops credentials in `user:pw@` referrers. Only http(s) is accepted.
  - The stored value is re-validated on read.
  - The PR does not make #135 worse: PostHog's own `$referrer` handling is unchanged.
- **`trackOnce`:**
  - Keys are page-scoped through the module singleton, so StrictMode runs and remounts send once.
  - The booking key fires on the first successful slot load, and a retry after an error still counts.
  - `loading` starts as `true`, so no event is sent with 0 slots.
- **`logout` ordering:** `signOutAnalytics` captures under the member id and then calls `reset()`. The AccountApp account-deletion path still uses `reset()` only, as documented.
- **Taxonomy:**
  - All 14 events are `source: 'client'` and match the docs table: names, props, files and owners.
  - The server-side `validateEvent(..., 'server')` paths (`server.ts:119`, `outbox.ts:96`) never see client events, so nothing can be dead-lettered.
  - `session_*` props are added after validation and are covered by the PostHog `before_send` scrubber.
- **Event properties:** they hold no email, name, token, order or booking code, or URL. Booking sends `days_ahead`, not the date. `failureReason` limits reasons to snake_case.
- **Bundle and SSR:**
  - The PR adds only small pure modules. `pii.ts` was already in the client bundle through the PostHog destination.
  - No server-only imports reach the islands.
  - `browserClient.page` guards `window`, and all `track` calls run in effects or handlers.
  - The build passes.
- **React:**
  - `PricingTable`'s `[]` effect is intentionally mount-only, keyed through `trackOnce`.
  - The `BookingWidget` effect deps (`loading`, `slotsError`, `slots`) are correct.
  - The `MemberAuth` effect depends on `error`.
  - There are no hook-order issues.
- **TypeScript:** there is no `any` and no unchecked casts. `parseStoredAttribution` uses `in` and `Reflect.get`.
