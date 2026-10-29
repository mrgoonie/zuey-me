# Review round 2: PR #136, early Dodo first-payment reversal by card reference (closes #132)

Head `8cd71ae`, rebased onto main `6e46f0b` (includes #133). Isolated reviewer, fresh worktree. No Dodo API calls made.

**Verdict: APPROVE.** Every item on the round-1 rebase checklist holds, and the round-1 Low (identity check parity) is fixed and covered by a test that fails without it.

## Gates (fresh worktree at the PR head, Windows)

- `bun install --frozen-lockfile`: OK
- `bun test`: **991 pass, 0 fail** (54 files)
- `bun run build`: astro check **0 errors, 0 warnings** (hints only); build complete
- Mutation check: dropping `AND user_id IS ? AND plan IS ?` from the fallback query makes `tests/referrals-commissions.test.ts` give 23 pass / **1 fail** (the new mismatch test). Restored afterwards.
- GitHub: `MERGEABLE` / `CLEAN` against the current main, CI "Test & Build" green.

## Checklist

1. **#133 behavior preserved.** `cardFromDodoLookup` (`src/lib/payments/dodo-billing.ts`) keeps the `DODO_API_KEY` precheck, and the catch still rethrows non-`DodoApiError`, `upstreamStatus === null`, 5xx, 408 and 429 (so they become 502), returning `null` only for other 4xx. No catch-all "ignored" branch came back. `dodo.ts` keeps the timeout and `DodoApiError`; `lookupDodoPayment` goes through `dodoRequest` and its JSDoc says it throws `DodoApiError`. `git grep getDodoPaymentSubscriptionId` finds nothing. #133's outage test passes in the full suite.
2. **Fallback.** `if (!subscriptionId) return null;` is gone: the subscription-id query runs only when an id exists, and the `card_ref` query runs whenever that finds no row, so it covers both a null id and an id that no card stores yet. The query keeps `(provider_subscription_id IS NULL OR provider_subscription_id = ?)`. With a null subscription id the second branch is `= NULL`, so a bound card never matches. The test's `pay_other` case covers this.
3. **Identity check.** `AND user_id IS ? AND plan IS ?` bound to `metadata.userId` / `metadata.plan` behaves exactly like `metadataMatches` (`meta.userId === card.user_id && meta.plan === card.plan`), including null:
   - Missing metadata: `strOrNull` gives `null`, and `IS NULL` matches only a card whose `user_id`/`plan` is NULL. Checkout cards are inserted with the signed-in member and plan. The only NULL-user insert (`metadata_missing`) always stores a subscription id, so it is found by the first query, never by the fallback.
   - Case: `parseMetadata` keeps only an exact `PLAN_IDS` member, and SQLite `IS` on TEXT uses BINARY collation, so the comparison is case-sensitive on both sides.
   - Type: non-string metadata becomes `null` (`strOrNull`, `typeof === 'string'`), so a number or object cannot coerce into a match.
   - A mismatch now returns `null`, which means `ignored` at once instead of eight 409s. The new test covers both a wrong user and a wrong plan.
4. **409 before any write.** Both lookups are reads. The 409 is thrown inside `cardFromDodoLookup` before the caller's `recordEvent`, `reverseCommission`, `queueRefund` or `insertActivity`. The first new test asserts 409, then `payment.succeeded`, then a retried 200 `reversed` with the commission moving `pending` to `reversed`, through the signed webhook route.
5. **Docs.** The `docs/analytics-events.md` "Dodo refunds of renewals" paragraph keeps #133's 4xx / no-key → `ignored` and network / 408 / 429 / 5xx / 10 s timeout → `502 payment_provider_error` sentences, and adds the `card_ref` clause with its bound-card and `user_id`/`plan` conditions. The function JSDoc, `applyDodoReversal` JSDoc and route comment match the code.

## Findings

None blocking.

**[Nit] Two card-lookup shapes.** The reversal fallback is still a separate `SELECT` next to `locateCard` + `metadataMatches`. It behaves the same way, but the two copies could drift. Optional follow-up: one shared helper.

## Follow-up candidates (out of scope)

- No test for a `card_ref` with missing `user_id`/`plan` metadata. The behavior is already pinned by the parity analysis above, so this is low value.

## Cleanup

Removed the scratch worktree `rv136`, the local branch `review-136` and the temporary files. `dist/` and `.wrangler/` were inside the removed worktree.
