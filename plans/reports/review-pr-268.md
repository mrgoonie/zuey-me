# Review: PR #268 — docs(analytics): KPI dictionary, PostHog dashboards and D1 reconciliation runbook

- Branch `docs/66-analytics-kpis` @ `6841426` (base `6864361`, 3 commits behind `origin/main`, docs-only, no conflicts touching these files)
- Files: `docs/analytics-kpis.md` (+325), `docs/analytics-reconciliation.md` (+306), `docs/analytics-events.md` (+2), `README.md` (+2/-2)
- Reviewer had no part in writing it. Read-only: nothing pushed, commented or merged.

## Verdict

The docs are carefully written and mostly accurate. Every event name and property I checked exists in `ANALYTICS_EVENTS` and its emitters. Every SQL table and column exists. All 23 D1 statements parse and run on SQLite built from all migrations, and every one is a plain `SELECT`. Links and anchors resolve, and the docs hold no secrets, emails or personal data. UTC is stated throughout, the Asia/Saigon shift is explained, and the dedupe keys match the code.

One query mixes currencies (major), and a few reconciliation queries and tolerances would report false gaps or hide real ones (minor). **Fix the major before merge. The minors can land in the same PR or a follow-up.**

## Verification evidence

| Check | Result |
|---|---|
| `bun test` | 1729 pass, 0 fail, 103 files |
| `bun run build` | `astro check` 0 errors, 0 warnings (70 hints), build Complete |
| Doc SQL on migrated SQLite (scratch script mirroring `tests/helpers/d1.ts`) | 23 statements OK, 0 failed, all `SELECT`. The 2 HogQL blocks were skipped (PostHog only) |
| Columns referenced (`billing_orders.usd_vnd_rate`, `course_orders.currency_paid`, `bookings.usd_vnd_rate`, `card_subscriptions.first_payment_id/amount_cents`, `payment_events.card_subscription_id`, `analytics_outbox.*`, `users.deleted_at`, …) | all present (`PRAGMA table_info`) |
| Dedupe keys vs code | `sign_up:<id>`, `login:<session>`, `purchase:sepay:billing_order:<id>`, `purchase:dodo:<payment id>` (`substr(event_id, 8)` correctly strips `charge:`), `purchase:<provider>:course_order:<id>`, `refund:dodo:refund:<id>` / `refund:dodo:dispute_lost:<id>`, `refund:<provider>:course_order:<id>:<kind>`, `refund:paypal:<event id>`: all match `commerce-events.ts` and its callers |
| Outbox facts (5-min cron, 10 attempts ≈ 22 h, 30-day purge, 3-day expiry sweep, uuid = row id) | match `outbox.ts`, `wrangler.toml` crons, catalog |
| Ship date 2026-10-11 15:17 UTC | matches commit `9d4849b` (22:17 +07:00) |
| Links / anchors (`#server-event-outbox`, `#ga4-destination`, `#known-exclusions`, `#revenue-views`, `../AGENTS.md`, source paths) | all resolve |
| Secrets / PII scan (`@`, key prefixes, UUIDs, GA ids) | none. PostHog project id `597432` is not a secret |
| Live numbers (47 `sign_up`, 15 `login`, dashboard id `2071774`, 3 pre-outbox orders) | not re-verified (I did not query production); treated as the author's recorded check |

## Findings

### Blocker

None.

### Major

**M1. Course purchase query mixes currencies and misses fallback amounts.** `docs/analytics-reconciliation.md:97-105`

