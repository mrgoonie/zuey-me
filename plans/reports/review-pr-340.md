# Review: PR #340 (Closes #332)

`fix(blocks): clamp explicit widget decimals to the precision a double holds`
Head `fefa95faf912da345b6c2242d9f3c6f7b5a98fde`. Reviewed in isolated worktree `%TEMP%\rv340` (removed afterwards).

## Verdict: MERGE

No blocking or medium findings. The fix is correct, it only changes output where `toFixed` printed float noise, and every gate is green.

## Scope

`git diff --stat origin/main...head` lists only the 2 files: `src/lib/blocks/widget-format.ts` (+9/-2) and `tests/composition-widgets.test.ts` (+66).

## Author's claims, checked

| Claim | Result |
| --- | --- |
| Noise starts at 2^39 (4 places), 2^43 (3), 2^46 (2) | Confirmed, plus 2^49 for 1 place. I swept k/10^d steps for 20,000 steps on each side of each threshold and at half the threshold. There were 0 differences from `toFixed` below each threshold and 736 / 2080 / 2400 / 4000 above it. In a 400k-value random sweep, the smallest differing value was at log2 = 39.003 / 43.0005 / 46.001 / 49.006. |
| Normal values unchanged | Confirmed. 2.4M comparisons covered random values in +-1e15 (raw, rounded to 4 places, and integers) at decimals undefined/0-4. Output differed from main's formatter 0 times below the threshold. The `decimals` undefined path matched main every time. |
| 3 of 4 new tests fail on main | Reproduced. With main's `widget-format.ts` swapped in: 32 pass, 3 fail (`…345.672`, `-…345.672`, `549755813888.0031`). The normal-values test passes on both. File restored with `git checkout`. |

## Edge cases checked (probe script, since deleted)

- **Negatives**: these mirror the positives, e.g. `-123456789012345.67` at 2 places gives `-123456789012345.67`, and `-999999999999999.9` at 2 or 4 places gives `-999999999999999.9`.
- **-0 and tiny negatives**: `-0` gives `0` / `0.00` / `0.0000`. `-0.004` at 2 places gives `0.00`. `-0.0001` at 4 places gives `-0.0001`. All match main. No output was ever `-` plus a zero value.
- **`decimals` 0**: always the same as main, because `padded` is the integer part and integers up to the 1e15 cap are exact.
- **Whole numbers up to the cap**: `1e15` at 4 places gives `1000000000000000.0000`, and `-1e15` at 2 places gives `-1000000000000000.00`. Trailing zeros are kept because an integer double's `toFixed` always pads.
- **0.1+0.2**: `0.30` at 2 places, `0.3000` at 4, `0` at 0, and `0.3` with no `decimals`, all as before. `1.005` gives `1.00` and `2.675` gives `2.67`, the same as `toFixed`.
- **Fallback output**: when the shortest form is used, it always parses back to the same double as `toFixed`'s output, never has more places than requested, and never uses exponent notation. Validation guarantees this: `decimals` is an integer 0-4 and every value is finite with absolute value at most 1e15 (`finiteNumber`, `LIMITS.widgetDecimalsMax`), so `String(Number(fixed))` stays in plain notation.

## Callers

The callers below all go through `canonicalNumber`, either directly or through `localeNumber`. None of them changes output below the thresholds.

- `src/lib/blocks/definitions/composition.ts`: stat AI text, sparkline trend, `sparkRange`, `searchText`, progress Markdown, AI text and scale text.
- `src/components/blocks/CompositionBlocks.tsx`: display and aria, through `localeNumber`.
- `src/lib/notifications/article-email-render.ts`: email, through `localeNumber`, `statValue`, `statDelta` and `progressText`.

`localeNumber` splits on `.` and handles the shorter fraction correctly: `123.456.789.012.345,67` (vi) and `-1,234.50` (en). The `+` sign check in `statDelta` and the `/\.?0+$/` strip in `sparkRange` are unaffected, because the fallback never returns an integer when `decimals` > 0.

## Type rules

There is no `any`, no `as` cast and no unchecked member access in the diff.

## Findings

- **Low (design note, no change needed)**: above the threshold, an item now shows fewer places than its `decimals` asks for. For example, a sparkline with `decimals: 4` that mixes values above and below 2^39 will show `549755813888.003` beside `12.3400`. This is the intended trade-off from #332: the extra digits were never real. The JSDoc says so.
- **Nit**: the test comment "The double sits exactly between .2 and .3" is accurate (2^49 spacing is 0.125, so `.2` parses as `.25`), but it could add "at 2^49" for clarity. Optional.

## Gates (run one at a time, in the foreground)

| Gate | Result |
| --- | --- |
| `bun test tests/composition-widgets.test.ts` | 35 pass, 0 fail |
| `bun test` | 2126 pass, 0 fail, 118 files |
| `bun run build` | astro check: 0 errors, 0 warnings, 80 hints (all from before this PR); build complete |
| `gh pr checks 340` | Test & Build: pass (3m12s) |

No endpoints changed, so the OpenAPI/Scalar check does not apply.
