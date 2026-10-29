# Review: PR #313 (Closes #307)

Head: `3a0ff51`. Reviewed in a fresh worktree; read-only.

## Verdict: MERGE

The fix does what #307 asks: the rounding fallback now runs whenever `raw` fails `NUMBER_RE` and `|n| < 1e15`. `1.23456789012` formats as `1,2345678901` (vi) and `1.2345678901` (en). Nothing blocks the merge.

## Evidence

- Scope: `git diff --stat origin/main...3a0ff51` shows 2 files, `src/lib/blocks/chart-data.ts` (+3/-2) and `tests/chart-v2.test.ts` (+18).
- `bun test tests/chart-v2.test.ts tests/chart-v2-dom.test.ts`: 29 pass, 0 fail, 208 expects.
- CI `Test & Build`: pass (run 40177253143).
- I also ran an ad-hoc script against the PR code to probe edge cases (results below).

## When the new branch fires

With no `decimals`, `raw` is `String(Number(n.toPrecision(12)))`. For `|n| < 1e15` it fails `NUMBER_RE` in only three cases:

1. `1 <= |n| < 10` with 11 decimals. This is the case from #307. The value now rounds to 10 decimals: `9.99999999999` becomes `10`, and `1.00000000005` becomes `1.0000000001`. That is correct.
2. Exponent forms (`|n| < 1e-6`). These are unchanged from before, since `|n| < 1` already covered them.
3. `999999999999500 <= |n| < 1e15`, where 12 significant digits round up to 16 digits. These values now print grouped instead of ungrouped.

Values that already passed `NUMBER_RE` take exactly the same path as before. That covers every typical value, all tick steps and `0.1+0.2` (which still prints `0,3`).

## Findings

| Sev | File:line | Scenario |
|---|---|---|
| Low | `src/lib/blocks/chart-data.ts:43` | `axis.decimals` is ignored inside the 1e15 band. With `{decimals: 0}`, `999999999999999.5` gives `toFixed(0)` = `"1000000000000000"` (16 digits). That fails the regex, so the code falls through to `toFixed(10)` and prints `999.999.999.999.999,5`. That breaks the documented rule that fixed decimals apply when the axis sets them. Before this PR it printed `1000000000000000`. This only happens with `decimals: 0` and a fractional part of at least .5 just below 1e15, which is not realistic chart data. A possible fix: `axis?.decimals === undefined &&` in the guard, or round with `toFixed(axis.decimals)` there. Not blocking. |
| Info | `src/lib/blocks/chart-data.ts:43` | The binary value shows through inside the band. `999999999999999.9` is stored as `...999.875` (the gap between adjacent numbers at this size is 0.125), so it prints `999.999.999.999.999,875`. It is the exact stored value, not corruption. |
| Info | `src/lib/blocks/chart-data.ts:43` | Precision is inconsistent near 1e15. `999999999999600` prints in full (`999.999.999.999.600`), while `123456789012345` is cut to 12 significant digits (`123.456.789.012.000`). Integers stay exact because they are below 2^53, so no value is corrupted. It is just a different rule inside a narrow band. |

## Checks from the brief

- **Rounding / large integers:** for integers below 1e15, `toFixed(10)` is exact. Nothing loses precision; the band actually shows more digits than before. Values from 1e15 up are unchanged (`1e15` prints `1000000000000000`, `1e21` prints `1e+21`). `Infinity` is unchanged.
- **Negative zero:** `-0` prints `0`. `-1e-12` goes `toFixed(10)` = `-0.0000000000`, then `-0`, then `0`. `-1e-7 kg` prints `-0,0000001 kg`. The trailing-zero strip `/\.?0+$/` never eats zeros in the integer part, because `toFixed(10)` always includes a `.`. For example, `999999999999990` keeps its last zero.
- **Values with 10+ significant decimals:** only values in `[1, 10)` can reach 11 decimals at 12 significant digits. They lose one digit (rounded to 10 decimals). That matches the existing cap for small values and is what the issue asks for.
- **Other paths:**
  - CSV, Markdown and AI text are untouched. They go through `canonicalGrid` (`String(n)`) and `v2Notes` (`${r.value}`), and the new test checks that the CSV is unchanged.
  - The visible output paths call `formatChartValue`: axis ticks, tooltips, data labels, reference labels, the fallback table and the ARIA summary. They change only for values that hit the three cases above, so their output is now localized consistently.
  - The `decimals` path is affected only in the Low finding above, because `chartDecimalsMax` is 6.
- **Thousands grouping:** `formatNumber` groups the 15-digit integer part correctly. vi gives `999.999.999.999.999` and en gives `999,999,999,999,999`. Currency (`$999.999.999.999.999`) and percent (`-999.999.999.999.999%`) are correct in both editions.
- **Tests:** they cover what #307 asks for: vi and en, negative values with and without a unit, the band just under 1e15 in both editions, values from 1e15 up, `Infinity`, and that the CSV is unchanged. The one gap is `axis.decimals` inside the band (the Low finding).

## Cleanup

The temp worktree `%TEMP%\rv313` was removed and pruned, and the probe script was deleted. Nothing was pushed, no comments were posted and no labels were changed.

Unresolved questions: none.
