# Review: PR #334 (Closes #328): course grant in one batch

- Head: `64b6d8f3db7a27dbcaa37d4d7ff77763639d106f`. Reviewed on 2026-10-25 in a fresh temp worktree, which has since been removed.
- Scope: `git diff --stat origin/main...64b6d8f` lists exactly the 5 expected files (+166/-40):
  - `course-order-payments.ts`
  - `course-orders.ts`
  - `course-payment-webhooks.ts`
  - `course-purchases.ts`
  - `tests/courses-commerce.test.ts`

## Gates

| Gate | Result |
| --- | --- |
| `bun install --frozen-lockfile` | ok |
| `bun test` on the 4 course files (commerce, learning, referrals, promos-courses) | 114 pass, 0 fail |
| `bun test` (full) | 2103 pass, 0 fail, 117 files |
| `bun run build` | 0 warnings; astro check passed, build complete |
| `gh pr checks 334` | Test & Build: pass. Mergeable, CLEAN |
| New tests against main's `src` (PR tests kept) | 10 fail, 86 pass. See F4 for the 16/6 count |

## Caller-by-caller analysis

Every caller now goes through `fulfilCourseOrder` (`course-order-payments.ts:112-140`). It builds one batch:

```
[...githubSyncStatements, activity(courses.granted), purchaseUpsert, UPDATE status]
```

- Each grant statement is guarded by `inactive AND payable`.
- The status update is guarded by `payable` and runs last.
- The function returns `false` when the update changed 0 rows.
- The grant statements never change `course_orders`, so `payable` evaluates the same for every statement in the batch. A failure anywhere rolls the whole batch back.

| Caller | Payable guard on main | Guard on PR | `false` handling | Provider-visible codes |
| --- | --- | --- | --- | --- |
| Dodo `payment.succeeded` (`course-payment-webhooks.ts:228-233`) | `status <> 'paid'` | `o.status <> 'paid'`: identical | `already_paid`: identical to main | Throw → event released → `errorResponse` (5xx) → Dodo retries. Success is 200, unchanged |
| SePay (`:64-75`) | `pending OR (expired AND attention_reason IS NULL)` | Same predicate, aliased `o.` and parenthesised (`:117`) | Re-read: `already_paid`, or `late_payment` flag. Identical branch | Same as Dodo |
| Free enrolment, 100% promo (`course-orders.ts:294-303`) | `status = 'pending'`, but main fulfilled even when the update missed | `o.status = 'pending'` | Return value ignored. The order was created a few lines earlier, so it cannot be non-pending in practice | n/a (checkout API) |
| Admin order `grant` (`course-order-payments.ts:336-340`) | JS check `!== 'paid'`, then an unconditional update | JS check plus `o.status <> 'paid'` in SQL | `409 already_paid`, same as main, now also correct under a race | 200 unchanged. Error → 500 envelope |
| Admin grant-by-email, REST and MCP (`course-purchases.ts:50-55,149-155`) | n/a | `grantCourseStatements` without `onlyIf` | `granted: false` when already active | `{ user_id, granted }` unchanged. REST failure → `500 internal_error` envelope. MCP rejects, and the JSON-RPC layer maps it to `-32000` |

### Batch semantics and races

- **Refund or dispute mid-payment.** `reverseCourseOrder` only acts on `paid` or `needs_attention` orders. SePay's guard excludes both. Dodo's guard (`<> 'paid'`) admits `needs_attention`, `refunded` and `charged_back`, which is exactly main's predicate.
  - If a refund commits first, a Dodo payment still pays and re-grants. This behaviour already exists on main and is unchanged.
  - D1 runs batches one at a time, so the two cannot interleave inside a batch.
- **Already-active access (`already_owned`).** All grant statements are no-ops and the status update applies. `results[grant.length - 1]` is the purchase upsert, so 0 changes sets `already_owned` (`:124-128`). This is correct, including for a course with no GitHub repos (`grant.length = 2`).
- **Course bought twice.** Order B is flagged `already_owned`. A refund of B revokes only where `order_id = B` (`revokeCourseStatements`), so A's access stays. Unchanged.
- **Revoked purchase row.** `ON CONFLICT DO UPDATE` reactivates the row and reports `changes = 1`, so access is granted. Correct.

### Steps after the batch

These steps are:

- the `already_owned` flag;
- the `courses.order_paid` log;
- `queuePurchase`;
- referral capture;
- promo and invoice bookkeeping;
- the receipt.

They run only when `results.at(-1).changes` is non-zero (`:123`). On a redelivery, either the event record is a duplicate, or `fulfil` returns `false` before reaching them, so nothing is duplicated.

If one of these steps throws after the commit, the event is released and the redelivery gets `already_paid`. The rest of the steps are then skipped. That ordering is the same as on main, where the status update was also committed before these steps ran.

