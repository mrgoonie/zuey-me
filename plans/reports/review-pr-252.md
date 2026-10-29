# Review: PR #252 — GA4 destination (gtag + Measurement Protocol purchase/refund)

- PR head: `1edd504` (`feat/64-ga4-destination`), based on current `main`. Closes #64 (epic #24).
- Reviewer: isolated agent; did not write this code. Date: 2026-10-23 (Asia/Saigon).

## Verdict

**Changes requested.** No blockers. There are 3 majors:

1. A transient PostHog failure on `purchase`/`refund` now silently drops the PostHog copy.
2. The GA4 path does not match the PII/consent posture `/privacy` describes (search words in `page_location` until #242 lands, plus enhanced measurement).
3. Server purchases carry no session attribution, which matters because GA4's role in the epic is attribution.

Consent gating, Consent Mode order, opt-out cookie cleanup, secret handling, hashed transaction ids and CI wiring are correct.

## Verification

| Check | Result |
|---|---|
| `bun install` | 742 packages OK |
| `bun test` (1st run, during heavy IO right after install) | 1640 pass, 5 fail, 1 error, all in `tests/zueyos-liquid-glass.test.ts` (timing) |
| `bun test` (2nd run) | **1645 pass, 0 fail** |
| `bun test` liquid-glass + ga4 + outbox alone | 74 pass, 0 fail. The first-run failures are flaky and unrelated to this PR. |
| `bun run build` | astro check 0 errors, 0 warnings; build Complete |
| `git merge-tree` vs #242, #244, #247, `main` | All clean (exit 0) |
| Probe test (temporary, deleted) | Confirms M1 and m1 below |

## Findings

### Major

**M1. When PostHog fails and GA4 accepts a purchase/refund, the row is marked `sent` and PostHog never gets it.**
`src/lib/analytics/server.ts:144` (`delivered: results.some(r => r.ok)`) and `src/lib/analytics/outbox.ts:230`.
- Evidence: in a probe, a purchase row drained with PostHog returning 503 and GA4 returning 204 gave `{"sent":1,"retried":0,"row":{"status":"sent"}}`. Before this PR, PostHog was the only destination, so a 503, timeout or 401 (rotated key) meant a retry for about 22 h.
- Measurement Protocol answers 2xx to almost any request, malformed ones included. So in practice GA4 always "accepts", and every PostHog outage now loses the purchase and refund events, the revenue events PostHog is the primary store for. The PR notes only the opposite case (GA4 fails, PostHog accepts).
- Fix: track delivery per destination. One option is a `delivered_to` column (new migration) so a retry goes only to the destinations that failed. Simpler: count a row as sent only when the primary destination (PostHog) succeeded. A GA4 resend is mostly harmless because GA4 de-duplicates `purchase` by `transaction_id`; a `refund` resend is not de-duplicated, so prefer the per-destination column.

**M2. The GA4 page-view data does not match `/privacy`: site-search words, and enhanced measurement the code does not control.**
`src/lib/analytics/destinations/ga4.ts:94,155-156`, `src/pages/privacy.astro:137,275`, `docs/analytics-events.md:196`.
- **Search words, before #242.** `scrubUrl()` on `main` keeps `q`. On `/articles?q=<search words>` (`src/pages/articles/index.astro` reads `query.q`), the scrubbed `page_location` that `config` sends to Google therefore contains the raw search words. PostHog has the same bug (#156), but GA4 is a new third party receiving them.
- **After #242.** #242 strips `q` inside `scrubUrl()` for root-relative URLs and the production hostnames. The merge is clean, and `page_location`/`page_referrer` would then be clean.
- **Site search (on by default in a web stream).** It fires `view_search_results` with `search_term` when the URL holds `q`, `s`, `search`, `query` or `keyword`. Google's docs do not say whether it reads the overridden `page_location` or the real `document.location`, so this is **unverified**. If it reads the real URL, `q` still reaches GA4 as `search_term` even after #242.
- **Page changes based on browser history events (on by default).** `src/scripts/article-list-infinite-scroll.ts:33` calls `history.replaceState` with `/articles?…&page=N`, filters and `q` included. That can trigger extra page views from the real URL, or with the stale `page_location` from the one-off `set`.
- **Other events.** Outbound clicks send `link_url`, and `ArticleActionBar.tsx:21-23` links to `chatgpt.com/?q=<prompt>`, `claude.ai/new?q=…` and `gemini…?q=…`. That puts prompt text in a GA4 event, which `/privacy` lists under "never sent". Form interactions send form id/name/destination only, not typed text (low risk). Scrolls, file downloads and video engagement also go out.
- **What `/privacy` says.** "GA4 … receives only page views … and checkout starts", which is inaccurate while any enhanced measurement is on. The PR moves this to an owner step ("code cannot control them").
- Mitigation, all of these:
  - (a) Merge #242 before or with this PR, or make `ga4PageFields` drop `q` itself so GA4 never depends on merge order.
  - (b) Make the owner step **mandatory before deploy**: turn off Site search, Page changes based on browser history events, Outbound clicks, Form interactions, File downloads and Video engagement in the zuey.me web stream. Keep only Page views (and Scrolls if wanted).
  - (c) After deploy, check in GA4 DebugView with `/articles?q=test` and an outbound AI-share click that no `search_term`/`link_url` carries the words.
  - (d) Change `/privacy` (vi+en) and `docs/analytics-events.md:196` to state exactly which events the stream collects, or say "page views and engagement signals (scroll), never search words or link text".
  - There is no documented gtag config switch that turns enhanced measurement off client-side. `send_page_view: false` affects only the `config` page view, not enhanced events, so code alone cannot close this.

**M3. Server purchases cannot be attributed in GA4.**
`src/lib/analytics/destinations/ga4.ts:242` (`client_id` = hash of the distinct id, no `session_id`).
- A Measurement Protocol event whose `client_id` differs from the browser's `_ga` and has no `session_id` lands outside any web session. Its session source/medium is `(not set)`/direct, and for guest bookings (no `user_id`) it is a brand-new user. Epic #24 gives GA4 the role of "attribution/ecommerce". As built, GA4 revenue reports total correctly but attribute nothing. The PR notes accept this, but it defeats the destination's purpose.
- Fix: at checkout creation, while the browser is present and consent is granted, capture the `_ga` client id and the `_ga_<stream>` session id. Store them on the order/booking (or in a short-lived outbox property that is not PII), and use them in the MP payload, falling back to the hash. Fine as a follow-up issue if the owner accepts unattributed revenue for now. Record that decision.

### Minor

**m1. With a misconfigured PostHog (null config) in production, non-GA4 rows are marked `sent` and the cron alarm is masked.**
`src/lib/analytics/server.ts:77-79` and `server.ts:141`.
- Evidence: probe with destinations `[ga4]` and a `login` row gave `{"status":"ok","sent":1,"row":{"status":"sent"}}`.
- Before this PR, `serverDestinations` returned `[]`, the drain answered `skipped`/`analytics_disabled`, rows stayed pending, and the scheduler check failed the cron. Now a malformed `PUBLIC_POSTHOG_HOST`/key with the GA4 secret set loses every PostHog server event without a signal.
- Fix: in `sendServerEvent`, treat "no target accepts" as delivered only when the event is PostHog-excluded by design. Simpler: keep returning `[]` from `serverDestinations` when PostHog config is null.

**m2. The drain throughput cut applies to every row, not just GA4 rows.**
`src/lib/analytics/outbox.ts:343`. The default 30 rows becomes 20 per run for all rows, though only `purchase`/`refund` cost two requests. That is still 240 rows/h, so it is acceptable. The worst case stays ≤ 40 fetches + ≤ 20 D1 statements as before, so the subrequest budget is fine. Optional: count requests (1 + accepts) instead of dividing rows.

**m3. The first `page_view` never carries `user_id`.**
`ga4.ts:155-156,173`. `config` (which sends the page view) runs before `syncIdentity()` calls `identify`. So every signed-in page view is sent without `user_id`, and only later events (`begin_checkout`) carry it. Fix: apply the member id cached in localStorage (`zuey_analytics_member`) via `set user_id` before `config`, or pass `send_page_view: false` and send `page_view` after the identity sync.

**m4. PostHog `identify` is called again on every page load.**
`src/lib/analytics/client.ts:192` with `ga4.ts:194`. GA4's `distinctId()` is in-memory and `null` at each load, so `targets.every(d => d.distinctId() === memberId)` is always false and `each(d => d.identify(memberId))` re-runs PostHog `identify` too. posthog-js ignores a same-id identify, so this is harmless today, but it defeats the guard. Fix: let the GA4 destination's `distinctId()` read the stored member id, or exclude destinations without persistent identity from the check.

**m5. A refund without a known purchase falls back to `event.uuid`.**
`ga4.ts:250`. Admin-resolved bookings keyed `booking:<id>` and any reversal without a provider payment id produce a GA4 refund whose `transaction_id` matches nothing. GA4 then shows a refund with no purchase. Consider skipping the GA4 refund (`accepts`/`invalid`) when there is no `transaction_id`, instead of inventing one.

**m6. `/privacy` GA4 paragraph omissions.**
`privacy.astro:137,275`.
- It does not say the server MP events are also sent under DNT/GPC. The PostHog paragraph does; the GA4 one says only "when browser analytics is off".
- It does not name Google as the recipient of IP/user agent outside the EU/VN region the way the PostHog line names the US.
- The processor rows (`:172`, `:310`) are otherwise accurate, apart from the enhanced-measurement gap in M2.

### Nit

- **n1.** `deleteGaCookies` (`ga4.ts` opt-out path) runs only when GA4 is active on the page. A visitor who later switches on DNT/GPC keeps stale `_ga` cookies (gtag never loads, so nothing is sent). Optional: delete `_ga*` in `bootAnalytics` when consent is not granted.
- **n2.** Partial refunds send a single item with `price = refunded amount, quantity 1`. GA4 treats item-level partial refunds by item id, so item revenue will look odd. Acceptable.
- **n3.** The client id hash is unsalted (`ga4:<member id>`). That is fine, since the member id is already sent as `user_id`.

## Points checked and OK

- **Consent gating.** `bootAnalytics` applies the hostname/build gate and `consentState === 'granted'` before `ga4Browser.start`, and `start` re-checks consent. Opt-out, DNT, GPC and blocked storage (`storage_blocked`) all mean no `dataLayer`, no `gtag` and no script (tests plus the PR's browser trace).
- **Consent Mode order.** `consent default` (all four denied), then `update` (analytics only), then `js`, then `set`, then `config`. `allow_google_signals` and `allow_ad_personalization_signals` are false.
- **Revocation.** `client.optOut` → `reset` → `optOut` sets `analytics_storage` denied and `ga-disable-<id>`. It deletes `_ga`/`_ga_*` with host-only, host and `.zuey.me` domain variants, which covers gtag's `cookie_domain: auto`. Re-opt-in works.
- **`page_title`.** It is replaced on order and booking paths. The `/articles` title does not include the query.
- **`user_id`.** It is the internal member id, pseudonymous and the same one PostHog uses. It is cleared on reset.
- **MP payload.**
  - No email, name or raw order code.
  - `transaction_id` = `tx_` + 24 hex of SHA-256(`provider:transaction`).
  - Purchase and refund keys match: Dodo `paymentId` ↔ `event.paymentId`; course `course_order:<id>` with `order.provider` on both sides; PayPal booking capture id (`webhooks/paypal.ts:42`, `store.ts:796`) ↔ `event.captureId`.
  - `items` contain only the plan/course slug, the order type and a months variant.
  - Ads consent is DENIED and `non_personalized_ads` is set.
- **Secret handling.** `GA4_API_SECRET` is read from the runtime only (`analyticsEnvFrom`), never inlined. Failure results omit the URL and message. Without the secret, no GA4 destination exists and nothing is dead-lettered (test: sent 2, dead 0).
- **Double counting.** `begin_checkout` is client-only; `purchase`/`refund` are server-only via `accepts()`. The browser GA4 destination ignores every other event.
- **CI.** `PUBLIC_GA4_MEASUREMENT_ID: ${{ vars.PUBLIC_GA4_MEASUREMENT_ID }}` is on the build step only. When unset it expands to an empty string, `resolveGa4MeasurementId` returns null and GA4 is off. The build passed locally without it.
- **Conflicts.** None textual with #242, #244 or #247. The only semantic one is #242, which is desirable (M2a).

## Unresolved questions

1. Does enhanced-measurement site search read the overridden `page_location` or `document.location`? Verify in DebugView (M2). Google's docs say only that it keys off the URL query parameters ([Enhanced measurement events](https://support.google.com/analytics/answer/9216061?hl=en)).
2. Does the owner accept unattributed server revenue in GA4 for now (M3), or should the `_ga` client/session id be captured at checkout?

Status: DONE
Summary: Changes requested, no blockers. Majors: M1 (PostHog purchase/refund lost when GA4 accepts), M2 (search words, enhanced measurement and `/privacy` accuracy), M3 (server purchases unattributed in GA4).
