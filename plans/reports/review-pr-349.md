# Review: PR #349 (Closes #346)

`fix(courses): resume the follow-ups of an admin order grant whose receipt is missing`

- Head: `9fcdf720a95bb7c08579869a052f4aec08e16e02`, based on `origin/main` `6082c49` (#344)
- Reviewer: isolated, did not write this code
- Verdict: **MERGE**

## Scope

`git diff --stat origin/main...9fcdf72`: only 2 files changed.

- `src/lib/courses/course-order-payments.ts` (+18/-8)
- `tests/courses-commerce.test.ts` (+99)

## Gates

| Gate | Result |
| --- | --- |
| New tests run against main's `course-order-payments.ts` (swapped in, then restored with `git checkout HEAD --`) | 0 pass, 8 fail (REST `409 already_paid`, MCP `Order is already paid`) |
| `bun test tests/courses-commerce.test.ts` | 130 pass, 0 fail |
| `bun test` | 2156 pass, 0 fail (118 files) |
| `bun run build` | astro check 0 errors, 0 warnings (83 hints, already there); build complete |
| `gh pr checks 349` | Test & Build: pass |

## Adversarial checks

**The paid-but-unsent gate** (`course-order-payments.ts:389-394`). The resume runs only when the order is `status = 'paid'`, its `attention_reason` starts with `admin_grant:`, and the receipt row in `email_log` is not `sent` or `skipped`.

- *An order paid by a webhook.* A webhook payment passes `reason: undefined` to `fulfilCourseOrder`, so the update uses `COALESCE(NULL, ...)` and keeps the order's earlier reason (`:154-155`). That earlier reason comes from a `needs_attention` flag, a dispute or a refund, and none of those is ever `admin_grant:`. An order that is not paid but carries `admin_grant:` cannot exist either: refunds (`:271`), chargebacks (`:271`), disputed refunds (`:306`), dismissals (`:397`) and restores (`:365`) all overwrite the reason. A webhook-paid order therefore always fails the prefix check and still answers 409.
- *A refunded or disputed order.* Its status becomes `refunded` or `charged_back`, so `order.status === 'paid'` is false. The code then takes the `fulfilCourseOrder` path, whose guard `o.status <> 'paid'` matches. That is the same behaviour as main: an admin grant re-grants a refunded order on purpose, and this PR does not change it. The resume itself also checks the status again on a fresh read (`:183-184`). A won dispute restores the order to `paid` with the dispute reason (`:365`), not `admin_grant:`, and `restoreCourseOrder` runs its own follow-ups. So no grant and no receipt can come out of the resume branch for a refunded or disputed order.

**Concurrency (two admin retries at once).** I checked each follow-up's real key:

- Commission: `UNIQUE (source_kind, source_id)` (`migrations/0016_referrals.sql:104`) together with `ON CONFLICT DO NOTHING` (`src/lib/referrals/commissions.ts:135`). A refund tombstone (`isSourceReversed`) also suppresses a capture that arrives late.
- Promo: `UNIQUE (source_kind, source_id)` (`0020:49`). The update only applies to rows in `status IN ('reserved','released')` (`promo-redemptions.ts:144`), so a second redeem is a no-op.
- Invoice: `UNIQUE (source_kind, source_id)` (`0020:76`). The update only applies to rows in `status = 'awaiting_payment'`, and the admin emails go out only when `changes === 1` (`invoice-requests.ts:128-130`). Each admin email has its own `email_log` key.
- Receipt: `email_log.idempotency_key` is `UNIQUE` (`0006:120`). Whichever call loses the insert reads `pending` and returns `duplicate` (`email.ts:39-41`).

No commission, promo redemption, invoice or receipt can be duplicated.

**The stale-pending receipt rule.** The resume treats `pending` as unfinished and runs the follow-ups again. Inside the 2-minute window, `sendLoggedEmail` returns `duplicate`, so nothing is sent twice. After 2 minutes it sends again. This is the existing rule in `sendLoggedEmail`, which the webhook resume already relies on, and this PR does not change it.

**Response shape.** Both branches end at the same `getCourseOrderByCode` and return the updated order (`:403-405`). The REST and MCP wrappers are unchanged, so the shape is identical and no OpenAPI change is needed.

**Webhooks.** The only other caller is `course-payment-webhooks.ts:53`, `if (order) await resumeCourseOrderFollowUps(...)`. It ignores the new `boolean` return, and the helper's control flow is the same (`return` became `return false`). Webhook behaviour is unchanged.

**Code rules.** The diff has no `any` and no unchecked casts; it uses only `as const`. The test builds its admin MCP context with typed stubs.

## Findings

No Critical, High or Medium findings.

### Low / Info

1. **A failed receipt makes a grant retry succeed.** The receipt row can be `failed` (the email provider errored) even though all the follow-ups ran. In that case a grant retry runs no-op follow-ups, tries the receipt again and answers 200 instead of 409. This matches the webhook resume and is probably what you want, since it is a manual way to resend a receipt. The JSDoc at `course-order-payments.ts:379-381` only mentions failed follow-ups, so a short note there would help.
2. **The refund race is not new.** If an admin refund commits between the resume's status read (`:183`) and `sendLoggedEmail`, the receipt could still go out for that order. The commission is safe because of the reversal tombstone. The same window already exists in `fulfilCourseOrder`'s follow-ups and in the webhook resume, it needs two admin actions at the same moment, and it cannot re-grant access. No action needed for this PR.
3. **Old admin-granted orders with no receipt row.** An order granted before receipts were logged would get a late receipt if an admin re-grants it now. Only an explicit admin action can trigger this, and it is harmless.

## Test quality

The 8 cases cover {REST, MCP} x {referral, promo} x {crash right after the batch, crash at the first `email_log` insert}. `crashingAfterPayment` marks the batch as committed only after the paying batch has run, so the crash really happens after the commit. Each case checks one commission or promo redemption, one invoice and one receipt after the retry, a 409 on the next retry, and that the activity, order log and purchase event stay at one each. The tests do not cover two retries running at once; I verified that case from the unique keys above.

## Cleanup

The temp worktree `%TEMP%\rv349` was removed, including its `dist`, `.wrangler` and `node_modules`. I did not push, comment or relabel anything.
