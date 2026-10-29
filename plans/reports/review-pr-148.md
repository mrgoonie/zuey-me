# Review: PR #148 (closes #128)

Head `e6dfcfde2e4929367e128c03bb18bc192cd88ea1`, base `main`. Reviewed in a fresh worktree; the PR merges cleanly with current `origin/main` (no overlap in touched files).

**Verdict: APPROVE**

## Gates

- `bun test`: 1011 pass, 0 fail (55 files)
- `bun run build`: astro check 0 errors, 0 warnings (65 hints), build complete
- Tests fail without the fix: reverting only `src/lib/payments/dodo.ts` to its parent gives 32 pass, 2 fail in `tests/analytics-outbox.test.ts` (the lost-dispute flow test and the new parse test); restoring it gives 34 pass, 0 fail.
- No endpoint changes, so OpenAPI is unaffected.

## Verification

- **Strict parsing** (`minorUnitsOrNull`, `src/lib/payments/dodo.ts`): strings are trimmed, then must match `/^\d+$/` (no `u` flag, so ASCII 0-9 only) and pass `Number.isSafeInteger`. The regex runs before `Number()`, so `Number('')` and `Number('  ')` (both 0) are never reached. Probed directly: `'0x10'`, `'+5'`, `'1_000'`, Arabic-Indic `'٩٠٠'`, fullwidth `'９００'`, `'9007199254740992'`, `NaN`, `Infinity`, `true`, `null` and `[900]` are all null; `'9007199254740991'`, NBSP-padded `'900'`, `'900\n'`, `'0900'` (900) and `'0'` parse. All as intended.
- **Scope**: only the reversal `amount` uses the new helper. `recurring_pre_tax_amount`, `total_amount` and `tax` still use `intOrNull`. The diff touches only that one line plus the helper and tests.
- **Units**: `event.amount` stays in minor units. It goes to `recordEvent` and the `billing.card_reversal` activity log as minor units (900), and to the refund analytics builder as `amountMinor`, where `toMajorUnits` divides USD by 100 (9). The test asserts both. This matches the existing cents-to-dollars convention in `src/lib/analytics/commerce-events.ts`.
- **Regressions**: none found. Integer amounts (refund payloads) go through `intOrNull` exactly as before.
- **Course orders**: not touched, which is correct. They are tracked in #149.

## Notes (non-blocking)

- A negative number (not a string), such as `-1`, still passes through `intOrNull`. This is how it already behaved before this PR, and Dodo sends disputes as strings and refunds as non-negative integers, so it is not a real risk. No change needed here.

## Unresolved questions

None.
