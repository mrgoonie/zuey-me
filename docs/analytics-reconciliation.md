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

### Membership, Dodo card (`order_type` = `membership`, `provider` = `dodo`)

```sql
SELECT CASE WHEN pe.event_id = 'charge:' || cs.first_payment_id THEN 'first' ELSE 'renewal' END AS kind,
       UPPER(pe.currency) AS currency, COUNT(*) AS purchases,
       SUM(CASE WHEN UPPER(pe.currency) IN ('VND', 'JPY', 'KRW') THEN pe.amount ELSE pe.amount / 100.0 END) AS amount
FROM payment_events pe
JOIN card_subscriptions cs ON cs.id = pe.card_subscription_id
WHERE pe.provider = 'dodo' AND pe.raw_type = 'payment.charge' AND cs.user_id IS NOT NULL
  AND pe.received_at >= :from AND pe.received_at < :to
GROUP BY kind, UPPER(pe.currency);
```

Key: `'purchase:dodo:' || substr(pe.event_id, 8)` (the payment id after `charge:`). PostHog `renewal` = `true` must equal the `renewal` row. `pe.amount` is in minor units of `pe.currency`; `amount` is converted to major units the way `toMajorUnits` does (VND, JPY and KRW have no minor unit). A charge in a currency other than USD is still a purchase (and also a `payment_needs_attention` with `amount_mismatch`), so it shows as its own currency row. The event time is Dodo's payment time while `received_at` is webhook time, so a charge near midnight can land on a different day (see tolerances).

### Courses (`order_type` = `course`)

```sql
WITH o AS (
  SELECT provider,
         CASE WHEN amount_paid IS NOT NULL AND COALESCE(currency_paid, '') <> '' THEN UPPER(currency_paid)
              WHEN provider = 'sepay' THEN 'VND' ELSE 'USD' END AS currency,
         CASE WHEN provider = 'sepay' THEN COALESCE(amount_paid, amount_vnd)
              ELSE COALESCE(amount_paid, amount_usd_cents) END AS amount_minor
  FROM course_orders
  WHERE paid_at IS NOT NULL AND status IN ('paid', 'refunded', 'charged_back')
    AND paid_at >= :from AND paid_at < :to
)
SELECT provider, currency, COUNT(*) AS purchases,
       SUM(CASE WHEN currency IN ('VND', 'JPY', 'KRW') THEN amount_minor ELSE amount_minor / 100.0 END) AS amount
FROM o WHERE amount_minor > 0 GROUP BY provider, currency;
```

Key: `'purchase:' || provider || ':course_order:' || id`. A refunded or charged-back order was still a purchase when paid, so it stays in the count. A fully discounted order (100 % promo) is stored as `paid` with `amount_paid = 0`; `queuePurchase` sends nothing for a zero amount, so `amount_minor > 0` keeps it out. The amount and currency follow `paidAmount()` in [`course-order-payments.ts`](../src/lib/courses/course-order-payments.ts): what was actually paid (`amount_paid` + `currency_paid`) when recorded, otherwise the price due on the order's rail (`amount_vnd` for SePay, `amount_usd_cents` for Dodo). So a card payment that landed on a SePay order and was granted by an admin is a `sepay` row in `USD`, and a non-USD Dodo charge is its own currency row; never add the rows of different currencies together.

### Bookings (`order_type` = `booking`)

