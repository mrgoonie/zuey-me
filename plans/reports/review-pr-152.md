## Review of PR #152: course-order Dodo dispute amount (closes #149)

**Verdict: APPROVE**. Reviewed head `8da4f08`, which is based on current `main` (includes #148).

### Gates
- `bun test`: 1051 pass, 0 fail (59 files)
- `bun run build`: astro check found 0 errors and 0 warnings, and the build completed
- I reverted only `course-payment-webhooks.ts` and `dodo.ts` to `HEAD~1` and kept the new test. `tests/courses-commerce.test.ts` then gave 13 pass and 1 fail: the new test failed on the `payment_events` amount (`toEqual`). So the test catches the bug.
- No endpoints changed, so OpenAPI needs no update.

### Verification
- **Amount used, and units.** `amount = typeof d.total_amount === 'number' ? d.total_amount : minorUnitsOrNull(d.amount)`. For a dispute of `'2500'`, `payment_events.amount` is 2500, in minor units. `queueCourseMoneyBack` then receives `amountMinor: 2500` and uses it in place of the paid amount (`reversed?.amountMinor ?? paid.amountMinor`). `queueRefund` → `money()` → `toMajorUnits` writes `amount: 25` in major units. `partial` is `2500 < 4900`, which is `true`. The test asserts all of these values.
- **Missing or malformed amount.** `minorUnitsOrNull` returns null for these. `queueCourseMoneyBack` then falls back to the full paid amount, with `partial: false`. That was already the behaviour for a missing amount, and it is the same parsing #148 uses for membership orders, so it is not duplicated. The `dispute.opened` and `dispute.won` tests, which send no amount, still pass.
- **`total_amount`.** The `total_amount` branch is unchanged. `refund.succeeded` (`Refund.amount` is a number) still parses through `intOrNull`.
- **Idempotency.** `recordCoursePaymentEvent`, the `duplicate_event` path and `releaseCoursePaymentEvent` on throw are untouched. The existing test that sends `evt_l1` and `evt_l2` still yields exactly one `refund` event.
- **Status.** `dispute.lost` still sets the order to `charged_back` through `reverseCourseOrder`, and the new test asserts it.
- **Export.** Exporting `minorUnitsOrNull` only adds a public name; nothing else changes.

### Findings (non-blocking)
1. A numeric `d.amount` that is not an integer (for example `25.5`) used to be accepted. Now `intOrNull` rejects it, so the analytics event falls back to the full paid amount. Dodo sends integer minor units, so this is stricter and arguably more correct. It matches the membership path.
2. Nothing tests a course order with a malformed dispute amount (for example `'25.00'`) falling back to the full paid amount with `partial: false`. The helper itself is covered by the #148 tests. A one-line case would pin the fallback for courses. Optional.

No blocking issues.
