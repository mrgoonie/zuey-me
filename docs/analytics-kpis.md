# Analytics KPI dictionary and PostHog dashboards

Business and product metrics for zuey.me, each defined on events and properties that exist in code. The event catalog is [analytics-events.md](analytics-events.md) (machine-readable source: `ANALYTICS_EVENTS` in [`src/lib/analytics/events.ts`](../src/lib/analytics/events.ts)); when a KPI here and the catalog disagree, the catalog and the code win. Checking these numbers against D1 and GA4 is covered in [analytics-reconciliation.md](analytics-reconciliation.md).

## Ground rules

- **Source of truth.** D1 and verified payment webhooks own accounts, money, subscriptions and access. PostHog owns behaviour (funnels, engagement, retention). A money or subscription KPI read from PostHog is a mirror of D1; when they disagree, D1 wins and the gap is a reconciliation finding, not a business number.
- **Time zone.** D1 stores UTC ISO-8601 strings and the PostHog project Zuey.me (id `597432`) runs in UTC. Every KPI uses UTC days, weeks (Monday start) and months unless a tile says otherwise. A Vietnamese calendar day (Asia/Saigon, UTC+7) starts at 17:00 UTC the day before; apply the same shift on both sides when comparing.
- **Currency.** `purchase` and `refund` carry `amount` in major units of the currency actually paid (`VND` as paid, `USD` cents / 100) and never convert it. Never sum `amount` across currencies: break down by `currency`. A USD total for reporting uses the rate stored with each order (`billing_orders.usd_vnd_rate`, `course_orders.usd_vnd_rate`, `bookings.usd_vnd_rate`), never today's rate.
- **Event time.** A server event's timestamp is its `occurred_at` (payment or provider time; see the outbox section of the catalog), not the time PostHog received it. Server events reach PostHog through the outbox drain every 5 minutes and may be retried for about 22 hours, so the last hour (the last day during an outage) is incomplete.

### Coverage caveats (apply to every client KPI)

| Caveat | Effect | Applies to |
|---|---|---|
| Do Not Track, Global Privacy Control, the `/privacy#analytics` opt-out, blocked localStorage | No client event at all from that browser | Every client event and `$pageview` |
| Server events ignore browser consent | `sign_up`, `login`, `purchase`, `refund`, `payment_*`, `subscription_*` arrive for everyone | Server events |
| Non-production hosts | The browser captures only on `zuey.me` / `www.zuey.me`; the server sends only for requests to those hosts | Both |
| Bots and crawlers | Counted in `$pageview` unless filtered with `$virt_is_bot` (PostHog traffic classification, present on client events) | Client events |
| Anonymous ids | One anonymous `distinct_id` per browser profile until `identify(member_id)`; a visitor with two browsers counts twice | Unique-visitor KPIs |
| Booking guests | Server booking events use a one-off `guest_…` id with `$process_person_profile: false`; join booking steps on counts, not on people | Booking KPIs |

Consequence: a client-side conversion rate is measured on the consenting population. A rate that mixes a client step with a server step (for example `begin_checkout` → `purchase`) is biased upward, because the server step also counts people the browser never reported. Label those "observed funnel" and take the true rate from D1.

### Standard filters

| Name | Filter | Use on |
|---|---|---|
| Production host | `$host` in `zuey.me`, `www.zuey.me` | Client events (server events have no `$host`) |
| Humans only | `$virt_is_bot` is not `true` | Client events |
| Members only | `$is_identified` = `true` | Client events of signed-in members |
| Settled revenue | `flagged` is not set (Dodo charges held for review carry `flagged: true`) | `purchase`, when a settled-only figure is wanted |