```sql
-- Bookings that were confirmed with money (purchase count per rail and currency)
WITH b AS (
  SELECT bk.id, bk.payment_method, UPPER(bk.currency) AS currency,
         COALESCE((SELECT SUM(pe.amount) FROM payment_events pe
                   WHERE pe.booking_id = bk.id AND UPPER(pe.currency) = UPPER(bk.currency)),
                  bk.amount_paid, bk.amount_expected) AS amount_minor
  FROM bookings bk
  WHERE (bk.status = 'confirmed'
         OR (bk.status IN ('cancelled', 'needs_attention')
             AND (bk.attention_reason IS NULL OR bk.attention_reason = 'admin')
             AND (bk.amount_paid IS NOT NULL
                  OR EXISTS (SELECT 1 FROM payment_events pe WHERE pe.booking_id = bk.id))))
    AND bk.updated_at >= :from AND bk.updated_at < :to
)
SELECT payment_method, currency, COUNT(*) AS purchases,
       SUM(CASE WHEN currency IN ('VND', 'JPY', 'KRW') THEN amount_minor ELSE amount_minor / 100.0 END) AS amount
FROM b GROUP BY payment_method, currency;

-- Per booking: D1 payments vs the amount the outbox sent (exact amount check)
SELECT bk.id, bk.status, UPPER(bk.currency) AS currency,
       (SELECT SUM(pe.amount) FROM payment_events pe
        WHERE pe.booking_id = bk.id AND UPPER(pe.currency) = UPPER(bk.currency)) AS d1_paid_minor,
       json_extract(o.properties, '$.amount') AS outbox_amount, o.status AS outbox_status
FROM bookings bk
LEFT JOIN analytics_outbox o ON o.event = 'purchase' AND o.dedupe_key IN (
  'purchase:' || bk.payment_method || ':booking:' || bk.id,
  (SELECT 'purchase:' || pe.provider || ':' || pe.event_id FROM payment_events pe
   WHERE pe.booking_id = bk.id ORDER BY pe.id LIMIT 1))
WHERE bk.status IN ('confirmed', 'cancelled', 'needs_attention')
  AND bk.updated_at >= :from AND bk.updated_at < :to;
```

- **Which bookings count.** A confirmed booking is a purchase. So is one confirmed with money that an admin later cancelled (`cancel` never refunds) or marked for attention (`mark_attention` keeps the purchase and sets `attention_reason` to `admin` when it was empty). A booking flagged by a payment problem (`amount_mismatch` and the like) has no purchase until an admin resolves it.
- **Amount.** `bookings.amount_paid` holds only the last payment (each flagged payment overwrites it), while the purchase of an admin-resolved underpayment plus top-up sums every recorded payment in the booking's currency. So the query sums `payment_events.amount` per booking and currency, and falls back to `amount_paid`, then `amount_expected` (the price due, which an admin resolve with no recorded transaction sends).
- **Where the sum can differ.** Every webhook payment is recorded in `payment_events` before the booking is checked, so a payment arriving after confirmation (a duplicate transfer) is in the D1 sum but not in the purchase, and a resolve whose payments are all in another currency sends the first payment's currency. D1 then reads higher for that booking. Compare counts in aggregate and amounts with the second query, which sets each booking's D1 payments beside the outbox `amount` (major units; the outbox row is kept 30 days after `sent_at`).
- `payment_events.amount` and `amount_paid` are in minor units (PayPal USD cents, SePay VND as is); `amount` is converted to major units like the event.
- Keys use the provider transaction: `purchase:<provider>:<payment_events.event_id>` for the first recorded payment of the booking, or `purchase:<provider>:booking:<id>` for an admin resolve with no recorded transaction. `updated_at` only approximates the payment time (a later admin action moves it); use the first payment's `payment_events.received_at` for an exact window.

### Refunds and chargebacks (`refund`)

```sql
-- Dodo membership: money-back provider events
SELECT raw_type, UPPER(currency) AS currency, COUNT(*) AS n,
       SUM(CASE WHEN UPPER(currency) IN ('VND', 'JPY', 'KRW') THEN amount ELSE amount / 100.0 END) AS amount
FROM payment_events
WHERE provider = 'dodo' AND card_subscription_id IS NOT NULL
  AND raw_type IN ('refund.succeeded', 'dispute.lost')
  AND received_at >= :from AND received_at < :to
GROUP BY raw_type, UPPER(currency);

-- Courses: paid orders reversed in the window (amount = what was paid, as in the purchase query)
WITH o AS (
  SELECT provider, status,
         CASE WHEN amount_paid IS NOT NULL AND COALESCE(currency_paid, '') <> '' THEN UPPER(currency_paid)
              WHEN provider = 'sepay' THEN 'VND' ELSE 'USD' END AS currency,
         CASE WHEN provider = 'sepay' THEN COALESCE(amount_paid, amount_vnd)
              ELSE COALESCE(amount_paid, amount_usd_cents) END AS amount_minor
  FROM course_orders
  WHERE status IN ('refunded', 'charged_back') AND paid_at IS NOT NULL
    AND updated_at >= :from AND updated_at < :to
)
SELECT provider, status, currency, COUNT(*) AS n,
       SUM(CASE WHEN currency IN ('VND', 'JPY', 'KRW') THEN amount_minor ELSE amount_minor / 100.0 END) AS amount
FROM o GROUP BY provider, status, currency;
```