The query picks the currency from `provider` and reads amounts only from `amount_paid`. The code picks both from the order itself (`paidAmount()` in `src/lib/courses/course-order-payments.ts:59-64`): `amount_paid` + `currency_paid` when set, and only otherwise `amount_vnd` (SePay) or `amount_usd_cents` (Dodo). This breaks in three ways:
- **USD added into VND.** A card payment that lands on a SePay order is flagged `provider_mismatch` (`course-payment-webhooks.ts:174-178`), and `markCourseOrderAttention` stores the USD cents in `amount_paid` with `currency_paid = 'USD'`. After an admin `grant`, the `purchase` is `provider: sepay, currency: USD`. The doc query adds those cents into the `vnd` sum. This is exactly the VND+USD mixing the doc warns against.
- **Non-USD Dodo charges summed as USD.** `underpaid` is only checked when `currency === 'USD'`, so a non-USD Dodo charge is paid with `currency_paid` = that currency, and the doc sums it as `usd`.
- **Fallback amounts dropped.** A paid Dodo order with `amount_paid` NULL emits a `purchase` with the `amount_usd_cents` fallback, but the doc's `usd` is NULL. Shown with seeded rows: `{provider: dodo, purchases: 1, usd: null}`.

Fix: group by `COALESCE(currency_paid, CASE provider WHEN 'sepay' THEN 'VND' ELSE 'USD' END)` and sum `COALESCE(amount_paid, CASE provider WHEN 'sepay' THEN amount_vnd ELSE amount_usd_cents END)`, dividing by 100 only for non-zero-decimal currencies.

### Minor

**m1. Membership dispute outcomes `dispute.accepted` / `dispute.expired` are not flagged.** `docs/analytics-reconciliation.md:123-130,140-143`, `docs/analytics-kpis.md:124`

The runbook correctly says courses report `refund` on accepted, lost or expired disputes. But it does not say that memberships handle only `dispute.lost`. `DODO_REVERSAL_KINDS` in `src/lib/payments/dodo.ts:395-400` maps only `refund.succeeded`, `dispute.opened` and `dispute.lost`. An accepted or expired membership dispute therefore leaves no `payment_events` row and no `refund`, and every check in this runbook reads as clean. The bug itself is filed separately. The doc should say it plainly, for example as a Known exclusion that links the issue.

**m2. "Access that ended" vs `subscription_expired` will not match exactly.** `docs/analytics-reconciliation.md:156-161,271`

`subscriptions` keeps one row per (user, plan) with the latest `current_period_end` (`ON CONFLICT (user_id, plan) DO UPDATE`, `src/lib/members/subscriptions.ts:131-134`). A member who expired inside the window and then re-activated has moved past the window in D1, but `subscription_expired` was still sent. The tolerance row "exact if the drain ran at least once every 3 days" will therefore raise false gaps. State "PostHog ≥ D1; the difference is re-activations", or count expiries from the outbox instead.

**m3. Card grace caveat describes the wrong column.** `docs/analytics-reconciliation.md:170`

`recomputeSubscription` already adds the 24-hour `CARD_RENEWAL_GRACE_MS` to `subscriptions.current_period_end` (`subscriptions.ts:59-70`). The SUB-5 query on `subscriptions` therefore already counts card plans in grace. A plan does not "show in the complement while still usable". The caveat applies only to `card_subscriptions.current_period_end`.

**m4. Course refund query counts orders that never produced a `refund`.** `docs/analytics-reconciliation.md:133-137`

`queueCourseMoneyBack` returns early when `paid_at IS NULL` (`course-order-payments.ts:160`). A flagged, never-paid order that an admin refunds becomes `status = 'refunded'`, is counted by the doc query, and has no event (seeded: doc query n=1, outbox `refund` rows 0). Add `AND paid_at IS NOT NULL`. The query also returns counts only, so COM-5/COM-6 refund amounts per currency cannot be reconciled for courses. Consider adding the amount and currency expression from M1.

**m5. Booking purchase query drops cancelled-after-confirm bookings and mixes units.** `docs/analytics-reconciliation.md:111-119`

- Admin `cancel` never refunds, and the `purchase` stays in PostHog. The doc's `status = 'confirmed'` filter drops the booking, so D1 reads lower than PostHog.
- An admin resolve with no recorded transaction emits `amount_paid ?? expected` (`booking/store.ts:989-992`). With `amount_paid` NULL, `amount_paid > 0` excludes it.
- `SUM(amount_paid)` is in minor units (PayPal USD cents) while PostHog `amount` is in major units. The doc says "/ 100" for Dodo but not here.
- Key text "`booking:<id>`" should read `purchase:<provider>:booking:<id>` (`store.ts:990`, `commerce-events.ts:82`).