### Known P2: event recorded before fulfilment

The PR **improves** the case where processing throws. Main could leave the order `paid` with no access, and the redelivery then hit `already_paid` for good. Now the batch rolls back and the event is released, so the redelivery pays the order once. The tests prove this.

For a **worker crash** it is **unchanged**. The record is still committed before the batch, so a crash mid-batch leaves the order pending and the redelivery is a `duplicate_event`. The PR does not make the P2 worse.

## Findings

| # | Sev | Where | Finding |
| --- | --- | --- | --- |
| F1 | Low | `course-order-payments.ts:115-116` | **A missing course now leaves a captured payment unrecorded.** See the detail below. |
| F2 | Low | `tests/courses-commerce.test.ts:724-827` | **The admin order `grant` retry is untested.** See the detail below. |
| F3 | Low | `tests/courses-commerce.test.ts:742-749` | **The MCP tests stop below the JSON-RPC layer.** They assert the raw `/injected/` rejection, not the `-32000 internal_error` envelope from `src/pages/api/mcp.ts`. This is the same gap as noted in review-pr-327. |
| F4 | Nit | PR body | **The test counts in the PR body are off.** It says "10 of the 16 new tests fail on main; 6 pass". The code adds **14** tests: 3 grant points × 2 surfaces (REST, MCP), plus 4 pay points × 2 providers (Dodo, SePay). Rerun on main: **10 fail, 4 pass**. The 4 that pass are the admin access-grant upsert (REST and MCP) and the status update (Dodo and SePay). The claim that main fails the new tests holds; only the arithmetic is wrong. |
| F5 | Nit | `course-purchases.ts:2-3` | **The header comment is stale.** It still says `grantCourse` and `revokeCourse` are "the only writers" of `course_purchases`. Since #315 and this PR, the writers are `grantCourseStatements` and `revokeCourseStatements`, used by fulfil, restore and reverse. |
| F6 | Nit | `course-orders.ts:300` | **The free path ignores the `false` result.** If it ever happened, the checkout would return a pending order with `checkout_url: null`. It is unreachable today because the order is created just above. A one-line guard throwing `500 internal_error` would make this explicit. Optional. |

### F1: missing course on payment

`fulfilCourseOrder` throws `404 course_not_found` *before* the batch.

On main, the scenario played out like this:

1. The status update ran first, so a payment for a pending order on a course that was soft-deleted since checkout was recorded as `paid`.
2. `provider_payment_id` was stored, so a later refund could find the order.
3. Then the 404 was thrown, and the redelivery returned `already_paid`.

Now the order stays `pending` with no `provider_payment_id`:

- Every delivery fails with 404 until Dodo or SePay give up.
- The money is never recorded or flagged.
- A later Dodo refund cannot match the order (`orderByPaymentId`).

**Scenario:** an admin soft-deletes a course. `deleteCourse` only refuses when the course has *active owners*, not pending orders. A buyer with an open checkout then pays it.

This is rare but it is a money path. Suggested follow-up: when the course is missing, mark the order needing attention (`course_missing`, with amount and ref) and return `needs_attention`, rather than throwing. File it as its own issue, per AGENTS.md. It does not block this PR.

### F2: admin order `grant` retry untested

The PR body names `resolveCourseOrder` `grant` as a behaviour change: on main, a failed grant left the retry stuck at `409 already_paid`. No test makes that grant fail part-way and checks that the retry succeeds once.

The free-enrolment failure path is also untested. Both are covered by the same `fulfilCourseOrder` code that the Dodo and SePay tests exercise, so the risk is low.

## Test quality

The new tests are meaningful:

- `failingD1` injects the failure inside the batch, which rolls back as D1 does, and the webhook releases its event.
- They check that the order is `pending` and that nothing was written: no ownership, `courses.granted` or `courses.order_paid` logs, invites, `purchase` outbox row, `payment_events` row or receipt email.
- They check that the redelivery pays the order once and that a third delivery is a `duplicate_event`.
- The admin tests check that a second grant returns `granted: false` with exactly one log row and one invite row.
- 10 of the 14 fail on main, so they catch the bug.

## Verdict

**MERGE.**

- All callers keep their guards, branching and provider-visible response codes.
- Every grant write is gated on the order still being payable inside one atomic batch, with the status update last.
- The steps after the batch run once and only when the batch applied.
- Gates and CI are green, and scope is clean.
- F1 is a narrow regression (a soft-deleted course with a pending order) and is worth a follow-up issue. F2 to F6 are test and documentation polish.

