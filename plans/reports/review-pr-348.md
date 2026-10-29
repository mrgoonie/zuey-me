# Review: PR #348 (Closes #275), subscription_expired carries provider

Head `8e414968`, 2 commits on `origin/main`. Isolated reviewer; I did not write this code.

## Verdict: MERGE

No blocking findings. Two low-severity notes and two nits below. None needs to block the merge.

## Scope

`git diff --stat origin/main...HEAD` lists exactly the 12 files the author names (128+/39-). Nothing outside the scope.

## Gates (temp worktree `%TEMP%\rv348` at the PR head)

| Gate | Result |
| --- | --- |
| Fail-on-main (main's 6 changed `src/` files swapped in, PR tests kept) | 33 pass, **5 fail**, the same 5 tests the author names. Restored with `git checkout HEAD -- src`; tree clean |
| `bun test tests/analytics-outbox.test.ts tests/channel-access.test.ts` | 84 pass, 0 fail |
| `bun test` | 2152 pass, 0 fail (118 files) |
| `bun run build` | 0 errors, 0 warnings, build complete |
| `gh pr checks 348` | Test & Build: pass |

## Adversarial checks

- **Callers of `recomputeSubscription`.** Every caller is covered:
  - `src/lib/members/billing.ts:403` (`fulfilOrder`) passes `sepay`. It is reached from the SePay webhook (`billing.ts:483`), the free order (`billing.ts:285`), and the admin/MCP resolve (`billing-attention.ts:195`).
  - `src/lib/payments/dodo-billing.ts:299`, `:480`, `:540` and `:565` pass `dodo`.
  - No admin action, MCP tool, refund, dispute, channel-access or cron path calls it. Refunds and disputes touch course orders only, and nothing else writes `card_subscriptions` or flips a paid `billing_orders` row.
  - `sendRenewalReminders` (`billing.ts:593`) flips `status` by the clock without recomputing. The sweep accepts `status IN ('active','expired')`, so that flip changes nothing here.
  - The required field breaks no caller. `tsc`/astro check is clean.
- **The attribution invariant holds.** "Only a change on the rail that granted the access end can end it" is correct:
  - `fulfilOrder` only adds paid orders, and those can only extend the end.
  - A card change only moves `cardEnd`, which ends access only when `cardEnd` was the maximum.
- **Sweep SQL** (`src/lib/analytics/outbox.ts:336-369`):
  - It is still one `INSERT … SELECT`, so the query budget is unchanged.
  - Bind order: 3 outer `?`, then the grace, then `now`, the lookback and `LIMIT`. This matches the textual placeholder order, and the tests exercise it.
  - Units are consistent. The `julianday` difference × 86 400 000 is in ms, compared with `CARD_RENEWAL_GRACE_MS` (ms) within 1000 ms. `julianday` resolution near 2.46e6 is about 0.05 ms, so the tolerance is safe.
  - The grace direction is right: the access end equals the card period end + grace, as `cardAccessEnd` computes it (`subscriptions.ts:66`).
  - The correlated `EXISTS` lookups are served by `idx_card_subscriptions_user (user_id, plan, status)` and `idx_billing_orders_paid (user_id, plan, paid_at) WHERE status='paid'`, over at most 200 candidates.
  - Both rails: the access end is `max(sepay, card)`. A card match wins only when the card granted the end, and otherwise the sweep falls through to `sepay`. So a dual-rail member is labelled correctly in the normal case.
- **The moved constant.** `CARD_RENEWAL_GRACE_MS` has the same value (`24*60*60*1000`) and is now imported only by `subscriptions.ts:7` and `outbox.ts:25`. No other importer existed in `src`, `tests`, `workers` or `scripts`. Behaviour is unchanged.
- **Dedupe keys.** They are unchanged. The recompute uses `subscriptionExpiredKey(user, plan, end)` and the sweep uses `'subscription_expired:' || user_id || ':' || plan || ':' || current_period_end`. Only `properties` changed, so there are no double events.
- **Types.** No `any` and no unchecked casts in the added lines. `MembershipProvider` is imported with `import type`.
- **Docs.** The claims in `analytics-events.md`, `analytics-kpis.md` SUB-4 and `analytics-reconciliation.md` (around 220 and 348) match the code. The drain change from "prepaid" to "prepaid or card" corrects an older inaccuracy: the sweep never filtered by rail.

## Findings

### Low

1. **The sweep's `sepay` fallback matches any paid SePay order for the plan, not the order that granted the end** (`src/lib/analytics/outbox.ts:355-357`). The fallback runs whenever the card match fails, and the card match fails in two cases:
   - A card revocation's own recompute event failed to queue. The stored end is then the revocation instant (`subscriptions.ts:127`), not a card period end. This is the risk the author documented.
   - A later webhook moved `card_subscriptions.current_period_end` before the sweep ran. Example: `on_hold` carrying a new `nextBillingDate`, landing within the 5-minute gap after a lapse.

   In either case, a member who paid SePay at any time in the past (possibly months earlier) is labelled `sepay` for a card expiry. Both cases need an enqueue failure or a narrow race, so the impact is a rare mislabel in one KPI breakdown. Access and money are unaffected. A tighter rule would label `sepay` only when the paid orders' computed end matches the access end, but SQL cannot reproduce the `addMonths` chain cheaply. I judge the current trade-off acceptable. Optionally, say in the docs that the fallback is a heuristic ("has ever paid by SePay").
2. **The recompute's `sepay` expiry branch has no production path today.** No code flips a paid `billing_orders` row away from `paid`, so `fulfilOrder` can never end access. The new test (`tests/analytics-outbox.test.ts:264-274`) reaches that branch with a raw `UPDATE`. This is fine as a contract test for a future SePay refund or revoke path. Note that in practice every SePay-labelled expiry comes from the sweep.

### Nit

3. `docs/analytics-kpis.md` SUB-4 caveat still says "prepaid expiries are found by the outbox drain". Card lapses without a webhook also rely on the sweep now (and did before). Could say "clock expiries".
4. The comment at `src/lib/analytics/events.ts:309` ("Left out only when the expiry sweep finds neither…") leaves out the rows queued before this change. The docs mention them; the comment does not. Cosmetic.

### Info

- Free (0 VND) orders and 100% promo grants are `billing_orders` rows, so their expiries are labelled `sepay`. That matches the `provider` on their `subscription_activated` events (`subscriptions.ts:119`), so the breakdowns stay consistent.

## Cleanup

The temp worktree `%TEMP%\rv348` was removed along with its `node_modules`, `dist` and `.wrangler`. Nothing was pushed, commented or relabelled.