**m6. Dodo membership charge query assumes USD.** `docs/analytics-reconciliation.md:83-93`

A non-USD charge is still purchased, flagged `amount_mismatch` (`dodo-billing.ts:521-532`), and the query labels the whole sum `usd`. Add `pe.currency` to the `SELECT` and `GROUP BY`.

**m7. `subscription_expired` never carries `provider`.** `docs/analytics-kpis.md:157`

The KPI says the breakdown `provider` is "absent on prepaid expiries found by the drain sweep". Neither emitter sets it: `queueSubscriptionChange` (`commerce-events.ts:232-238`) and `sweepExpiredSubscriptions` (`outbox.ts:300`). The breakdown is always empty, so drop it or say it is never set. The dashboard tile at `:281` already uses `plan` only.

**m8. PRD-4 definition and its tile disagree.** `docs/analytics-kpis.md:186` vs `:291`

The KPI says "Value action with `$is_identified` = true (client) plus `purchase`". The tile filters the whole action on `$is_identified = true`. Server `purchase` events have no `$is_identified`, so the tile drops them. Use two series, or filter only the client events.

### Nit

- `docs/analytics-reconciliation.md:256`: "a 12-character SHA-256". `ecommerceTransactionId` takes 12 **bytes**, i.e. `tx_` + 24 hex characters (`commerce-events.ts:51-56`).
- `docs/analytics-reconciliation.md:186` vs `:289`: the outbox boundary is given as "first row 16:20 UTC" in one place and "shipped 15:17 UTC" in another. 15:17 is the commit time, not the deploy time. Use one boundary, the first outbox row.
- `docs/analytics-reconciliation.md:245-251`: SQLite `'+N months'` overflows month ends (Jan 31 + 1 month → 2026-03-03, verified), while `addMonths` clamps to Feb 28. It is already labelled approximate. Mention that month-end orders can be off by up to 3 days.
- `docs/analytics-kpis.md:18`, `reconciliation.md:281`: "the server sends only for requests to those hosts". The outbox row is written either way. Delivery is gated by the drain request's host (catalog "Preview gate", `openapi.ts:28`). Say "delivers" or "drains" rather than "sends".
- `docs/analytics-kpis.md:19,30`: `$virt_is_bot` is a PostHog-side virtual property, which I could not verify from the repo. Confirm the exact property name in the project before the dashboards are built.

## Unresolved questions

1. Has Dodo adaptive pricing ever charged a course or membership in a currency other than USD in production? That decides how urgent M1 and m6 are.
2. Should the dashboards be created in this PR's issue (#66) once events arrive, or tracked as a separate issue? The doc says "specified, not created".

## Round 2 (head `ed1cb2f`)

The delta is docs only (`analytics-kpis.md` +7/-7, `analytics-reconciliation.md` +70/-36). I checked it on a fresh worktree using my own seeded cases (`round2-check.ts`, now deleted). Each case either called the real `queuePurchase` / `queueCourseMoneyBack` and compared the outbox with the doc query, or re-derived `paidAmount()` and `toMajorUnits()`. I did not re-run `bun test` or `bun run build` because no code changed since round 1 (1729 pass; 0 errors, 0 warnings).

### Re-verification

