# Review: PR #368 — refuse grant and dismiss on a disputed course order (fixes #366)

Reviewed head `0aee452` (based on `main` @ `56720a6`), isolated worktree, independent of the author.

## Scope checked

- `src/lib/courses/course-order-payments.ts` (`resolveCourseOrder`, new `courseDisputeLost`, `SETTLEABLE` guard), neighbours `fulfilCourseOrder`, `reverseCourseOrder`, `refundDisputedCourseOrder`, `refundCourseOrder`, `restoreCourseOrder`.
- `src/pages/api/v1/admin/course-orders/index.ts` (`dispute_lost`), `[code]/resolve.ts`, `src/lib/courses/course-mcp.ts` (`course_order_resolve`), `src/lib/courses/course-admin-openapi.ts`, `src/components/studio/courses/course-orders-review.tsx`.
- Every caller of `resolveCourseOrder`: REST resolve route and the MCP tool only. Both now go through the new guard.

## Correctness

- **Race safety:** the grant's `when` becomes `o.status NOT IN ('paid','charged_back')`, and `fulfilCourseOrder` applies that guard to every statement in its batch (grant rows, log, purchase event, status update). The dismiss is now a guarded single `UPDATE ... AND EXISTS(... SETTLEABLE)` where it used to be unconditional. A `dispute.opened` that lands between the read and the write makes the batch a no-op, and the re-read maps it to `order_disputed`. Both race tests cover this.
- **Bonus fix:** the old unconditional dismiss could cancel an order that a payment marked `paid` in the meantime. I checked this with a probe: a grant that lands just before the dismiss write now gives `409 already_paid` and the order stays `paid`.
- **#364 refund of a disputed order:** this path is unchanged and still works. The tests for an open dispute, a lost dispute and a refund race pass. The 409 message now comes from the re-read status, so a racing Dodo refund reports "Order is already refunded".
- **#355 `dispute.won` restore:** after a refused grant or dismiss, `dispute.won` still restores the order (tested through REST, MCP and both races).
- `courseDisputeLost` uses the same `payment_events` predicate as `refundDisputedCourseOrder`. The UI's `dispute_lost` therefore matches what the server refuses.
- The OpenAPI and MCP descriptions document `order_disputed` and `dispute_lost`, and they match the behaviour.
- AGENTS.md TS rules: no `any`, no unchecked casts (only `as const` in tests).

## Findings

### High
None.

### Medium
None.

### Low
1. **Grant of an order refunded during an open dispute is still allowed. Pre-existing and outside #366's literal scope.** `course-order-payments.ts:451-457` and `course-orders-review.tsx` (`refunded` → `grant, dismiss`). Scenario: an order is disputed, the admin refunds it (#364, status `refunded`) and then grants it. The grant succeeds (`200`), the order is `paid` and the buyer has access again while the dispute is still open. A probe confirmed it: `{"status":200} paid true`. A later `dispute.lost` reverses it (charged_back, no access). A `dispute.won` would leave it paid. This needs a deliberate admin action on a refunded order, so the risk is small. I suggest a follow-up issue rather than widening this PR.
2. **Dismiss fallback message.** `course-order-payments.ts:467-470`: when the guarded dismiss changes nothing and the order is not `charged_back`, the fallback always says `already_paid` / "Use refund for a paid order". In practice this only happens when the order turned `paid`, so it is cosmetic.
3. **One extra query per order in the admin list.** `admin/course-orders/index.ts:25`: `dispute_lost` runs one extra query, but only for `charged_back` rows and inside a loop that already does per-row lookups. Negligible.

## Evidence

- New tests fail against `main`'s source (the 5 `src` files swapped back): the UI test file fails on import (`orderActions` not exported), and 8 server tests fail: REST and MCP for open and lost disputes, the grant and dismiss races, the refund-message race, and `dispute_lost`. That matches the PR's claim.
- Focused tests (`course-orders-review-actions`, `courses-commerce`, `courses-commission-reversal`): 164 pass, 0 fail.
- Full `bun test`: 2262 pass, 0 fail, 121 files.
- `bun run build`: 0 errors, 0 warnings (98 hints).
- `gh pr checks 368`: Test & Build pass (2m30s).
- Probes (not committed): grant of a refunded-during-dispute order (Low 1); a dismiss racing a payment gives 409 `already_paid` and the order stays paid.

Verdict: MERGE
