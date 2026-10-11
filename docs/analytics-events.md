# Analytics event dictionary

The machine-readable source of truth is `ANALYTICS_EVENTS` in [`src/lib/analytics/events.ts`](../src/lib/analytics/events.ts). This page explains it for people. When the two disagree, the code wins; update this page in the same PR as the taxonomy.

Destination today: PostHog project **Zuey.me** (env setup: [env-setup.vi.md §14](env-setup.vi.md#14-analytics-posthog)). GA4 is planned as a second destination behind the same adapter interfaces (`src/lib/analytics/destinations/types.ts`).

## Modules

| File | Role |
|---|---|
| `src/lib/analytics/events.ts` | Typed taxonomy (name → version, source, owner, trigger, allowed properties) and `validateEvent()` |
| `src/lib/analytics/pii.ts` | PII guard: URL parameter stripping, email/JWT/secret redaction, deep scrubbing |
| `src/lib/analytics/consent.ts` | Do Not Track, Global Privacy Control, the local opt-out flag and blocked-storage detection |
| `src/lib/analytics/identity.ts` | Identity lifecycle rules (`planIdentity`), distinct-id validation, identity endpoint parsing |
| `src/lib/analytics/client.ts` | Browser API: `track()`, `trackOnce()`, `identify()`, `reset()`, `signOutAnalytics()`, `optOut()`, `optIn()`, `bootAnalytics()` |
| `src/lib/analytics/attribution.ts` | Session attribution: allowlisted UTM values and the referrer origin, stored per tab session |
| `src/lib/analytics/funnel.ts` | Helpers shared by the funnel events (`failureReason`, `daysAhead`, `moneyProps`) |
| `src/lib/analytics/server.ts` | Server API: `captureServerEvent()` (typed), `sendServerEvent()` (by name, for the outbox), `serverDestinations()` |
| `src/lib/analytics/destinations/posthog.ts` | PostHog config from env, browser adapter (`window.posthog`), server adapter (HTTP capture API), `before_send` scrubber |
| `src/pages/api/members/auth/identity.ts` | `GET /api/members/auth/identity` → `{ member_id }` for the session cookie |

## Rules for every event

- **Declared only.** An event must exist in `ANALYTICS_EVENTS` with the matching source (`client` events through `track()`, `server` events through `captureServerEvent()`/`sendServerEvent()`). Unknown events, undeclared properties, missing required properties and wrong types are dropped, never sent partially.
- **Property kinds.** `string`, `number`, `boolean`, `url`. `url` values are stripped of sensitive query/fragment parameters before sending. Any string longer than 500 characters is rejected (free text such as chat content does not fit an analytics property).
- **No personal data.** A string that contains an email address, a JWT or a secret token (`zm_`, `zoa_`, `zor_`, `zk_`, `sk_`, `whsec_`, GitHub/Slack token prefixes) rejects the whole event when it is a `string` property; in a `url` property those values are replaced by `[redacted]` instead.
- **Envelope.** Every event gets `event_version` (the event's `version`) and `schema_version` (`ANALYTICS_SCHEMA_VERSION`). Bump `version` when a property changes meaning; add a new event instead of changing the trigger.
- **Never break business logic.** `track()`, `identify()`, `reset()` never throw. Server capture never rejects; it returns `{ delivered, uuid, results[], rejected? }` with a per-destination outcome (`disabled`, `invalid`, `timeout`, `network`, `http`). Default server timeout 2.5 s.

## Never collected

Email, name, avatar, phone number; passwords, sign-in links, tokens, API keys, OAuth codes; Zuey AI chat text, questions and prompts; bank account numbers, card details, transfer memos; booking and survey form input. The privacy page (`/privacy#analytics`) states the same list to visitors.

## Automatic PostHog data

PostHog still records `$pageview`, `$pageleave` and autocapture clicks. Before anything leaves the browser, `before_send` (`scrubCaptureResult`) deep-scrubs `properties`, `$set` and `$set_once`:

- URLs (`$current_url`, `$referrer`, `$initial_*`, `href` attributes) lose these parameters (case-insensitive): `token`, `code`, `email`, `key`, `secret`, `sig`, `signature`, `state`, `session`, `password`, `pass`, `pwd`, `auth`, `otp`, `api_key`, `apikey`, `access_token`, `refresh_token`, `id_token`, `client_secret`, `confirm_email`, `new_email`, `jwt`, `hmac`, `nonce`, `ticket`, `manage` (booking manage token), `payerid` (PayPal), plus any name containing `token`, `secret`, `password`, `email`, `session` or `signature`. URL user-info is removed.
- URLs of private pages (`/account`, `/login`, `/billing`, `/booking`, `/chat`, `/connect`, `/oauth`, `/studio`, `/courses/orders`) lose the whole query string and fragment, e.g. the PayPal booking return `/booking/{id}?manage=…&paypal=return&token=…&PayerID=…`.
- Order codes and booking ids in paths become placeholders everywhere (`/billing/:code`, `/billing/card/:id`, `/courses/orders/:code`, `/booking/:id`), in `$current_url`, `$pathname`, `$referrer`, `$initial_*` and any other string: the order code is the SePay transfer memo. On those pages the `title` property is blanked.
- Every other string has emails, JWTs, secret tokens and inline `name=value` pairs of those parameters replaced with `[redacted]`.
- If scrubbing fails, the event is dropped.

Autocapture is off on `/account`, `/login`, `/billing`, `/booking`, `/chat`, `/connect`, `/oauth`, `/studio` and `/courses/orders`, and these components carry `ph-no-capture` wherever they are embedded: the Zuey AI panel, survey blocks (vote labels are private), the booking widget, the course checkout form, the company-invoice fields and the `/connect` Telegram link island (its link token never reaches the page; it stays in an HttpOnly cookie). Session replay is disabled in code (`disable_session_recording: true`); enabling it later needs a masking review for auth, billing, AI and booking screens first.

## Environments and consent

- Key and host come from `PUBLIC_POSTHOG_KEY` / `PUBLIC_POSTHOG_HOST` (runtime binding first, currently the `[vars]` of `wrangler.toml`, then build-time env). The built-in key of project Zuey.me is used only by production builds without a configured key.
- The browser captures only on `zuey.me` and `www.zuey.me` in production builds. Preview deployments (`*.pages.dev`) are production builds and receive the same key from `wrangler.toml`, but their hostname is not allowlisted, so they stay silent; so do `localhost` and dev builds. `PUBLIC_ANALYTICS_DEBUG=1` lifts the hostname/dev check.
- The server sends nothing outside production builds, and only when the request host is `zuey.me` or `www.zuey.me` (`isServerCaptureHost()` in `src/lib/analytics/server.ts`, the same allowlist as the browser). A preview deployment (`*.pages.dev`) therefore never delivers server events to the production project: its outbox drain answers `skipped` with `skipped_reason: "not_production_host"` and leaves the rows queued. `PUBLIC_ANALYTICS_DEBUG=1` lifts both checks.
- PostHog is not even initialised (no network request) when the browser sends Do Not Track (`1`/`yes`) or Global Privacy Control, when the visitor turned analytics off at `/privacy#analytics` (localStorage `zuey_analytics_opt_out=1`), or when the browser blocks localStorage. Blocked storage (reading or writing throws; probed once per page with the temporary key `zuey_analytics_storage_probe`) gives the consent state `storage_blocked`: `/privacy#analytics` then says storage is blocked and shows no toggle, because no choice could be saved. Opting out also calls PostHog `opt_out_capturing()` and `reset()`.
- These browser choices do not cover [server events](#server-events). Account and purchase events (sign-up, sign-in, purchases, refunds, payment issues, subscription lifecycle) are recorded from payment and sign-in webhooks on the server, not from the browser, so they are sent regardless of the toggle, Do Not Track or GPC. They use only the pseudonymous member id (never an email, phone number or token), carry `$geoip_disable: true` so no location is derived from the server's IP, and booking guests' events carry `$process_person_profile: false` so no person profile is created for them. The privacy page (`/privacy#analytics`) says the same.

## Identity lifecycle

| Situation | What happens |
|---|---|
| Anonymous visitor | PostHog anonymous id; `person_profiles: 'identified_only'`, so no person profile is created |
| Page load with a verified member session | `bootAnalytics()` asks `/api/members/auth/identity` and calls `identify(member_id)`. The answer is cached in the tab (sessionStorage) for 10 minutes, or 2 minutes when signed out; the cache is used only while it matches the browser-wide identity key (localStorage), and it is removed, never written, on `/login`, `/account`, `/oauth`, so the page after a sign-in redirect identifies at once |
| Already identified | `identify()` is skipped only when PostHog's `get_distinct_id()` already equals the member id |
| Member signs out (`/account`, Studio member session) or deletes the account | Sign-out sends `logout` under the member id first (`signOutAnalytics()`), then `reset()` before navigating: clears the stored member and starts a new anonymous id. Account deletion only resets |
| Session expired or ended on another device | The next identity check returns `null` and the browser is reset |
| A different member signs in on the same browser | `reset()` first, then `identify()`; the two people are never merged |
| Sign-out in another tab | That tab's `reset()` clears the shared identity key; other tabs ignore their now-stale cache and re-check the server |

Known limit: if the previous member's session ended without this browser running `reset()` (expired, signed out on another device, cookies cleared by hand), the first `$pageview` of the next visit is still attributed to that member, because PostHog sends it before the identity check answers. The browser is reset right after, so later events are not.

Only the opaque member id (`users.id`) is ever used as `distinct_id`. `identify()` refuses anything that is not an id-shaped string (`[A-Za-z0-9_.:-]{1,200}`, no email/JWT/secret). No person properties (`$set`) are sent with identify.

## Events

Owner values: `growth` (acquisition, profile, affiliate, sign-up), `product` (in-app features), `revenue` (payments and subscriptions). The client events below are emitted through `track()`; their names predate the taxonomy and are kept so existing PostHog insights keep working. Server events follow in their own table.

| Event | Version | Source | Trigger | Properties | Emitted in | Owner |
|---|---|---|---|---|---|---|
| `link_clicked` | 1 | client | A profile link card is opened | `id` string, `section` string, `title` string, `url` url | `src/components/LinkCard.tsx` | growth |
| `social_clicked` | 1 | client | A social icon on the profile is clicked | `platform` string | `src/components/ProfileView.tsx` | growth |
| `explore_clicked` | 1 | client | An explore shortcut on the profile is clicked | `target` url | `src/components/ProfileView.tsx` | growth |
| `language_changed` | 1 | client | The visitor picks another locale in the language switch | `language` string (locale code) | `src/components/LanguageSwitch.tsx` | growth |
| `command_palette_action` | 1 | client | An action is run from the command palette | `action` string (palette action id) | `src/components/home/CommandPalette.tsx` | product |
| `command_palette_article` | 1 | client | An article result is opened from the command palette | `slug` string | `src/components/home/CommandPalette.tsx` | product |
| `command_palette_video` | 1 | client | A video result is opened from the command palette | `youtube_id` string | `src/components/home/CommandPalette.tsx` | product |
| `200lab_course_click` | 1 | client | A 200lab course card (affiliate) is clicked | `slug` string, `source` string (`app` \| `route` \| `featured`) | `src/components/lab200/Lab200Courses.tsx` | growth |
| `article_ask_ai_opened` | 1 | client | The Ask Zuey AI button of an article is pressed | `slug` string | `src/components/ai/ArticleAskAi.tsx` | product |
| `article_ask_ai_clicked` | 1 | client | Ask AI is pressed on a text selection in an article | `slug` string, `chars` number (selection length, not the text) | `src/components/ai/ArticleAskAi.tsx` | product |
| `article_ask_ai_sent` | 1 | client | A question started from an article is sent to Zuey AI | `slug` string, `quoted` boolean | `src/components/ai/ZueyAiPanel.tsx` | product |

PII policy for all rows: properties are public content identifiers (slugs, ids, locale codes, public URLs) and counts. A link card URL that contains an email (for example `mailto:`) is sent with the address replaced by `[redacted]`.

### Funnel events (client)

Sign-up, pricing, checkout and booking steps sent from the browser. They follow the same consent gate as every client event and carry no email, name, phone, token, order code, booking id, payment reference or URL. Failure reasons are the API's snake_case error code (`failureReason()`), anything else becomes `unknown`. Money props are list prices in major units of their own currency (VND as shown, USD cents / 100), never converted.

| Event | Version | Trigger | Properties | Emitted in | Owner |
|---|---|---|---|---|---|
| `sign_up_started` | 1 | The sign-in form is submitted, or a Google/GitHub button is pressed (the same form signs up and signs in) | `method` (`magic_link` \| `google` \| `github`) | `src/components/members/MemberAuth.tsx` | growth |
| `magic_link_requested` | 1 | The API accepted a sign-in link request | none | same | growth |
| `auth_failed` | 1 | The link request fails, a sign-in link fails to verify, or `/login` opens with an OAuth/callback error | `stage` (`magic_link_request` \| `magic_link_verify` \| `callback`), `reason` string (error code) | same | growth |
| `logout` | 1 | A member signs out (sent before `reset()`) | `surface` (`account` \| `studio`) | `src/components/members/AccountApp.tsx`, `src/components/studio/StudioApp.tsx` | growth |
| `pricing_viewed` | 1 | The pricing table is shown (once per page load) | `months` number, `card_available` boolean, `preselected_plan`? | `src/components/members/PricingTable.tsx` | revenue |
| `billing_term_selected` | 1 | Another billing term is picked | `months`, `previous_months` | same | revenue |
| `plan_selected` | 1 | A plan's buy button is pressed | `plan`, `provider` (`sepay` \| `dodo`), `months` | same | revenue |
| `begin_checkout` | 1 | The checkout request is about to be sent (form valid) | `order_type` (`membership` \| `course`), `provider`, `discount_entered` boolean, `plan`?, `months`?, `course`? (slug), `value`?, `currency`? | `PricingTable.tsx`, `src/components/courses/CourseCheckout.tsx` | revenue |
| `checkout_created` | 1 | The API created the order or card session | same keys plus `free` boolean (fully discounted), without `discount_entered` | same | revenue |
| `payment_initiated` | 1 | The browser leaves for the payment page (card checkout or VietQR order page); not sent for a free order | `order_type`, `provider`, `plan`?, `months`?, `course`? | same | revenue |
| `booking_availability_viewed` | 1 | Booking slots loaded (once per page load) | `slot_count` number | `src/components/booking/BookingWidget.tsx` | revenue |
| `booking_slot_selected` | 1 | A slot is picked | `duration_min` number, `days_ahead` number (whole days, not the date) | same | revenue |
| `booking_hold_created` | 1 | The slot hold (booking request) succeeded | `payment_method` (`sepay` \| `paypal`), `discounted` boolean, `free` boolean | same | revenue |
| `booking_checkout_started` | 1 | The booking payment was started (PayPal order or VietQR shown) | `payment_method`, `value`?, `currency`? | same | revenue |

**Late hydration.** React islands can hydrate before the layout's boot script decides consent. `track()` calls made before that are queued (at most 50, `MAX_PENDING_EVENTS`) and sent once analytics activates, or dropped when it stays off (DNT, GPC, opt-out, blocked storage, non-production host). Mount-time events use `trackOnce(key, …)`, which sends a key once per page load, so React StrictMode double effects and remounts do not double count.

**Session attribution.** On the first page of a tab session where analytics is active, `src/lib/analytics/attribution.ts` stores (sessionStorage `zuey_analytics_attribution`, wrapped in try/catch) the first touch: the five `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` values that are plain text (letters, digits, spaces and `._+|:()-`, at most 100 characters, no email/token), and the referrer's **origin only** (http/https, other sites only). Paths and queries are dropped because they routinely carry search terms, webmail message ids, document ids and sign-in tokens; the origin is enough to tell channels apart. Click ids (`gclid`, `fbclid`) and any other parameter are ignored. Later pages in the session keep the first touch, a direct visit stays direct, and the stored value is re-validated on read. Every client event of the session then carries `session_utm_*` and `session_referrer` when present. Opting out removes the stored value; nothing is stored while analytics is off.

**Funnel join.** `pricing_viewed` → `plan_selected` → `begin_checkout` → `purchase` (server) → `subscription_activated` (server) share one `distinct_id` for a member: the browser identifies with `member_id` from `/api/members/auth/identity`, which is `users.id`, the same id the server outbox uses (covered by a test in `tests/analytics-outbox.test.ts`). Creating an order requires a signed-in member (an anonymous `begin_checkout` is followed by a redirect to sign in), so `checkout_created` and `payment_initiated` are always identified; steps taken anonymously before sign-in in the same browser are merged into the member by PostHog at `identify()`. Not joined, by design:

- Booking guests: the server events use a one-off `guest_` id (hash of the booking id, no person profile), so a guest's `booking_*` client steps and their `purchase` stay separate. Join on aggregate counts, not on people.
- Browsers with analytics off: the server `purchase` and subscription events still arrive (see Environments and consent) with no client steps before them.

### Server events

Owner `revenue` covers payments and subscriptions. Server events are written to the analytics outbox right after the verified state change, as a separate statement, and delivered later (see below). `distinct_id` is the member id (`users.id`); a booking guest has no account and gets `guest_` + 24 hex characters of SHA-256 of the booking id, sent with `$process_person_profile: false`. Every server event is sent with `$lib: "zuey-me-server"` and `$geoip_disable: true`. Amounts are what the customer paid (tax included), in major units of the original currency, never converted: VND as paid, USD cents / 100. A refund carries the amount the provider reports taken back, with `partial` when it is less than the payment.

| Event | Version | Trigger | Properties | Emitted in | Owner |
|---|---|---|---|---|---|
| `sign_up` | 1 | A member account is created by a verified sign-in | `method` string (`magic_link`, `google`, …) | `src/lib/members/login-tokens.ts`, `src/lib/members/oauth.ts` | growth |
| `login` | 1 | An existing member signs in (verified magic link or OAuth); the sign-in that creates the account sends `sign_up` instead | `method` string | same | growth |
| `purchase` | 1 | A payment is verified: SePay transfer (webhook, reconcile or admin resolve) for a membership or course order, Dodo charge (first or renewal), PayPal or SePay booking payment (webhook, PayPal return or admin resolve of a flagged booking) | `provider` (`sepay` \| `dodo` \| `paypal`), `order_type` (`membership` \| `course` \| `booking`), `amount` number, `currency` string, `renewal` boolean, `plan`?, `months`?, `flagged`? (`true` when the money was collected but the Dodo charge is held for admin review) | `src/lib/members/billing.ts`, `src/lib/payments/dodo-billing.ts`, `src/lib/courses/course-order-payments.ts`, `src/lib/booking/store.ts` | revenue |
| `refund` | 1 | A refund or lost chargeback is applied (Dodo, PayPal, course orders). An opened dispute only revokes access; `reason: chargeback` is sent once the dispute is lost (Dodo `dispute.lost`, `dispute.accepted`, `dispute.expired`), and a won dispute restores access without a second `purchase` | `provider`, `order_type`, `reason` (`refund` \| `chargeback`), `amount`?, `currency`?, `partial`?, `plan`? | `src/lib/payments/dodo-billing.ts`, `src/lib/courses/course-order-payments.ts`, `src/lib/booking/store.ts` | revenue |
| `payment_failed` | 1 | Dodo reports a failed charge | `provider`, `order_type`, `amount`?, `currency`?, `plan`? | `src/lib/payments/dodo-billing.ts`, `src/lib/courses/course-payment-webhooks.ts` | revenue |
| `payment_needs_attention` | 1 | A verified payment is flagged for admin review (underpaid, overpaid, expired order, discount not applied, …) | `provider`, `order_type`, `reason` string, `amount`?, `currency`?, `plan`? | billing, Dodo, course and booking payment flows | revenue |
| `subscription_activated` | 1 | A plan becomes active for a member who had no active access | `plan`, `provider` (`sepay` \| `dodo`), `period_end` ISO date | `src/lib/members/subscriptions.ts` (`recomputeSubscription`) | revenue |
| `subscription_renewed` | 1 | An active plan's period end moves forward by at least 7 days | `plan`, `provider`, `period_end` | same | revenue |
| `subscription_cancel_scheduled` | 1 | A card subscription is set to cancel at period end | `plan`, `provider` | `src/lib/payments/dodo-billing.ts` | revenue |
| `subscription_cancelled` | 1 | A card subscription is cancelled by the provider | `plan`, `provider` | same | revenue |
| `subscription_expired` | 1 | Active access ends: revoked by a recompute, or a prepaid period runs out (found by the outbox drain) | `plan`, `period_end`, `provider`? | `src/lib/members/subscriptions.ts`, `src/lib/analytics/outbox.ts` | revenue |

PII policy: no email, name, token, bank content or order code is ever stored in the outbox or sent; `enqueueServerEvent()` validates every row against the taxonomy and rejects PII-looking values before it is stored.

## Server event outbox

Table `analytics_outbox` (`migrations/0022_analytics_outbox.sql`), code in `src/lib/analytics/outbox.ts` and `src/lib/analytics/commerce-events.ts`.

- **One row per fact, at-least-once delivery with idempotent keys.** Each row has a `dedupe_key` with a unique index; a repeat insert is ignored. Keys come from the verified fact, not from the webhook delivery: `purchase:<provider>:<transaction>` where the transaction is the billing/course order id for one-time orders (one order is paid once; extra transfers are flagged instead), the Dodo payment id (each renewal charge has its own id) or the PayPal capture / SePay transaction id for bookings. An admin resolve of a flagged booking reuses the key of the first transaction recorded for it and sums what the guest paid in the booking's currency across providers; without a recorded transaction it uses `booking:<booking id>` and the price due. A resolve queues nothing when the booking was already confirmed with recorded money before (it is cancelled or flagged and its `attention_reason` was empty or `admin`: a payment that flags a booking always sets its own reason; a held or expired booking was never counted), so a webhook-counted booking that is flagged or cancelled and resolved again is not counted twice, whatever the outbox still holds. Lifecycle keys include the resulting `period_end`, so a renewal or a later re-activation is a new event, and the drain's expiry sweep uses the same key as the recompute.
- **Payment first.** The insert is a separate statement after the payment state has been written and every error is caught and logged (`analytics outbox: could not queue …`); a failed or missing outbox never changes a webhook's answer or a member's access.
- **Delivery.** The `zuey-me-scheduler` Worker calls `POST /api/v1/analytics/outbox/drain` every 5 minutes with `CRON_SECRET` (admins may call it too; optional body `{ "limit": 1–40 }`, default 30). The drain first queues `subscription_expired` for prepaid periods that ended in the last 3 days (one `INSERT … SELECT`, at most 200 per run), then leases due rows in batches of 10 (2-minute lease, a crashed run's rows are reclaimed), sends each through `sendServerEvent()` with the row id as event `uuid` so PostHog de-duplicates a retried delivery, and writes each batch's outcome with one `UPDATE` per group of rows that share it. It stops after 20 seconds.
- **Bounded runs.** One run issues at most 20 D1 statements (`MAX_DRAIN_QUERIES`) and 40 PostHog requests, under the Workers free plan's 50 per invocation. A batch is claimed only when its worst case (one claim plus one settle statement per row) still fits; a typical run of 30 deliveries uses about 9 statements. The response reports `queries`, `pending` (rows still waiting) and `budget_exhausted`.
- **Retry.** A failed row is retried after 5, 10, 20, … minutes (capped at 6 hours), so it survives a destination outage of about 22 hours. A row is marked `dead` with `last_error` and never retried automatically after 10 attempts, on a payload rejection (HTTP 400/413/422), or when the taxonomy no longer accepts its payload. Auth errors (401/403/404) from a wrong or rotated key are retried. After fixing the cause, an operator requeues dead rows with `UPDATE analytics_outbox SET status = 'pending', attempts = 0, next_attempt_at = <now ISO> WHERE status = 'dead'` (record a time-travel restore point first).
- **Monitoring.** The scheduler reads each drain summary (`workers/scheduler/src/analytics-drain-check.ts`). It logs a warning when rows were dead-lettered while others were delivered, when fewer than three claimed rows were all retried (a transient timeout), or when the run was skipped on a non-production host. It fails the cron invocation when nothing was delivered and either at least three claimed rows all failed or a row was dead-lettered, or when analytics is disabled on the production host while rows are pending.
- **Retention.** Delivered rows are deleted 30 days after `sent_at` (up to 500 per run, index `(status, sent_at)`); pending and dead rows are kept. Dedupe keys are not needed after that window: providers redeliver webhooks within days, lifecycle keys include the period end, the expiry sweep looks back only 3 days, a dispute won later restores access without queueing a purchase, and a booking re-resolved after money was recorded for it queues nothing (see above). One case still relies on the key: a booking resolved without any recorded transaction, then flagged or cancelled and resolved again more than 30 days after delivery, is counted a second time.
- **Preview gate.** Without a destination (not a production build, no key, or a non-production host) the drain claims nothing and the rows stay `pending`.
- **Dodo refunds of renewals.** Refund and dispute webhooks carry only the payment id. Every collected Dodo charge is recorded in `payment_events` as `charge:<payment id>` with its card, so a refund or lost dispute of a renewal charge is matched to its card, logged (`billing.card_reversal` with `renewal: true`) and queues one `refund` keyed by the refund/dispute id. Only a first-payment reversal reverses the referral commission. A payment with no `charge:` row (a refund or dispute that beats its `payment.succeeded`, or a renewal charged before charge rows existed) is looked up with Dodo `GET /payments/{id}`; dispute webhooks name no customer, so the lookup's `subscription_id` is what ties it to a card. A renewal of a card that already has a first payment is matched at once. On a card with no first payment yet, the webhook answers `409 payment_not_recorded` so Dodo redelivers it after the charge (Dodo makes 8 attempts over about 28 hours: 0, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h). A failed lookup or a payment of no card here is acknowledged as `ignored`. The `refund` event is queued before the activity log, and the log write throws on failure, so a retry after a partial failure logs the reversal once.
- **Dodo charge count.** Promo coverage and the minimum accepted charge depend on which charge of the card this is. It is the number of distinct `charge:<payment id>` rows, so a payment redelivered under a new webhook id counts once, plus one per `payment.succeeded` webhook row received more than a minute before the card's first charge row (charges collected before charge rows existed, whose payment id was never stored).

## Adding an event

1. Add the entry to `ANALYTICS_EVENTS` (name in `snake_case`, `version: 1`, `source`, `owner`, `trigger`, `props`).
2. Call `track('name', { ... })` in the browser or `captureServerEvent(env, 'name', memberId, { ... })` on the server; TypeScript enforces the property shape.
3. Add a row to the table above and a test case if the event has non-trivial properties.
4. Server events that must not be lost go through `enqueueServerEvent()` with a dedupe key derived from the verified fact (see the outbox section); never call `captureServerEvent()` for them.

## Verifying in production

PostHog → *Activity → Live events*, filtered to project Zuey.me:

1. `$pageview` from zuey.me shows a `$current_url` without sensitive parameters (try `/login/verify?token=test`).
2. After signing in and reloading, events carry the member id as `distinct_id`; after signing out, a new anonymous id.
3. With Do Not Track/GPC on, or after "Turn analytics off" on `/privacy#analytics`, no new events arrive from that browser. Server-side account and purchase events still arrive under the member id (see Environments and consent).