A course order that was never paid (`paid_at` NULL, for example a flagged order an admin refunded) never had a `purchase` and gets no `refund`, so it is excluded. The course amount is the paid amount; a partial refund reported by the provider sends its own smaller `amount` with `partial: true`, so compare course refund counts exactly and amounts only as an upper bound.

Keys: `refund:dodo:refund:<refund id>` and `refund:dodo:dispute_lost:<dispute id>` for memberships; `refund:<provider>:course_order:<id>:refunded` or `…:charged_back` for courses; `refund:paypal:<event id>` for bookings.

- A course is set to `charged_back` as soon as a dispute opens, but `refund` is sent only when the dispute is lost (`dispute.accepted`, `dispute.lost`, `dispute.expired`). Count `charged_back` rows whose `refund` is missing as open disputes, not as gaps.
- Dodo `dispute.opened` is stored in `payment_events` but is not a refund.
- **Membership gap ([#269](https://github.com/mrgoonie/zuey-me/issues/269)).** For memberships, Dodo `dispute.accepted` and `dispute.expired` are not handled (`DODO_REVERSAL_KINDS` in `src/lib/payments/dodo.ts` maps only `refund.succeeded`, `dispute.opened` and `dispute.lost`). Such a dispute leaves no `payment_events` row and no `refund`, so every check here reads clean. Until #269 ships, check accepted or expired membership disputes in the Dodo dashboard.
- PayPal booking reversals (`PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`) are not written to `payment_events`; the only D1 trace is the outbox row (30 days). Check older ones in the PayPal dashboard.
- SePay has no refund flow, so a manual bank refund appears nowhere; record it by hand.

### Subscriptions

```sql
-- Active access now, per plan (SUB-5)
SELECT plan, COUNT(*) AS active
FROM subscriptions
WHERE status = 'active' AND current_period_end > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
GROUP BY plan;

-- Access that ended in the window and was not renewed (a lower bound for subscription_expired)
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

`subscriptions.status` is not flipped by the clock, so "active" always means `current_period_end` in the future. `subscriptions.current_period_end` already includes the 24-hour card renewal grace (`recomputeSubscription` adds it), so the first query counts card plans in grace as active; only `card_subscriptions.current_period_end` is the provider's period end without grace.

`subscriptions` keeps one row per member and plan with the latest period end. A member whose access ended in the window and who then re-activated has moved out of the second query, but `subscription_expired` was still sent. So PostHog `subscription_expired` ≥ the second query, and the difference is re-activations; for an exact check, compare PostHog with the outbox `subscription_expired` rows (third query). `subscription_expired` never carries `provider` (neither `queueSubscriptionChange` nor the drain sweep sets it); [#275](https://github.com/mrgoonie/zuey-me/issues/275) tracks that.

`subscription_activated` and `subscription_renewed` are derived from the change in `current_period_end`, so check them through the outbox query (and then PostHog), not against a D1 count.

### Sign-ups and sign-ins

```sql
SELECT COUNT(*) AS users FROM users WHERE created_at >= :from AND created_at < :to;

SELECT event, status, COUNT(*) AS n FROM analytics_outbox
WHERE event IN ('sign_up', 'login') AND occurred_at >= :from AND occurred_at < :to
GROUP BY event, status;
```

Key: `'sign_up:' || users.id`. Deleted accounts (`deleted_at` set) still count.

## Step 3: find the missing rows

Aggregates tell you that something is off; these show which fact. They are valid only for facts newer than the first outbox row (2026-10-11 16:20 UTC) and whose outbox row was not yet purged (30 days after `sent_at`).

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
  AND CASE WHEN co.provider = 'sepay' THEN COALESCE(co.amount_paid, co.amount_vnd)
           ELSE COALESCE(co.amount_paid, co.amount_usd_cents) END > 0
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

-- SePay prepaid still covering today (approximate: stacked renewals start at the previous end, and
-- SQLite '+N months' rolls past a month end, e.g. Jan 31 + 1 month = Mar 3, while the code clamps to Feb 28,
-- so an order paid near a month end can be off by up to 3 days)
SELECT plan, COUNT(*) AS orders, SUM(COALESCE(amount_paid, amount_vnd) * 1.0 / months) AS vnd_per_month
FROM billing_orders
WHERE status = 'paid'
  AND strftime('%Y-%m-%dT%H:%M:%fZ', datetime(paid_at, '+' || months || ' months'))
      > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
GROUP BY plan;
```

## GA4 (once `GA4_API_SECRET` is set)

The GA4 destination ([catalog, GA4 destination](analytics-events.md#ga4-destination)) posts the server `purchase` and `refund` through the Measurement Protocol, once PostHog has accepted the outbox row. Both carry `transaction_id` = `tx_` + 24 hex characters (the first 12 bytes of a SHA-256) of `<provider>:<transaction>` (`ecommerceTransactionId` in `commerce-events.ts`); the same value is the `transaction_id` property on the PostHog event, so a GA4 transaction joins to PostHog on it. Check 48 hours after the window closes (GA4 processing delay):

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
| PostHog `subscription_expired` vs outbox `subscription_expired` | exact if the drain ran at least once every 3 days | 1 drain cycle |
| PostHog `subscription_expired` vs D1 ended access | PostHog ≥ D1; the difference is members who re-activated in or after the window | 1 drain cycle |
| PostHog `purchase` vs GA4 transactions | ±2 % or ±1, whichever is larger; GA4 refunds ≤ PostHog refunds | 48 hours |
| Client funnel steps vs D1 orders (for example `checkout_created` vs `billing_orders` created) | no fixed target: the ratio is the consent coverage; watch the trend, alert on a drop of more than 20 points week over week | — |

## When the numbers do not match

1. **D1 fact without an outbox row.** A code path forgot to queue the event, or queued it with another key. Find the writer (`queuePurchase`, `queueRefund`, `queueSubscriptionChange` in [`src/lib/analytics/commerce-events.ts`](../src/lib/analytics/commerce-events.ts)), open an issue with the row id and the expected key. Do not insert outbox rows by hand.
2. **Outbox rows pending or dead.** Read `last_error`: `rejected:*` is a property that failed the server allowlist (code bug, open an issue); HTTP 401/403 is a wrong `PUBLIC_POSTHOG_KEY`; 5xx is a PostHog outage and retries on its own. Requeue dead rows only after the cause is fixed and a time-travel restore point is recorded.
3. **Sent but missing in PostHog.** Check the project key belongs to project `597432`, that no ingestion filter drops the event, and that the PostHog query window uses the event timestamp (the fact's time), not ingestion time.
4. **Counts match, amounts differ.** Look for currency mixing (a sum without `GROUP BY currency`), a USD amount read as cents, or a Dodo amount that includes tax on one side only.
5. **A preview or local host appears.** The outbox row is written on every host, but the drain delivers only when its request host is `zuey.me` / `www.zuey.me` (catalog, "Preview gate"); elsewhere rows stay `pending`. A preview event in production data is a host-gate bug.
6. **Expirations missing.** The drain sweep looks back 3 days; if the scheduler Worker was down longer, the gap is expected and D1 remains the record.
7. **GA4 lower than PostHog.** Check `GA4_API_SECRET` and `PUBLIC_GA4_MEASUREMENT_ID` (catalog), and the 48-hour delay, before calling it a gap.

Record every confirmed gap as a GitHub issue (one issue per cause), with the query, the window and the row ids.

## Known exclusions

- Facts before the first outbox row (2026-10-11 16:20 UTC) never reached PostHog.
- Membership Dodo disputes that end `accepted` or `expired` produce no `payment_events` row and no `refund` until [#269](https://github.com/mrgoonie/zuey-me/issues/269) ships.
- `subscription_expired` has no `provider`, so it cannot be split by rail.
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
- Three paid SePay membership orders in the window, all paid before the first outbox row (last at 2026-10-11 06:53 UTC), so no `purchase` was expected and none exists. No Dodo charge, paid course order or paid booking in the window, and the outbox holds no `purchase`, `refund` or `subscription_*` row yet.