| Item | Result |
|---|---|
| All D1 SQL (21 statements incl. new `WITH` blocks) | parse and run on migrated SQLite, 0 failures, all read-only (`SELECT` / `WITH … SELECT`) |
| **M1** course purchase | Currency and amount expressions match `paidAmount()` (`course-order-payments.ts:59-64`): `currency_paid` only when `amount_paid` is set, otherwise the rail default; amount is `amount_paid`, else `amount_vnd` (SePay) or `amount_usd_cents` (Dodo); zero-decimal set same as `toMajorUnits`. Seeded cases matched the outbox for currency and amount, including a card on a SePay order (USD 52), a Dodo fallback (USD 39), Dodo VND and EUR, and a SePay grant with no `amount_paid`. One count gap remains (r2-1). **Fixed apart from r2-1** |
| VND/USD mixing anywhere | none left. Every money sum is grouped by currency (Dodo charges, Dodo refunds, courses, course refunds, bookings, card MRR). SePay membership and the revenue views are VND only by construction |
| m1 (#269) | flagged in COM-5, the Refunds section and Known exclusions; #269 is open with a matching title. **Fixed** |
| m2 | tolerance split into "outbox vs PostHog exact" and "PostHog ≥ D1 (re-activations)". **Fixed** |
| m3 | grace text now matches `subscriptions.ts:59-70`. **Fixed** |
| m4 | `paid_at IS NOT NULL` added. A seeded never-paid refunded order is excluded, and the refund matched the outbox (VND 450000). **Fixed** |
| m5 | Partly fixed (amount units, key text, cancelled-after-confirm and the `amount_expected` fallback are right); two cases remain (r2-2). Key `purchase:<provider>:booking:<id>` is now correct |
| m6 | grouped by `UPPER(pe.currency)`. Seeded USD and lowercase `vnd` charges gave 9.99 / 250000, matching `toMajorUnits`. **Fixed** |
| m7 | documented as never set (#275 filed). **Accepted** |
| m8 | separate "Member value action" with a per-step filter. **Fixed** |
| Nits | 24 hex characters, one boundary (first outbox row 16:20 UTC) used throughout, month-end caveat, drain host-gate wording. All fixed. The `$virt_is_bot` count (17 of 4 150) comes from the author's live check, which I did not re-verify |

### New findings

**Minor**

**r2-1. The course purchase count includes 100% promo orders.** `docs/analytics-reconciliation.md` (Courses query)

A free course order is stored `status = 'paid'`, `amount_paid = 0`, `paid_at` set (`src/lib/courses/course-orders.ts:294-296`). `queuePurchase` rejects `amountMinor <= 0` (`commerce-events.ts:78`), so it sends no `purchase`. The doc query still counts it. Seeded result: doc `sepay VND purchases 3` vs outbox `n 2`, with equal amounts. That is a false one-event gap, and it contradicts the Known exclusion. Fix: add `WHERE amount_minor > 0` to the outer `SELECT … FROM o`, as the SePay membership query already does with `> 0`.

**r2-2. The booking query still misses two cases the code counts.** `docs/analytics-reconciliation.md` (Bookings query and bullets)

Seeded result: doc 3 purchases / 130 USD vs code 4 / 200 USD.
- **(a) Mark-attention after confirm.** A confirmed booking that an admin later marks for attention becomes `needs_attention` with `attention_reason = 'admin'` (`booking/store.ts:1031`), and its `purchase` stands. `queueResolvedPurchase` treats this as `countedBefore` (`store.ts:995-996`), but the doc filter drops it. Fix: accept `status IN ('cancelled', 'needs_attention')` with `amount_paid` set and reason NULL/`admin`.
- **(b) Underpayment plus top-up.** For an underpayment followed by a top-up, `bookings.amount_paid` holds only the last payment (`markAttention` overwrites it, `store.ts:664`). The resolve `purchase` sums every recorded payment in that currency (`store.ts:1001`). The bullet "compare amounts with the PostHog total, not row by row" still implies the totals agree, which they don't. Either sum `payment_events.amount` per booking and currency, or state that amounts can be lower in D1 for resolved bookings.

**Nit**
- `analytics-kpis.md` SUB-4 and the reconciliation Subscriptions note say "a follow-up issue tracks that". Link [#275](https://github.com/mrgoonie/zuey-me/issues/275).
- The Stickiness (PRD-4) tile still uses "Value action", which includes anonymous users, while PRD-4 is defined on identified members. Use "Member value action".

### Round 2 verdict

M1 and m1–m8 are resolved or accepted, and no currency mixing remains. Two small count/amount gaps are left in the course and booking queries (r2-1, r2-2), so the PR is not ready yet. r2-1 is a one-line fix; r2-2 needs a filter change and one sentence.