Owner test purchases are excluded by hand (see [Known exclusions](analytics-reconciliation.md#known-exclusions)).

### Verification status

Event names and properties below were checked on 2026-10-23 against `ANALYTICS_EVENTS`, the emitting code, and (read-only) the events seen in the PostHog project Zuey.me in the last 30 days.

- **Seen in PostHog:** `$pageview`, `$web_vitals`, `$exception`, `$rageclick`, `$identify`, every profile/growth event except `200lab_learning_path_click`, the sign-up and checkout funnel through `payment_initiated`, `booking_availability_viewed`, `booking_slot_selected`, the article, Reads and search events except `article_unlocked`, `app_opened`, `survey_submitted`, `feature_error`, `sign_up`, `login`.
- **Declared in code, not yet seen** (no occurrence in the window, so their tiles start empty): `purchase`, `refund`, `payment_failed`, `payment_needs_attention`, every `subscription_*` event, every `ai_*` event, `article_unlocked`, `booking_hold_created`, `booking_checkout_started`, `community_invite_requested`, `community_joined`, `command_palette_article`, `command_palette_video`, `200lab_learning_path_click`. `$dead_click` is not collected at all (dead-click capture comes from PostHog remote config, which the site disables).
- The three paid membership orders of that window were paid on 2026-10-09 and 2026-10-11, before the outbox shipped (2026-10-11), so no `purchase` was expected. `sign_up` (47) and `login` (15) matched the D1 outbox one for one; see the reconciliation runbook.

`session_utm_*` and `session_referrer` are added to events sent through `track()` only; `$pageview` (posthog-js automatic) does not carry them, so channel KPIs on page views use `$referring_domain`.

## KPI dictionary

Each KPI: definition, formula, source events with property filters, and caveats. IDs are stable; use them in dashboards and reviews.

### Acquisition and content

**ACQ-1 Unique visitors.** Distinct browsers that viewed a page.
- Formula: unique users of `$pageview` per period.
- Filters: Production host, Humans only.
- Caveats: consent coverage; anonymous ids per browser; members are merged into one person after `identify`.

**ACQ-2 Page views and sessions.** Volume of reading.
- Formula: total `$pageview`; sessions = `$pageview` with PostHog's unique-sessions math.
- Filters: Production host, Humans only.
- Caveats: ZueyOS window switches on `/` keep the path, so they are not page views; see PRD-5.

**ACQ-3 Traffic by channel.** Where visitors come from.
- Formula: ACQ-1 broken down by `$referring_domain` (`$direct` for none) on `$pageview`; for campaign codes, custom events broken down by `session_utm_source` / `session_utm_campaign` (first touch of the tab session, allowlisted slug values only).
- Caveats: the stored referrer is an origin only; UTM values that are not slug-like are dropped by design; click ids are ignored.

**ACQ-4 Article reach.** Readers who opened an article.
- Formula: unique users of `article_opened`, breakdown `slug`, `locale`, `access`.
- Caveats: once per page load; Studio previews excluded.

**ACQ-5 Article engagement rate.** Share of article opens that became a real read.
- Formula: unique users of `article_engaged` / unique users of `article_opened`, per `slug`, same period.
- Caveats: engaged = 30 visible seconds and 50 % of the readable body; a locked article (`locked: true`) has a shorter body.

**ACQ-6 Paywall conversion.** Readers who hit the lock box and went on to pick a plan.
- Formula: funnel `paywall_viewed` → `plan_selected` (14-day window), breakdown `slug` of step 1.
- Caveats: client-only funnel; `article_unlocked` counts members whose plan already covers the article and is not a conversion.

**ACQ-7 Affiliate and outbound clicks.** Clicks that leave the site to a partner.
- Formula: total `200lab_course_click`, `200lab_learning_path_click` (breakdown `slug`, `source`) and `link_clicked` (breakdown `section`, `id`).
- Caveats: a click is not a partner sale; affiliate revenue is not in PostHog.

### Sign-up and sign-in

**AUTH-1 New members.** Accounts created by a verified sign-in.
- Formula: total `sign_up` (server), breakdown `method` (`magic_link`, `google`, `github`).
- Source of truth: `users.created_at` in D1. Dedupe key `sign_up:<user id>`, so one event per account.
- Caveats: independent of consent; a deleted account keeps its row in D1 and its event in PostHog.

**AUTH-2 Sign-up completion.** Share of started sign-ins that created an account.
- Formula: funnel `sign_up_started` → `sign_up` (1-day window), breakdown `method` of step 1.
- Caveats: `sign_up_started` also fires for existing members (one form signs up and signs in), so this understates completion for new visitors; the server step joins the browser only after `identify()` merges the anonymous id, so a magic link opened on another device is not joined.

**AUTH-3 Returning sign-ins.** Existing members signing in.
- Formula: total and unique users of `login` (server), breakdown `method`.
- Caveats: one event per session (`login:<session id>`), so a long-lived session counts once.

**AUTH-4 Auth failure rate.** Sign-in attempts that failed.
- Formula: total `auth_failed` / total `sign_up_started`, breakdown `stage`, `reason`.
- Caveats: client-only; `reason` is the API error code.

**AUTH-5 Magic links requested.** Accepted sign-in link requests.
- Formula: total `magic_link_requested`. Email delivery itself is logged in D1 `email_log`, not in PostHog.

### Commerce

**COM-1 Membership checkout funnel.** Path from the pricing table to payment.
- Formula: funnel `pricing_viewed` → `plan_selected` → `begin_checkout` → `checkout_created` → `payment_initiated` → `purchase`, steps 3–6 filtered on `order_type` = `membership`, 7-day window, breakdown `plan`, `provider` or `months`.
- Caveats: steps 1–5 are client (consent), step 6 is server; creating an order needs a signed-in member, so steps 4–6 are identified; a fully discounted order (`free: true` on `checkout_created`) has no `payment_initiated` and no `purchase` (a 0 VND grant is not a purchase). The true created-to-paid rate comes from D1 (see the runbook).

**COM-2 Course checkout funnel.** Same as COM-1 for courses.
- Formula: `begin_checkout` → `checkout_created` → `payment_initiated` → `purchase`, all with `order_type` = `course`; breakdown `provider` (`course` slug exists on the client steps only).

**COM-3 Purchases.** Verified paid transactions.
- Formula: total `purchase`, breakdown `order_type`, `provider`, `renewal`.
- Source of truth: D1 `billing_orders`, `payment_events` (Dodo `payment.charge` rows), `course_orders`, `bookings`.
- Caveats: one event per provider transaction (dedupe key `purchase:<provider>:<transaction>`); a Dodo charge held for review is included with `flagged: true`.

**COM-4 Gross revenue.** Money collected, by currency.
- Formula: sum of `amount` on `purchase`, breakdown `currency` (then `order_type`). Never add VND and USD.
- Caveats: tax included (what the customer paid); a SePay prepaid order is cash at payment time, not monthly revenue (see SUB-6).

**COM-5 Refunds and chargebacks.** Money that went back.
- Formula: total and sum of `amount` on `refund`, breakdown `currency`, `reason` (`refund` | `chargeback`), `order_type`, `partial`.
- Caveats: an opened dispute is not a refund, only a lost one; SePay bank transfers have no refund flow in code, so a manual SePay refund is not tracked anywhere; `amount` is missing when the provider did not report it.

**COM-6 Net revenue.** COM-4 minus COM-5, per currency.
- Caveats: a refund lands in the period it happened, not in the period of the purchase it reverses.

**COM-7 Refund rate.** Sum of `refund.amount` / sum of `purchase.amount`, per currency, trailing 90 days.

**COM-8 Average order value.** COM-4 / COM-3 per currency and `order_type`, with `renewal` = `false`.

**COM-9 Payment problems.** Failed and flagged payments.
- Formula: total `payment_failed` (Dodo; breakdown `order_type`, `plan`) and total `payment_needs_attention` (breakdown `provider`, `reason`).
- Caveats: `reason` values include `amount_mismatch`, `late_payment`, `metadata_missing`, `metadata_mismatch`, `promo_discount_not_applied`, `referral_discount_not_applied`; each occurrence is keyed by the provider event, so a retried webhook does not double count.

**COM-10 Booking funnel.** Consultation booking steps.
- Formula: funnel `booking_availability_viewed` → `booking_slot_selected` → `booking_hold_created` → `booking_checkout_started` (client), breakdown `payment_method` of step 3; paid bookings = total `purchase` with `order_type` = `booking`.
- Caveats: a paid booking uses a guest id, so it cannot be a funnel step; compare counts per period instead.

### Subscriptions

Plans: `knowledges`, `ai`, `combo`, `community`. Rails: `sepay` (prepaid 1, 3, 6 or 12 months) and `dodo` (monthly card subscription).

**SUB-1 Activations.** A plan becomes active for a member without active access.
- Formula: total `subscription_activated`, breakdown `plan`, `provider`.
- Caveats: a member who returns after a lapse activates again (the key includes the new period end).

**SUB-2 Renewals.** Active access extended by at least 7 days.
- Formula: total `subscription_renewed`, breakdown `plan`, `provider`.
- Caveats: a SePay member paying early is a renewal; card grace moves under 7 days are not.

**SUB-3 Cancellations.** Card subscriptions set to end, or ended by the provider.
- Formula: total `subscription_cancel_scheduled` and `subscription_cancelled`, breakdown `plan` (provider is always `dodo`).

**SUB-4 Expirations.** Active access that ended.
- Formula: total `subscription_expired`, breakdown `plan`, `provider` (absent on prepaid expiries found by the drain sweep).
- Caveats: prepaid expiries are found by the outbox drain looking back 3 days; a drain outage longer than that loses them in PostHog (D1 still has `subscriptions.current_period_end`).

**SUB-5 Active subscribers (point in time).** Members with active access to a plan now.
- Formula (D1 only): `SELECT plan, COUNT(*) FROM subscriptions WHERE status = 'active' AND current_period_end > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') GROUP BY plan`.
- Caveats: PostHog cannot rebuild this from events (activations minus expirations drifts with reactivations and the sweep window). `subscriptions.status` is not flipped by the clock, so always compare `current_period_end` with now.

**SUB-6 Recurring and prepaid revenue.** The split between card MRR and SePay prepaid money.
- Card MRR (D1): sum of `card_subscriptions.amount_cents` / 100 over `status = 'active'`, per `currency` (USD). Each card charge covers one month (`months: 1` on its `purchase`).
- Prepaid recognized revenue (D1): each paid SePay membership order spread straight-line, `COALESCE(amount_paid, amount_vnd) / months` VND for every month it covers. The cash view is COM-4.
- Caveats: the access end of stacked SePay orders starts at `max(paid_at, previous end)`, so a coverage window starting at `paid_at` approximates members who prepaid ahead. Queries: [Revenue views](analytics-reconciliation.md#revenue-views).

**SUB-7 Churn rate.** Monthly share of active subscribers who lost access.
- Formula (D1): plans whose `current_period_end` fell inside the month and were not active at month end / SUB-5 at month start. PostHog proxy: SUB-4 / SUB-5.

### Product engagement

**PRD-1 Value actions.** The actions that count as getting value, used by PRD-2 to PRD-4: `ai_response_completed`, `article_engaged`, `read_source_clicked`, `survey_submitted`, `community_joined`, `knowledge_search` with `results` > 0, and `purchase`. `login`, `$pageview` and `app_opened` alone are not value.
- PostHog setup: one action "Value action" matching those events (to be created with the dashboards).

**PRD-2 Activation rate.** New members who got value within 7 days.
- Formula: members with `sign_up` who perform a PRD-1 event within 7 days / members with `sign_up`, weekly cohorts.
- Caveats: client value actions need consent, so a member with analytics off counts as not activated; also report the rate among members with at least one client event (the consent-covered cohort).

**PRD-3 Retention.** Members coming back to value.
- Formula: PostHog retention, start event `sign_up`, return event "Value action", day 1 / 7 / 30 and weekly.
- Caveats: same consent bias as PRD-2.

**PRD-4 Active members and stickiness.** DAU, WAU, MAU of identified members.
- Formula: unique users of "Value action" with `$is_identified` = `true` (client) plus `purchase`, per day / week / month; stickiness = DAU / MAU.

**PRD-5 Feature adoption.** Which surfaces are used.
- Formula: unique users of `app_opened` breakdown `app` (ZueyOS windows; `source` = `webmcp` marks agent opens and is excluded), of `knowledge_search` breakdown `surface`, of `reads_opened`, and of `ai_chat_started` breakdown `surface`.

**PRD-6 Search success.** Searches that found something.
- Formula: 1 − (total `knowledge_search` with `results` = 0 / total `knowledge_search`), breakdown `surface`; filter usage = total `knowledge_filter_applied` breakdown `filter`.
- Caveats: the query text is never collected, only `query_length`.

**PRD-7 Community and surveys.** Funnel `community_invite_requested` → `community_joined` (breakdown `chat`), and total `survey_submitted` (breakdown `slug`).
- Caveats: `community_joined` is seen by the browser only when the member returns to the tab.

### UX, reliability and AI

**UX-1 AI answer success rate.** Questions that got a full answer.
- Formula: total `ai_response_completed` / total `ai_message_submitted`, breakdown `surface`; failures = `ai_response_failed` breakdown `stage`, `reason`, `retryable`.
- Caveats: a stop by the member is a failure with `reason` = `cancelled`; exclude it for a reliability view.

**UX-2 AI latency.** p50 and p95 of `latency_ms` on `ai_response_completed` (measured by the server), breakdown `surface`.

**UX-3 AI cost and tokens.** Sum of `cost_cents` / 100 (USD estimate counted against plan budgets), sums of `prompt_tokens` and `completion_tokens` on `ai_response_completed`; cost per answer = sum `cost_cents` / total.
- Caveats: a backend estimate, not the provider invoice; only consenting browsers report it.

**UX-4 AI quota hits.** Total `ai_quota_reached`, breakdown `kind` (`requests` | `budget`), `stage`. An upsell and capacity signal.

**UX-5 Feature error rate.** Total `feature_error`, breakdown `feature`, `reason`; rate per feature = errors / uses (for example `feature` = `ai_chat` over `ai_message_submitted`).

**UX-6 Unhandled errors.** Total `$exception`, breakdown `$pathname`; messages are cut, and redacted on private pages and while the AI panel is open.

**UX-7 Core Web Vitals.** p75 of `$web_vitals_LCP_value` (good ≤ 2500 ms), `$web_vitals_INP_value` (good ≤ 200 ms) and `$web_vitals_CLS_value` (good ≤ 0.1), breakdown `$pathname`; `$web_vitals_FCP_value` as secondary.
- Caveats: one `$web_vitals` event carries only the metrics ready when sent, so each metric has its own sample; plot CLS on its own axis.

**UX-8 Frustration.** Total `$rageclick` per 1 000 `$pageview`, breakdown `$pathname`. Dead clicks are not collected.

## PostHog dashboards

Specs for six dashboards in project Zuey.me (`https://us.posthog.com/project/597432`). **Status: specified, not created.** On 2026-10-23 the project held only the default "Your starter dashboard" (id `2071774`), and the money, subscription and AI events had no occurrences yet, so their tiles could not be checked against data. Create the dashboards in the PostHog UI (or with the PostHog MCP `dashboard-create` and `insight-create` tools) once `purchase` and `subscription_activated` have arrived, and record each id below. Never edit or delete the starter dashboard or any other existing object.

| Dashboard | PostHog id |
|---|---|
| Acquisition | not created |
| Auth | not created |
| Commerce | not created |
| Subscriptions | not created |
| Product | not created |
| UX & AI | not created |

Conventions for every tile: last 30 days unless noted, interval day, and the Production host and Humans only filters on client-event series. Server-event series take no host or bot filter. Money tiles always break down by `currency`.

### Acquisition

| Tile | Type | Series and filters | Breakdown / display |
|---|---|---|---|
| Unique visitors (ACQ-1) | Trends | `$pageview`, unique users | Line |
| Page views and sessions (ACQ-2) | Trends | `$pageview` total; `$pageview` unique sessions | Line |
| Visitors by referring domain (ACQ-3) | Trends | `$pageview`, unique users | `$referring_domain`, top 10, bar |
| Campaign first touch (ACQ-3) | Trends | `article_opened`, `pricing_viewed`, unique users | `session_utm_source`, table |
| Article reach (ACQ-4) | Trends | `article_opened`, unique users | `slug`, table, top 20 |
| Article engagement (ACQ-5) | Trends, formula `B / A` | A `article_opened` unique users, B `article_engaged` unique users | `slug`, table |
| Paywall → plan (ACQ-6) | Funnel | `paywall_viewed` → `plan_selected`, 14 days | step-1 `slug` |
| Affiliate clicks (ACQ-7) | Trends | `200lab_course_click`, `200lab_learning_path_click`, `link_clicked`, total | Event, bar |

### Auth

| Tile | Type | Series and filters | Breakdown / display |
|---|---|---|---|
| New members (AUTH-1) | Trends | `sign_up` total | `method`, stacked bar |
| Sign-ins (AUTH-3) | Trends | `login` total and unique users | `method`, line |
| Sign-up completion (AUTH-2) | Funnel | `sign_up_started` → `sign_up`, 1 day | step-1 `method` |
| Auth failure rate (AUTH-4) | Trends, formula `B / A` | A `sign_up_started` total, B `auth_failed` total | Line |
| Failure reasons (AUTH-4) | Trends | `auth_failed` total | `stage`, `reason`, table |
| Magic links requested (AUTH-5) | Trends | `magic_link_requested` total | Line |

### Commerce

| Tile | Type | Series and filters | Breakdown / display |
|---|---|---|---|
| Membership checkout funnel (COM-1) | Funnel | `pricing_viewed` → `plan_selected` → `begin_checkout` → `checkout_created` → `payment_initiated` → `purchase`; steps 3–6 [`order_type` = `membership`]; 7 days | `plan` |
| Course checkout funnel (COM-2) | Funnel | `begin_checkout` → `checkout_created` → `payment_initiated` → `purchase`, each [`order_type` = `course`]; 7 days | `provider` |
| Purchases (COM-3) | Trends | `purchase` total | `order_type`, stacked bar, interval week |
| Gross revenue (COM-4) | Trends | `purchase`, property sum `amount` | `currency`, then `order_type`; one tile per currency if the scales differ too much |
| New vs renewal (COM-3) | Trends | `purchase` total | `renewal`, bar |
| Refunds (COM-5) | Trends | `refund` total; `refund`, property sum `amount` | `currency`, `reason` |
| Payment problems (COM-9) | Trends | `payment_failed` total; `payment_needs_attention` total | `reason`, table |
| Booking funnel (COM-10) | Funnel | `booking_availability_viewed` → `booking_slot_selected` → `booking_hold_created` → `booking_checkout_started`, 1 day | step-3 `payment_method` |
| Paid bookings (COM-10) | Trends | `purchase` [`order_type` = `booking`] total | `provider` |

### Subscriptions

| Tile | Type | Series and filters | Breakdown / display |
|---|---|---|---|
| Activations (SUB-1) | Trends | `subscription_activated` total | `plan`, stacked bar, interval week |
| Activations by rail (SUB-1) | Trends | `subscription_activated` total | `provider` |
| Renewals (SUB-2) | Trends | `subscription_renewed` total | `plan` |
| Cancellations (SUB-3) | Trends | `subscription_cancel_scheduled`, `subscription_cancelled`, total | `plan` |
| Expirations (SUB-4) | Trends | `subscription_expired` total | `plan` |
| Activation → renewal | Funnel | `subscription_activated` → `subscription_renewed`, 45 days | `plan` (fits monthly terms; prepaid terms renew later) |
| Note | Text | "Active subscribers, MRR and churn rate come from D1 (SUB-5 to SUB-7); see the reconciliation runbook." | — |

### Product

| Tile | Type | Series and filters | Breakdown / display |
|---|---|---|---|
| Activation (PRD-2) | Funnel | `sign_up` → action "Value action", 7 days | Conversion over time, weekly |
| Retention (PRD-3) | Retention | Start `sign_up`, return "Value action", weekly, 8 periods | — |
| Active members (PRD-4) | Trends | "Value action" unique users [`$is_identified` = `true`] | DAU, WAU, MAU series |
| Stickiness (PRD-4) | Stickiness | "Value action", 30 days | — |
| ZueyOS apps (PRD-5) | Trends | `app_opened` unique users [`source` is not set] | `app`, bar |
| Search success (PRD-6) | Trends, formula `1 - B / A` | A `knowledge_search` total, B `knowledge_search` [`results` = 0] total | `surface` |
| Filters used (PRD-6) | Trends | `knowledge_filter_applied` total | `filter` |
| Reads source clicks | Trends | `read_source_clicked` total | `domain`, top 10 |
| Community and surveys (PRD-7) | Trends | `community_invite_requested`, `community_joined`, `survey_submitted`, total | Event |

### UX & AI

| Tile | Type | Series and filters | Breakdown / display |
|---|---|---|---|
| AI answer success (UX-1) | Trends, formula `B / A` | A `ai_message_submitted` total, B `ai_response_completed` total | `surface` |
| AI failures (UX-1) | Trends | `ai_response_failed` total [`reason` ≠ `cancelled`] | `reason` |
| AI latency (UX-2) | Trends | `ai_response_completed`, p50 and p95 of `latency_ms` | `surface`, y-axis milliseconds |
| AI cost (UX-3) | Trends | `ai_response_completed`, property sum `cost_cents` | Line (÷ 100 for USD) |
| Quota hits (UX-4) | Trends | `ai_quota_reached` total | `kind` |
| Feature errors (UX-5) | Trends | `feature_error` total | `feature`, then `reason` |
| Unhandled errors (UX-6) | Trends | `$exception` total | `$pathname` |
| Web vitals p75 (UX-7) | Trends | `$web_vitals`, p75 of `$web_vitals_LCP_value` and `$web_vitals_INP_value` | `$pathname`, top 10; CLS in its own tile |
| Rage clicks (UX-8) | Trends, formula `B / A * 1000` | A `$pageview` total, B `$rageclick` total | `$pathname` |

### Alerts

Add PostHog insight alerts on these tiles once they hold data (checked daily, notify the owner):

| Alert | Tile | Condition |
|---|---|---|
| Sign-ups stopped | New members | 0 for 2 consecutive days |
| Purchases stopped | Purchases | 0 for 7 days while the runbook's D1 check shows paid orders |
| Payment problems spike | Payment problems | `payment_needs_attention` ≥ 3 in one day |
| AI failing | AI answer success | Below 0.9 on a day with at least 20 questions |
| Feature errors spike | Feature errors | More than 3 × the trailing 7-day daily mean |

Outbox delivery health is already monitored by the scheduler Worker (catalog, Server event outbox → Monitoring); a PostHog alert does not replace it.