Status: DONE
Summary: MERGE. Local gates pass (114 focused tests, 2103 in the full suite, build with 0 warnings) and CI Test & Build passes. No blockers. The follow-ups are F1 (Low: a missing course leaves a payment unrecorded) and F2 (Low: the admin order `grant` retry is untested). The PR body's test count is off: 14 new tests, 10 failing on main.

---

## Round 2: head `a1de87bef1e74eb948a73e0f3170ea33b1d0cb8c` (rebased on origin/main `525add5`)

Reviewed in a fresh temp worktree at `%TEMP%\rv334b`, which has since been removed.

**Scope:** `git diff --stat origin/main...a1de87b` still lists only the 5 expected files (+246/-45). A two-dot diff against the round-1 head also shows `src/components/studio/CompositionFields.tsx`. That change comes from the rebase onto main, not from this PR.

### Gates (run one at a time)

| Gate | Result |
| --- | --- |
| The 4 course test files (commerce, learning, referrals, promos-courses) | 120 pass, 0 fail |
| `bun test` (full) | 2120 pass, 0 fail, 118 files |
| `bun run build` | 0 errors, 0 warnings, build complete |
| `gh pr checks 334` | Test & Build: pass (run 40182910682). Head matches, CLEAN |
| New tests against main's `src` | 15 of the 20 new tests fail; 87 pass in total (see below) |

The 5 new tests that pass on main are the cases where the failing write was already the first write on main: the access-grant upsert for admin REST and MCP, and the status update for Dodo, SePay and admin order `grant`. This matches the updated PR body (F4 resolved).

### Fixes checked at the cause

**F1 (resolved).**

- **SePay** (`course-payment-webhooks.ts:64-68`): after the payable, late and underpaid checks, a missing course leads to `markCourseOrderAttention(order, 'course_missing', extra)`.
- **Dodo** (`:224-226`): `course_missing` is the last entry in the reason chain. It goes through the existing attention branch, which also stores `provider_payment_id` with `COALESCE`.
- In both, the event stays recorded and the webhook returns `needs_attention` with a 200. The redelivery is a `duplicate_event`, so the provider stops retrying.

Other paths:

- **Refund or dispute on a `course_missing` order.** `needs_attention` is in `REVERSIBLE`, so a refund finds the order. `orderByPaymentId` locates it, and the new Dodo test proves the refund arrives as `refunded`.
  - `revokeCourseStatements` accepts a `null` course, so its GitHub statements are skipped and no row is revoked.
  - `courseMoneyBackStatement` returns null because `paid_at` is null. That is correct: no purchase event was ever queued for this order, so there is no refund event to report.
  - Disputes take the same reverse path.
- **Admin resolve of a `course_missing` order.**
  - `grant`: `fulfilCourseOrder` throws `404 course_not_found` before the batch, so nothing is written and the response is the standard envelope. Correct, since the course no longer exists.
  - `refund` and `dismiss`: these work as before.
- **Free enrolment.** Unchanged. Checkout requires a published course, and a missing course still throws before any write.
- **Race: course deleted between the check and the batch.** `fulfilCourseOrder` throws a 404, the event is released and the redelivery is flagged `course_missing`. This heals itself.
- **Edge case that predates this PR.** A dispute won (`restoreCourseOrder`) on an order whose course was deleted still throws a 404. It is out of scope.

**F2 (resolved).** There are 4 new tests, one per write in `payPoints`:

- the GitHub invite;
- the grant log;
- the access grant;
- the status update.

In each, `resolveCourseOrder(…, 'grant')` fails, and the test checks that:

- the order stays `needs_attention` with nothing written: no ownership, no logs, no invites, no purchase event;
- the retry returns `paid` and grants exactly once;
- a second grant is rejected as `already paid` (409).

On main, the first three of these tests fail, which confirms the bug existed.

**F4 (resolved).** The PR body now says 20 new tests, 15 of them failing on main. I verified both numbers.

**F5 (resolved).** The header comment in `course-purchases.ts` now names `grantCourseStatements` and `revokeCourseStatements` as the only writers to `course_purchases`.

**F3 and F6 (still open, Nits, not blocking).**

- F3: the MCP tests still assert the raw rejection, below the JSON-RPC envelope.
- F6: the free path still ignores the `false` result from `fulfilCourseOrder`. It cannot happen today.

### New findings

None.

### Round 2 verdict

**MERGE.** F1, F2, F4 and F5 are fixed at their cause without regressing the free-enrolment, admin resolve, refund or dispute paths. The new tests fail on main as claimed, scope is the 5 files, and the local gates and CI are green.

Status: DONE
Summary: Round 2 verdict is MERGE. F1, F2, F4 and F5 are fixed at their cause: 15 of the 20 new tests fail on main, local gates pass (120 focused tests, 2120 in the full suite, build with 0 errors and 0 warnings) and CI passes.
