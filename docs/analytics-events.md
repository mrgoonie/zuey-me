# Analytics event dictionary

The machine-readable source of truth is `ANALYTICS_EVENTS` in [`src/lib/analytics/events.ts`](../src/lib/analytics/events.ts). This page explains it for people. When the two disagree, the code wins; update this page in the same PR as the taxonomy.

Destination today: PostHog project **Zuey.me** (env setup: [env-setup.vi.md §14](env-setup.vi.md#14-analytics-posthog)). GA4 is planned as a second destination behind the same adapter interfaces (`src/lib/analytics/destinations/types.ts`).

## Modules

| File | Role |
|---|---|
| `src/lib/analytics/events.ts` | Typed taxonomy (name → version, source, owner, trigger, allowed properties) and `validateEvent()` |
| `src/lib/analytics/pii.ts` | PII guard: URL parameter stripping, email/JWT/secret redaction, deep scrubbing |
| `src/lib/analytics/consent.ts` | Do Not Track, Global Privacy Control and the local opt-out flag |
| `src/lib/analytics/identity.ts` | Identity lifecycle rules (`planIdentity`), distinct-id validation, identity endpoint parsing |
| `src/lib/analytics/client.ts` | Browser API: `track()`, `identify()`, `reset()`, `optOut()`, `optIn()`, `bootAnalytics()` |
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
- The server sends nothing outside production builds unless `PUBLIC_ANALYTICS_DEBUG=1`. It has no hostname to check, so server events emitted by a preview deployment would reach the production project; no server event exists yet, and the outbox must gate on the request host before adding one.
- PostHog is not even initialised (no network request) when the browser sends Do Not Track (`1`/`yes`) or Global Privacy Control, when the visitor turned analytics off at `/privacy#analytics` (localStorage `zuey_analytics_opt_out=1`), or when the browser blocks localStorage (treated as opted out). Opting out also calls PostHog `opt_out_capturing()` and `reset()`.

## Identity lifecycle

| Situation | What happens |
|---|---|
| Anonymous visitor | PostHog anonymous id; `person_profiles: 'identified_only'`, so no person profile is created |
| Page load with a verified member session | `bootAnalytics()` asks `/api/members/auth/identity` and calls `identify(member_id)`. The answer is cached in the tab (sessionStorage) for 10 minutes, or 2 minutes when signed out; the cache is used only while it matches the browser-wide identity key (localStorage), and it is removed, never written, on `/login`, `/account`, `/oauth`, so the page after a sign-in redirect identifies at once |
| Already identified | `identify()` is skipped only when PostHog's `get_distinct_id()` already equals the member id |
| Member signs out (`/account`, Studio member session) or deletes the account | `reset()` before navigating: clears the stored member and starts a new anonymous id |
| Session expired or ended on another device | The next identity check returns `null` and the browser is reset |
| A different member signs in on the same browser | `reset()` first, then `identify()`; the two people are never merged |
| Sign-out in another tab | That tab's `reset()` clears the shared identity key; other tabs ignore their now-stale cache and re-check the server |

Known limit: if the previous member's session ended without this browser running `reset()` (expired, signed out on another device, cookies cleared by hand), the first `$pageview` of the next visit is still attributed to that member, because PostHog sends it before the identity check answers. The browser is reset right after, so later events are not.

Only the opaque member id (`users.id`) is ever used as `distinct_id`. `identify()` refuses anything that is not an id-shaped string (`[A-Za-z0-9_.:-]{1,200}`, no email/JWT/secret). No person properties (`$set`) are sent with identify.

## Events

Owner values: `growth` (acquisition, profile, affiliate), `product` (in-app features). All current events are client events emitted through `track()`; their names predate the taxonomy and are kept so existing PostHog insights keep working.

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

## Adding an event

1. Add the entry to `ANALYTICS_EVENTS` (name in `snake_case`, `version: 1`, `source`, `owner`, `trigger`, `props`).
2. Call `track('name', { ... })` in the browser or `captureServerEvent(env, 'name', memberId, { ... })` on the server; TypeScript enforces the property shape.
3. Add a row to the table above and a test case if the event has non-trivial properties.
4. Server events that must not be lost go through the analytics outbox (separate change), which stores the event `uuid` and retries `sendServerEvent()` with it so destinations de-duplicate.

## Verifying in production

PostHog → *Activity → Live events*, filtered to project Zuey.me:

1. `$pageview` from zuey.me shows a `$current_url` without sensitive parameters (try `/login/verify?token=test`).
2. After signing in and reloading, events carry the member id as `distinct_id`; after signing out, a new anonymous id.
3. With Do Not Track/GPC on, or after "Turn analytics off" on `/privacy#analytics`, no new events arrive from that browser.
