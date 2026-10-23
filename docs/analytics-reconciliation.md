# Analytics reconciliation runbook (D1, PostHog, GA4)

How to check that the money, account and subscription numbers in PostHog (and later GA4) match D1, how much variance is acceptable, and what to do when they do not. KPI definitions are in [analytics-kpis.md](analytics-kpis.md); event properties and the outbox design are in [analytics-events.md](analytics-events.md#server-event-outbox).

## Principles

- **D1 wins.** D1 rows written by verified webhooks and the admin tools are the facts. PostHog and GA4 are mirrors; a gap is a delivery or code bug to explain, never a reason to correct D1.
- **Three layers, one key.** Every server event is first written to `analytics_outbox` with a deterministic `dedupe_key`, then delivered to PostHog with the outbox `id` as the event `uuid`, then (best effort) to GA4. So each fact can be followed row by row: D1 fact → `analytics_outbox.dedupe_key` → PostHog `uuid` → GA4 `transaction_id` (the `transaction_id` property that `purchase` and `refund` also carry in PostHog).
- **Read-only.** Every query in this runbook is a `SELECT`. The only write ever needed is requeueing dead outbox rows (catalog, Server event outbox → Monitoring), and that needs a restore point first (`wrangler d1 time-travel info zuey_me_db`, see [AGENTS.md](../AGENTS.md)).

## How to run the queries

**D1.** From the repository root, with the DNS-owning account's credentials from `.env` exported (never printed) and no `wrangler login` fallback:

```powershell
# PowerShell: load the two variables without echoing them
Get-Content .env | Where-Object { $_ -match '^(CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_TOKEN)=' } |
  ForEach-Object { $k, $v = $_ -split '=', 2; Set-Item "env:$k" $v.Trim('"') }
npx wrangler d1 execute zuey_me_db --remote --json --command "SELECT ..."
```

Inside the repo, `zuey_me_db` resolves to the production `database_id` in `wrangler.toml`.

- Timestamps are ISO-8601 UTC strings (`2026-10-23T09:15:00.000Z`). Compare them with the same format: `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')`, never `datetime('now')` (its space-separated form sorts before the `T` form on the same day).
- D1 rejects a compound `SELECT` with many terms; keep `UNION ALL` to four terms or split the query.
- Replace the window bounds `:from` / `:to` with ISO literals, for example `'2026-10-01T00:00:00.000Z'`.

**PostHog.** Project Zuey.me (`597432`, UTC). Use the SQL editor (HogQL) or the PostHog MCP `execute-sql` tool:

```sql
SELECT properties.order_type, properties.provider, properties.currency,
       count() AS purchases, sum(toFloat(properties.amount)) AS amount
FROM events
WHERE event = 'purchase'
  AND timestamp >= toDateTime(:from) AND timestamp < toDateTime(:to)
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
```

Swap `purchase` for `refund` (group by `properties.reason` too), `sign_up`, or `subscription_activated` as needed. The row-level join uses `uuid`, which equals `analytics_outbox.id`.

## Step 1: outbox health

Run first; a backlog explains most gaps.

```sql
-- Status per event (last 30 days of facts)
SELECT event, status, COUNT(*) AS n
FROM analytics_outbox
WHERE occurred_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
GROUP BY event, status ORDER BY event, status;

-- Dead rows and why
SELECT id, event, dedupe_key, attempts, last_error, occurred_at
FROM analytics_outbox WHERE status = 'dead' ORDER BY occurred_at DESC LIMIT 50;

-- Stuck: pending or sending for more than an hour
SELECT id, event, dedupe_key, status, attempts, next_attempt_at, last_error
FROM analytics_outbox
WHERE status IN ('pending', 'sending')
  AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')
ORDER BY created_at LIMIT 50;
```

Expected: no `dead` rows, and no `pending` row older than one drain cycle unless PostHog is failing (then `attempts` > 0 and `last_error` says why). Sent rows are purged 30 days after `sent_at`, so the outbox can only prove delivery for the last 30 days.

## Step 2: D1 facts per stream

Each block gives the D1 fact, the dedupe key the code builds for it, and the PostHog filter it must match.

### Membership, SePay (`purchase`, `order_type` = `membership`, `provider` = `sepay`, `currency` = `VND`)

```sql
SELECT COUNT(*) AS purchases, SUM(COALESCE(amount_paid, amount_vnd)) AS vnd
FROM billing_orders
WHERE status = 'paid' AND COALESCE(amount_paid, amount_vnd) > 0
  AND paid_at >= :from AND paid_at < :to;
```

Key: `'purchase:sepay:billing_order:' || id`. An order with `status = 'needs_attention'` that an admin later resolves becomes `paid` and is purchased then; a fully discounted order (0 VND) never emits `purchase`.

### Membership, Dodo card (`order_type` = `membership`, `provider` = `dodo`, `currency` = `USD`)

```sql
SELECT CASE WHEN pe.event_id = 'charge:' || cs.first_payment_id THEN 'first' ELSE 'renewal' END AS kind,
       COUNT(*) AS purchases, SUM(pe.amount) / 100.0 AS usd
FROM payment_events pe
JOIN card_subscriptions cs ON cs.id = pe.card_subscription_id
WHERE pe.provider = 'dodo' AND pe.raw_type = 'payment.charge' AND cs.user_id IS NOT NULL
  AND pe.received_at >= :from AND pe.received_at < :to
GROUP BY kind;
```

Key: `'purchase:dodo:' || substr(pe.event_id, 8)` (the payment id after `charge:`). PostHog `renewal` = `true` must equal the `renewal` row. `pe.amount` is in cents. The event time is Dodo's payment time while `received_at` is webhook time, so a charge near midnight can land on a different day (see tolerances).

### Courses (`order_type` = `course`)

```sql
SELECT provider, COUNT(*) AS purchases,
       SUM(CASE WHEN provider = 'sepay' THEN COALESCE(amount_paid, amount_vnd) END) AS vnd,
       SUM(CASE WHEN provider = 'dodo' THEN amount_paid END) / 100.0 AS usd
FROM course_orders
WHERE paid_at IS NOT NULL AND status IN ('paid', 'refunded', 'charged_back')
  AND paid_at >= :from AND paid_at < :to
GROUP BY provider;
```

Key: `'purchase:' || provider || ':course_order:' || id`. A refunded or charged-back order was still a purchase when paid, so it stays in the count.

### Bookings (`order_type` = `booking`)

```sql
SELECT payment_method, currency, COUNT(*) AS purchases, SUM(amount_paid) AS amount
FROM bookings
WHERE status = 'confirmed' AND amount_paid > 0
  AND updated_at >= :from AND updated_at < :to
GROUP BY payment_method, currency;
```

Keys use the provider event: `purchase:<provider>:<payment_events.event_id>` for the webhook that confirmed it (join `payment_events.booking_id`), or `booking:<id>` for an admin resolve with no transaction. `updated_at` is only an approximation of payment time; use the `payment_events.received_at` of the confirming row for an exact window.

### Refunds and chargebacks (`refund`)

```sql
-- Dodo membership: money-back provider events
SELECT raw_type, COUNT(*) AS n, SUM(amount) / 100.0 AS usd
FROM payment_events
WHERE provider = 'dodo' AND card_subscription_id IS NOT NULL
  AND raw_type IN ('refund.succeeded', 'dispute.lost')
  AND received_at >= :from AND received_at < :to
GROUP BY raw_type;

-- Courses: orders reversed in the window
SELECT provider, status, COUNT(*) AS n
FROM course_orders
WHERE status IN ('refunded', 'charged_back')
  AND updated_at >= :from AND updated_at < :to
GROUP BY provider, status;
```

Keys: `refund:dodo:refund:<refund id>` and `refund:dodo:dispute_lost:<dispute id>` for memberships; `refund:<provider>:course_order:<id>:refunded` or `…:charged_back` for courses; `refund:paypal:<event id>` for bookings.

- A course is set to `charged_back` as soon as a dispute opens, but `refund` is sent only when the dispute is lost (`dispute.accepted`, `dispute.lost`, `dispute.expired`). Count `charged_back` rows whose `refund` is missing as open disputes, not as gaps.
- Dodo `dispute.opened` is stored in `payment_events` but is not a refund.
- PayPal booking reversals (`PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`) are not written to `payment_events`; the only D1 trace is the outbox row (30 days). Check older ones in the PayPal dashboard.
- SePay has no refund flow, so a manual bank refund appears nowhere; record it by hand.

### Subscriptions

```sql
-- Active access now, per plan (SUB-5)
SELECT plan, COUNT(*) AS active
FROM subscriptions
WHERE status = 'active' AND current_period_end > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
GROUP BY plan;

-- Access that ended in the window (compare with subscription_expired)
SELECT plan, COUNT(*) AS ended
FROM subscriptions
WHERE current_period_end >= :from AND current_period_end < :to
  AND current_period_end <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
GROUP BY plan;

-- Activations, renewals and cancellations that reached the outbox
SELECT event, json_extract(properties, '$.plan') AS plan, status, COUNT(*) AS n
FROM analytics_outbox
WHERE event LIKE 'subscription_%' AND occurred_at >= :from AND occurred_at < :to
GROUP BY event, plan, status;
```

`subscriptions.status` is not flipped by the clock, so "active" always means `current_period_end` in the future. Card access keeps a 24-hour grace period after `current_period_end`, so a card plan can show in the first query's complement for up to a day while still usable. `subscription_activated` and `subscription_renewed` are derived from the change in `current_period_end`, so check them through the outbox query (and then PostHog), not against a D1 count.

### Sign-ups and sign-ins

```sql
SELECT COUNT(*) AS users FROM users WHERE created_at >= :from AND created_at < :to;

SELECT event, status, COUNT(*) AS n FROM analytics_outbox
WHERE event IN ('sign_up', 'login') AND occurred_at >= :from AND occurred_at < :to
GROUP BY event, status;
```

Key: `'sign_up:' || users.id`. Deleted accounts (`deleted_at` set) still count.

## Step 3: find the missing rows

Aggregates tell you that something is off; these show which fact. They are valid only for facts newer than the outbox launch (first row 2026-10-11 16:20 UTC) and whose outbox row was not yet purged (30 days after `sent_at`).

```sql
-- Paid SePay membership orders with no purchase in the outbox
SELECT bo.id, bo.paid_at, COALESCE(bo.amount_paid, bo.amount_vnd) AS vnd
FROM billing_orders bo
WHERE bo.status = 'paid' AND COALESCE(bo.amount_paid, bo.amount_vnd) > 0
  AND bo.paid_at >= :from
  AND NOT EXISTS (SELECT 1 FROM analytics_outbox o
                  WHERE o.dedupe_key = 'purchase:sepay:billing_order:' || bo.id);

-- Dodo membership charges with no purchase
SELECT pe.event_id, pe.received_at, pe.amount
FROM payment_events pe JOIN card_subscriptions cs ON cs.id = pe.card_subscription_id
WHERE pe.provider = 'dodo' AND pe.raw_type = 'payment.charge' AND cs.user_id IS NOT NULL
  AND pe.received_at >= :from
  AND NOT EXISTS (SELECT 1 FROM analytics_outbox o
                  WHERE o.dedupe_key = 'purchase:dodo:' || substr(pe.event_id, 8));

-- Paid course orders with no purchase
SELECT co.id, co.provider, co.paid_at
FROM course_orders co
WHERE co.paid_at >= :from AND co.status IN ('paid', 'refunded', 'charged_back')
  AND NOT EXISTS (SELECT 1 FROM analytics_outbox o
                  WHERE o.dedupe_key = 'purchase:' || co.provider || ':course_order:' || co.id);

-- Members with no sign_up
SELECT u.id, u.created_at FROM users u
WHERE u.created_at >= :from
  AND NOT EXISTS (SELECT 1 FROM analytics_outbox o WHERE o.dedupe_key = 'sign_up:' || u.id);
```

Then compare the outbox with PostHog by id. List the sent ids in D1 (`SELECT id FROM analytics_outbox WHERE event = 'purchase' AND status = 'sent' AND occurred_at >= :from`) and look them up in PostHog:

```sql
SELECT toString(uuid) AS id, event, timestamp FROM events
WHERE uuid IN ('<id 1>', '<id 2>') -- paste the outbox ids
```

An id that is `sent` in D1 but absent in PostHog was accepted by the capture API and then dropped (wrong project key, ingestion filter, or a timestamp outside the query window).

## Revenue views

USD figures for reporting use the rate stored on each order, never today's rate. VND and USD stay separate in every query.

```sql
-- Card MRR now (USD), SUB-6
SELECT plan, currency, COUNT(*) AS subs, SUM(amount_cents) / 100.0 AS mrr
FROM card_subscriptions WHERE status = 'active' GROUP BY plan, currency;

-- SePay prepaid: cash in the window and straight-line monthly value of the orders paid
SELECT plan, months, COUNT(*) AS orders,
       SUM(COALESCE(amount_paid, amount_vnd)) AS vnd_cash,
       SUM(COALESCE(amount_paid, amount_vnd) * 1.0 / months) AS vnd_per_month,
       SUM(COALESCE(amount_paid, amount_vnd) * 1.0 / usd_vnd_rate) AS usd_at_order_rate
FROM billing_orders
WHERE status = 'paid' AND paid_at >= :from AND paid_at < :to
GROUP BY plan, months;

-- SePay prepaid still covering today (approximate: stacked renewals start at the previous end)
SELECT plan, COUNT(*) AS orders, SUM(COALESCE(amount_paid, amount_vnd) * 1.0 / months) AS vnd_per_month
FROM billing_orders
WHERE status = 'paid'
  AND strftime('%Y-%m-%dT%H:%M:%fZ', datetime(paid_at, '+' || months || ' months'))
      > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
GROUP BY plan;
```

## GA4 (once `GA4_API_SECRET` is set)

The GA4 destination ([catalog, GA4 destination](analytics-events.md#ga4-destination)) posts the server `purchase` and `refund` through the Measurement Protocol, once PostHog has accepted the outbox row. Both carry `transaction_id` = `tx_` + a 12-character SHA-256 of `<provider>:<transaction>` (`ecommerceTransactionId` in `commerce-events.ts`); the same value is the `transaction_id` property on the PostHog event, so a GA4 transaction joins to PostHog on it. Check 48 hours after the window closes (GA4 processing delay):

- Compare the GA4 report "Transactions" by day (GA4 MCP `ga4_run_report`, metrics `transactions`, `purchaseRevenue`, dimension `date`; add dimension `transactionId` for a row-level diff) with the PostHog `purchase` count for the same UTC days. GA4 reports in the property time zone; set it to UTC or shift the window.
- GA4 converts revenue to the property currency, so compare counts exactly and revenue only roughly.
- A refund without a known `transaction_id` is not sent to GA4, so GA4 refunds can be lower than PostHog.
- GA4 delivery is best effort (no retry once PostHog accepted), and enhanced measurement must stay off to avoid double page views.

## Tolerances

| Comparison | Acceptable | Wait before checking |
|---|---|---|
| D1 fact → outbox row (Step 3) | 0 missing | none |
| Outbox `sent` → PostHog `uuid` | exact | window ends at least 1 hour ago |
| Outbox `pending` with `attempts` > 0 | allowed while PostHog is failing; dead after ~22 hours | — |
| D1 aggregate vs PostHog aggregate, per currency | exact counts and amounts for the full window; ±1 event on each day boundary where `occurred_at` (provider time) and `received_at` differ | 1 hour |
| `subscription_expired` vs D1 ended access | exact if the drain ran at least once every 3 days | 1 drain cycle |
| PostHog `purchase` vs GA4 transactions | ±2 % or ±1, whichever is larger; GA4 refunds ≤ PostHog refunds | 48 hours |
| Client funnel steps vs D1 orders (for example `checkout_created` vs `billing_orders` created) | no fixed target: the ratio is the consent coverage; watch the trend, alert on a drop of more than 20 points week over week | — |

## When the numbers do not match

1. **D1 fact without an outbox row.** A code path forgot to queue the event, or queued it with another key. Find the writer (`queuePurchase`, `queueRefund`, `queueSubscriptionChange` in [`src/lib/analytics/commerce-events.ts`](../src/lib/analytics/commerce-events.ts)), open an issue with the row id and the expected key. Do not insert outbox rows by hand.
2. **Outbox rows pending or dead.** Read `last_error`: `rejected:*` is a property that failed the server allowlist (code bug, open an issue); HTTP 401/403 is a wrong `PUBLIC_POSTHOG_KEY`; 5xx is a PostHog outage and retries on its own. Requeue dead rows only after the cause is fixed and a time-travel restore point is recorded.
3. **Sent but missing in PostHog.** Check the project key belongs to project `597432`, that no ingestion filter drops the event, and that the PostHog query window uses the event timestamp (the fact's time), not ingestion time.
4. **Counts match, amounts differ.** Look for currency mixing (a sum without `GROUP BY currency`), a USD amount read as cents, or a Dodo amount that includes tax on one side only.
5. **A preview or local host appears.** Server events are sent only for requests to `zuey.me` / `www.zuey.me`; a preview event in production data is a host-gate bug.
6. **Expirations missing.** The drain sweep looks back 3 days; if the scheduler Worker was down longer, the gap is expected and D1 remains the record.
7. **GA4 lower than PostHog.** Check `GA4_API_SECRET` and `PUBLIC_GA4_MEASUREMENT_ID` (catalog), and the 48-hour delay, before calling it a gap.

Record every confirmed gap as a GitHub issue (one issue per cause), with the query, the window and the row ids.

## Known exclusions

- Facts before the outbox shipped (2026-10-11 15:17 UTC) never reached PostHog.
- Fully discounted (0 VND or 0 USD) orders grant access without a `purchase`.
- Dodo charges flagged for review are included with `flagged: true`; filter them for a settled-only figure.
- Booking guests have no person profile; booking revenue is compared on totals only.
- Owner test purchases are real D1 rows; list their order ids here when they happen and exclude them on both sides.

## Cadence

- **Weekly:** Step 1 and the Step 3 missing-row queries for the last 7 days.
- **Month close:** Step 2 aggregates for the calendar month (UTC) against PostHog, the revenue views, and GA4 once enabled. Keep the results in the month's report.

## Check log

**2026-10-23** (first run, last 30 days):

- Outbox: `sign_up` 47 sent, `login` 15 sent, no `pending` or `dead` rows. PostHog: `sign_up` 47, `login` 15. Exact match.
- D1 `users` created in the window: 47, every one with its `sign_up:<id>` outbox row.
- Three paid SePay membership orders in the window, all paid before the outbox shipped (last at 2026-10-11 06:53 UTC), so no `purchase` was expected and none exists. No Dodo charge, paid course order or paid booking in the window, and the outbox holds no `purchase`, `refund` or `subscription_*` row yet.
