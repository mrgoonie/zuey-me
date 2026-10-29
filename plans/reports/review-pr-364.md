# Review: PR #364 (fixes #293)

- Head: `6e19ce11509e6b19227f6f373fb5827676927b66`. Merge-base equals `origin/main` (`d7e31bf`), so no rebase is needed.
- Scope: an admin `refund` on a `charged_back` course order takes the same guarded path as a Dodo refund during a dispute.
- Verdict: **MERGE**

## Gates

| Gate | Result |
| --- | --- |
| `git diff origin/main...HEAD --stat` | 7 files, +115 / -27 (as expected) |
| Fail on main (main's `src/` swapped in, `-t "recorded by an admin"`) | 0 pass, 3 fail, all with "Only paid or flagged orders can be refunded"; restored afterwards, tree clean |
| Focused: `courses-commerce` + `courses-commission-reversal` | 150 pass, 0 fail |
| Focused, wider: plus `courses-referrals`, `oauth-mcp`, `site`, `analytics-outbox` | 260 pass, 0 fail |
| Full `bun test` | 2234 pass, 0 fail (119 files) |
| `bun run build` | astro check: 929 files, 0 errors, 0 warnings, 97 hints; build complete |
| OpenAPI probe (`GET /api/openapi.json` handler, head vs main) | 200, 188 paths in both. `requestBody` and the `200` response are byte-identical. Responses change from `[200,400,401,403]` to `[200,400,401,403,404,409]`, and a description is added |
| `gh pr checks 364` | Test & Build: pass (2m15s) |

## Claim verification

1. **`refundCourseOrder` routing and retry** (`src/lib/courses/course-order-payments.ts:316-325`): verified.
   - `charged_back` goes to `refundDisputedCourseOrder`. Any other status goes to `reverseCourseOrder(..., 'refunded', ..., countMoneyBack=true, gate)`, which is guarded on paid/needs_attention.
   - On failure it re-reads the order and retries once if the status changed. This is the same logic as the removed inline copy.
2. **Webhook behaviour is unchanged** (`src/lib/courses/course-payment-webhooks.ts:209`): verified by comparing the code line by line with the old code.
   - Same `reason` (`dodo_refund` / `dodo_partial_refund`), actor `system`, `moneyBack` (Dodo amount and currency) and `gate`. The `reversed` outcome is the same, and the fallthrough still goes to `recordCoursePaymentEvent`.
   - The #355 guard (no refund after a funds-lost event) is in the same `disputed` SQL condition. The #360 retry on the re-read order is in the same place.
   - The `getCourseOrderByCode` import is still used elsewhere (lines 71, 111, 160).
   - All existing webhook tests pass.
3. **`refundDisputedCourseOrder` gained `actor`, and its amount is now nullable** (`:292-307`): verified.
   - With `reversed = null`, `courseMoneyBackStatement` uses `paidAmount(order)`. That is `amount_paid`/`currency_paid`, the money actually received after any promo or referral discount, not the list price.
   - For a partially paid (flagged) order that was then charged back, it is the partial amount actually paid, so it is correct.
   - `paid_at === null` yields no event. `partial` is false because the amount equals what was paid.
4. **Admin refund of a `charged_back` order**: verified by the new tests and by reading the code.
   - The order ends `refunded`, with one `refund:dodo:course_order:<id>:refunded` outbox key and activity actor `admin`.
   - A second refund returns 409.
   - `dispute.won` returns `ignored`: `restoreCourseOrder` is guarded on `charged_back`, so access stays revoked.
   - `dispute.lost` returns `ignored`, and its redelivery returns `duplicate_event`. `chargeBackLostCourseOrder`'s `notFullyRefunded` check suppresses a second count.
   - The commission is reversed once (one `commission.reversed` row). `refundDisputedCourseOrder` emits no commission statements.
   - `dispute.cancelled` is not tested directly. It shares the `DODO_DISPUTE_FUNDS_KEPT` → `restoreCourseOrder` branch with `won`, so it behaves the same.
5. **409 kept for other states, and a new message after a lost dispute** (`:442-446`): verified.
   - Tests cover the lost-dispute case, an already refunded order and a pending order.
6. **UI** (`src/components/studio/courses/course-orders-review.tsx:16,37-39,61`): verified by static inspection.
   - `canRefund` now includes `charged_back`. The Refund button renders behind the same flag.
   - `confirmText` picks `CONFIRM_DISPUTED_REFUND` only for `refund` on a `charged_back` order. The other actions and states keep their old text.
   - A 409 is surfaced through the existing `errText(r)` status line.
7. **MCP, route comment and OpenAPI**: verified. Only descriptions and response codes changed; the shapes are untouched (see the probe above). The `404 not_found` and `409 already_paid` / `not_refundable` codes all exist in `resolveCourseOrder`.

## Judgement questions

- **Analytics amount and currency for an admin refund of a disputed order:** this is correct. With no provider amount it defaults to `amount_paid`/`currency_paid`, the same as an admin refund of a paid order.
- **Is the refund counted once against the earlier chargeback?** Yes.
  - `dispute.opened` calls `reverseCourseOrder(..., 'charged_back', ..., countMoneyBack = lost)`, which is `false` for an opened dispute. So the open writes no analytics event.
  - The admin refund writes the only revenue reversal.
  - A later funds-lost outcome is suppressed, because the order is `refunded` with an `attention_reason` other than `dodo_partial_refund`.
  - Before this PR, the Dodo refund during a dispute did exactly the same (one `refunded` event at Dodo's amount). Only the amount source differs: Dodo's figure there, the paid amount here.
- **Is the UI confirm text accurate?** Yes, for the normal flow: the opened dispute revoked access and reversed the commission, and a won dispute will not restore access. "Send the money back yourself in Dodo" fits, because only Dodo webhooks produce `charged_back`. The one gap is in finding L2.
- **Does another caller rely on the old 409 for `charged_back`?** No. `git grep` finds only:
  - the route, the MCP handler and tests call `resolveCourseOrder`;
  - `not_refundable` appears only in source, tests and the docs this PR adds;
  - nothing in `docs/` mentions it.

## Findings

### High
None.

### Medium
None.

### Low
- **L1: wrong 409 message in a rare race** (`src/lib/courses/course-order-payments.ts:443-445`). The message is chosen from the status read *before* the attempt. If the order was read as `charged_back` and a Dodo `refund.succeeded` committed in between, the retry finds it `refunded` and fails. The admin then sees "The dispute on this order was lost", which is wrong: it was refunded. The outcome is still a 409 and no data is wrong. A possible fix is to pick the message from the re-read status. Optional.
- **L2: the confirm text overstates in one case** (`course-orders-review.tsx:16`). A `charged_back` order reached by a funds-lost outcome on a paid order also shows Refund with "a won dispute will not restore access". The server then answers 409 with the lost-dispute message, so the error is clear. This is cosmetic.
- **L3: test gaps.** The tests do not assert the refund event's `amountMinor`/`currency` for the admin path, and do not exercise `dispute.cancelled` after an admin refund. Both are covered by shared code; adding them is optional.
- **Out of scope, pre-existing; file separately if wanted.** On a `charged_back` order the studio still offers Grant and Dismiss (`canGrant`/`canDismiss`, lines 35-36).
  - Grant would re-grant access during an open dispute.
  - Dismiss would move the order to `cancelled`, and a later won dispute would not restore it.
  - This PR does not touch either, so it does not block.

## Cleanup
- The probe files in the session scratchpad were removed.
- `dist/` and `.wrangler/` were removed and the worktree `%TEMP%\rv364` was deleted. The PR, its labels and its comments were not touched.
