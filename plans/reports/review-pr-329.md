# Review: PR #329 (Closes #326), head 0fb41df

fix(blocks): trim large fractional widget values to their real precision

## Verdict: MERGE

No blocking or major findings. The change is one line. It fixes the reported junk digits and does not change output for any value the schema accepts.

## Scope

`git diff --stat origin/main...0fb41df` lists only:
- `src/lib/blocks/widget-format.ts` (+3/-1)
- `tests/composition-widgets.test.ts` (+22)

## Verification

### 1. Exponent notation: no regression
- **Small values.** `toFixed(4)` rounds first, so the smallest non-zero result is `0.0001`. That is above the 1e-6 point where `String()` switches to exponent form. Results: `1e-7` and `-1e-7` give `"0"` (the `-0` guard holds), `0.00005` gives `"0.0001"`, `-0.00004` gives `"0"`.
- **Large values.** `1e21` gives `"1e+21"`, the same as on `main`: `toFixed` already returns exponent form at 1e21 and above, and the old regex left it alone. `localeNumber` would also print `1e+21` unchanged. This case cannot occur, though. `LIMITS.widgetNumberMax = 1e15` (`src/lib/blocks/schema.ts:92`) is enforced in `src/lib/blocks/definitions/composition.ts:101-102`, plus the JSON-schema min/max at `:157`. The probe confirmed that `validateDocument` rejects a stat value of 1e21. NaN and Infinity are rejected by the same `Number.isFinite` check.
- **Negatives.** `-123456789012345.67` gives `-123.456.789.012.345,67` (vi) and `-999,999,999,999,999.9` (en). The sign handling in `localeNumber` works as before.
- **Below 1e15.** Old and new agree whenever `toFixed(4)` is already exact. `String(Number(s))` of a plain decimal string returns the same digits with trailing zeros trimmed. Output differs only where `toFixed` printed binary noise.

### 2. Explicit `decimals`: unchanged
The `value.toFixed(decimals)` branch is untouched. Probe results: `(123456789012345.67, 2)` gives `.67`, `(1.005, 2)` gives `1.00`, `(-0.001, 2)` gives `0.00`, `(4.5, 0)` gives `5`. All match `main`.

### 3. Callers (probe with the PR's test values)
The probe used a stat with value `123456789012345.67`, delta `-999999999999999.9`, sparkline `[1, 123456789012345.67]`, a negative item, and a progress bar with max `999999999999999.9`. No output contained junk digits (`6719`, `.875`) or exponent notation:

| Output | Result |
| --- | --- |
| Page (vi) `BlockRenderer` | `123.456.789.012.345,67`, `-999.999.999.999.999,9` |
| Page (en) | `123,456,789,012,345.67` |
| Progress aria (vi) | `aria-valuetext="123.456.789.012.345,67 / 999.999.999.999.999,9"` |
| Markdown `documentToMarkdown` | `123456789012345.67`, `-999999999999999.9` |
| AI `documentText` | canonical, clean |
| Search `documentText` | canonical, clean |
| Email HTML and text (vi) | `123.456.789.012.345,67`, `-999.999.999.999.999,9` |

## Findings

| Severity | Location | Scenario |
| --- | --- | --- |
| Info (pre-existing, out of scope) | `src/lib/blocks/widget-format.ts:19` (explicit-`decimals` branch) | An author who sets `decimals: 3` or `4` on a value above about 1e11 still gets `toFixed` noise, e.g. `canonicalNumber(123456789012345.67, 4)` gives `…345.6719`. #326 covers only the unset case, and such inputs are not realistic. File a P3 issue only if you want the explicit path fixed too. |
| Info | `tests/composition-widgets.test.ts:326-346` | The test covers both signs, both locales, ±1e15, `-0` and small values. No gap. |

## Gates (fresh worktree at 0fb41df, run one at a time)
- `bun install --frozen-lockfile`: OK, 744 packages
- `bun test tests/composition-widgets.test.ts`: 31 pass, 0 fail
- `bun test`: 2077 pass, 0 fail (117 files)
- `bun run build`: astro check 0 errors, 0 warnings (76 hints); build complete
- `gh pr checks 329`: Test & Build pass (2m50s)
- No endpoint changes, so OpenAPI is unaffected.

## Cleanup
The temp worktree (`%TEMP%\rv329`, including its `dist`, `.wrangler` and `node_modules`) is removed and pruned. The probe file is deleted. Nothing was pushed, commented or relabeled.
