# Review: PR #300, chart block v2 (Closes #71)

- Head: `856c906` (base `a0c5bd6`)
- Reviewer context: fresh. I read issue #71, epic #4 (the Chart v2 section and the non-negotiables), AGENTS.md and the full diff.
- Verdict: **CHANGES**. One small accessibility fix is needed (M1). Everything else is non-blocking.

## Gates (temporary worktree at 856c906, `bun install --frozen-lockfile`)

| Gate | Result |
| --- | --- |
| Focused: `tests/chart-v2.test.ts`, `tests/chart-v2-dom.test.ts`, `tests/v1-documents-compat.test.ts` | 28 pass, 0 fail |
| `bun test` | 1929 pass, 0 fail (113 files) |
| `bun run build` (`astro check` + build) | 0 errors, 0 warnings, 69 hints |
| Worker bundle | `chart.js` appears only as a manifest path mapping (`_astro/auto.*.js`). No Chart.js code is in the worker, and `zueyChartMarks` (chart-config) is not there either |
| Client chunks | `ChartV2Block` is 9,188 B and `chart-data` is 2,614 B, both separate lazy chunks. BlockRenderer has no Chart.js code |

I skipped the dev server and Chromium check because the findings below can be read from the code. I removed the temporary worktree, `dist` and `.wrangler`.

## Findings

### M1 (Medium, blocking): reference lines and annotations have no text alternative
- **Where:** `src/components/blocks/ChartV2Block.tsx:163-181`
- **Problem:** The canvas is `aria-hidden`, and the fallback table (visible without JS, `zb-sr-only` after drawing) holds only label and series values. `references[].label/value` and `annotations[].text` are drawn only on the canvas by `chartMarksPlugin` (`chart-config.ts:99-150`).
- **Scenario:** Take the shipped `CHART_EXAMPLE`. A screen-reader user, or a reader without JS, never learns about "Mục tiêu 160" or "Ra mắt gói Pro". That is authored content, not decoration.
  - Markdown and AI text do include these marks (`v2Notes`), so only the HTML surface loses them.
  - Epic #4 makes an "accessible fallback" non-negotiable (WCAG 1.1.1).
- **Fix:** Render the same lines as `v2Notes` under the table, for example as a `<ul>`, sharing its visibility class (visible before ready, `zb-sr-only` after). Then add one SSR assertion to `chart-v2.test.ts`. `v2Notes` would need exporting, or a small shared helper in `chart-data.ts`.

### M2 (Medium, non-blocking): reference lines outside the data range disappear silently
- **Where:** `src/lib/blocks/chart-config.ts:61-70` (`valueScale`) and `:105`
- **Problem:** Chart.js auto-scales to the dataset values only. The plugin skips any reference whose pixel falls outside `chartArea`.
- **Scenario:** Data peaks at 210 and the author adds the target `{ value: 250, label: 'Mục tiêu' }`. No line is drawn and there is no warning. The author has to know to set `y.max`.
- **Fix:** Per axis, set `suggestedMin`/`suggestedMax` to the min/max of the reference values on that axis (`y` or `y2`), unless the author set `min`/`max`.

### L1 (Low): the chunk-failure fallback differs from the server table
- **Where:** `src/components/blocks/BlockRenderer.tsx`, `ChartV2Slot` (new hunk at about lines 116-143)
- **Problem:** When `x.title` is absent, the label header is an empty `<th>` (the server table says "Nhãn"/"Label"). Values are raw rather than formatted, and there is no caption or `<caption>`.
- **When it shows:** Only while the chunk is loading or after it failed (`LazyBoundary`). During hydration, React keeps the server markup.
- **Fix:** Use a generic header text, even if it is not localised.

### L2 (Low): CSV formula guard over-quotes some negative numbers
- **Where:** `src/lib/blocks/chart-data.ts:86` with `csvField(v, true)`
- **Problem:** The numeric exemption relies on `NUMBER_RE` (at most 15 integer digits and 10 decimals). Negative values outside that pattern get a `'` prefix and turn into text in spreadsheets.
- **Examples:** `-0.30000000000000004`, `-1e-7`.
- **Fix:** Exempt values for which `Number.isFinite(Number(v))` holds when building chart CSV.

### L3 (Low): some small values skip locale formatting
- **Where:** `src/lib/blocks/chart-data.ts:40-43`
- **Problem:** When the 12-significant-digit form of a value has more than 10 decimals, `NUMBER_RE` fails and the raw string is shown.
- **Example:** `0.000123456789012` prints with a `.` decimal point in the vi edition.
- **Fix:** Clamp to at most 10 decimals before formatting.

### L4 (Low, note): stricter contract for fields that were ignored before
- **Where:** `src/lib/blocks/definitions/chart.ts:187-237`
- **What changed:** The v1 validator silently dropped unknown chart fields. API/MCP payloads that sent, for example, `legend: 'right'`, `stacked: 'yes'` or `caption` with a newline used to be accepted and are now rejected with 400.
- **Stored documents are unaffected.** They were normalised on write, and the v1 snapshot is additive only.
- **Action:** This is acceptable, but worth one line in the PR body or changelog.

### L5 (Low): Studio editor edge cases
- **Where:** `src/components/studio/ChartFields.tsx`
- **Problem 1:** Series rows are keyed by index, and `RawInput` keeps its `initial` text from mount. After deleting a middle series, that row's data or x input still shows the deleted series' numbers, while the name field (controlled) shows the next series.
  - The old editor's `CsvInput` was keyed the same way, so this may be pre-existing.
- **Problem 2:** Shortening `labels` can leave an annotation `index` out of range. Saving then fails validation instead of the editor clamping or dropping the annotation.
- **Fix:** Key the rows by a stable id or by `s.name + i`, and make the label commit drop or clamp annotations.

### L6 (Low, not verified): the canvas may be squashed in fullscreen
- **Where:** `src/styles/blocks.css` (`.zb-chart-v2:fullscreen canvas { max-height: … }`)
- **Problem:** With `maintainAspectRatio: true`, a CSS `max-height` can squash the canvas on wide or short screens, because Chart.js sets the inline height from the aspect ratio.
- **Fix:** Consider setting `maintainAspectRatio: false` while in fullscreen.

## Checks that passed

**Correctness**
- Validation is kind-aware and bounded:
  - `chartText` 120, at most 10 references and 10 annotations, decimals 0-6.
  - `min < max`.
  - `currency` only with format `currency`; `date` only on a category x axis, with ISO labels.
  - `y2` only with a series whose axis is `right`; scatter `x` length must equal the label count.
- `chartForKind` drops fields the new kind cannot use. When the last right-axis series goes, it moves right-axis references to the main axis.
- Combo, stacked and area (fill `stack`/`origin`, from zero), scatter (linear x) and radar (`r` scale) configurations are correct.

**XSS and injection**
- No `dangerouslySetInnerHTML`. Labels, names and notes go through React text nodes or canvas `fillText`.
- The caption uses the existing `Inline` renderer.
- CSV headers and labels are formula-guarded, and values are canonical.
- The download filename is an ASCII slug.

**Edge runtime**
- `import('chart.js/auto')` is inside `useEffect` behind `if (import.meta.env.SSR) return`. `chart-config.ts` imports Chart.js types only.
- The static `StaticChartV2` import is used only on SSR, and is dead-code-eliminated on the client, as the separate chunk shows.
- Verified in `dist` (see Gates).

**MCP, REST and OpenAPI**
- The schema comes from the registry definition, so the OpenAPI spec and Scalar docs follow automatically.
- `BLOCK_SCHEMA_NOTES` has a chart line, and `block_schema` has the `chart_v2` example, which a test checks for validity.
- No endpoint changed.

**Accessibility**
- The legend is a `role=group` of buttons with `aria-pressed`, a focus-visible outline and a "Show all" reset.
- The data table stays as SR-only text, with a `<caption>`.
- The table stays visible with a note if Chart.js fails to load.
- With reduced motion, `animation: false`.
- The gap is M1.

**Backward compatibility**
- `isChartV2` is false for stored v1 charts, which keep `ChartBlock` (the legacy kinds are mapped by `legacyType`).
- The v1 compat snapshot is additive only.
- The legacy-only page path is unchanged.

**Other surfaces**
- Markdown, search, AI text (now with data), paywall weight, translatables (ISO date labels skipped; annotations by index survive translation) and read modes are all covered.

**Tests**
- Good breadth: validation, formatting, CSV, kind switching, config, SSR, Markdown, search, AI, weight, i18n and schema.
- The DOM tests cover legend toggles, pie slices, `none`, CSV and PNG downloads, load failure, the Studio editor and unmount.
- Gaps:
  - No assertion that reduced motion gives `animation: false`.
  - No test of the marks plugin (references and annotations).
  - No fallback test for references and annotations, which ties to M1.

## Scope: heatmap, zoom/range selection and SVG export

The scope of #71 itself is: "Giữ Chart.js cho các loại phổ biến (area, stacked, scatter, radar, combo), thêm cấu hình trục/đơn vị/formatter/annotation/reference line, legend toggle, fullscreen, export" ("keep Chart.js for the common kinds; add axis/unit/formatter/annotation/reference-line settings, legend toggle, fullscreen, export"). The PR delivers all of it. Export is covered by CSV and PNG.

Heatmap, zoom/range selection and SVG export appear only in epic #4, and each is qualified there:
- "heatmap where practical"
- "zoom/range selection where relevant"
- "PNG/SVG export where supported"

The epic also suggests keeping Chart.js for the common cases and moving rich interactions to an optional advanced engine such as ECharts.

**Verdict on scope:** this is an acceptable follow-up, not a blocking gap. A crosshair line is likewise not drawn; hover uses `interaction: index`, which is acceptable under "where relevant".

**Follow-up to file as a sub-issue of #4 (P3):** "feat(blocks): advanced chart features: heatmap, zoom/range selection, SVG export"

- **Heatmap:** a matrix kind (rows × columns × value) with a sequential colour scale and a legend. The SSR/no-JS fallback is a value table.
- **Zoom/range selection:** opt-in `zoom: true` on cartesian kinds, with wheel or pinch, drag-to-select, a keyboard-reachable reset button and no animation under reduced motion.
- **SVG export:** opt-in `svg: true`.
- **Implementation options (one decision to record in the issue):**
  - (a) Lazy-load `chartjs-chart-matrix` and `chartjs-plugin-zoom` only for charts that use them, as separate chunks, and do SVG export through a canvas-to-SVG shim.
  - (b) A separate advanced-visualisation block (for example ECharts, which has heatmaps, dataZoom and an SVG renderer natively), as the epic suggests.
- **Acceptance criteria:**
  - The epic's non-negotiables: validation, SSR table, Markdown, search and AI text, paywall, OpenAPI, MCP, Studio and tests.
  - No growth in the worker bundle.
  - No new bytes for pages without these options.

The PR body should link that issue in place of "They can be filed later if needed".

## Status

Status: DONE
Summary: CHANGES. M1, the only blocking finding: reference lines and annotations are drawn only on the canvas and are missing from the SR/no-JS fallback. Gates: focused tests 28/0, `bun test` 1929 pass / 0 fail, build 0 errors / 0 warnings; Chart.js is not in the worker. The scope deferral (heatmap, zoom, SVG) is an acceptable follow-up.

## Round 2 (head `af0b893`)

New commits since `856c906`:
- `90f083c`: restores the happy-dom patches made by `tests/chart-v2-dom.test.ts`.
- `af0b893`: the review fixes.

I worked in a fresh temporary worktree at `af0b893` and ran `bun install --frozen-lockfile`.

### Gates

| Gate | Result |
| --- | --- |
| Focused: `chart-v2.test.ts`, `chart-v2-dom.test.ts`, `v1-documents-compat.test.ts` | 32 pass, 0 fail |
| `bun test tests/chart-v2-dom.test.ts tests/analytics-funnel-dom.test.ts`, run in both orders | 31 pass, 0 fail each time |
| `bun test` | 1933 pass, 0 fail (113 files) |
| `bun run build` | 0 errors, 0 warnings, 69 hints |
| CI (`gh pr checks 300`) | Test & Build: pass. The PR is MERGEABLE and the merge state is CLEAN |
| Worker bundle | No Chart.js code. `chart.js` appears only as a manifest path |
| Client chunks | `ChartV2Block` grew from 9,188 B to 9,812 B, and `chart-data` from 2,614 B to 2,739 B; both are still lazy |
| `BlockRenderer` chunk | Grew from 37,498 B to 38,425 B (+927 B, from the richer `ChartV2Fallback`). Its static imports are unchanged; `chart-data` and `auto` appear only in the lazy-preload list, as they did at `856c906` |

I removed the temporary worktree, including its `dist` and `.wrangler`.

### Round-1 findings

| Finding | Status | Evidence |
| --- | --- | --- |
| M1: no text alternative for marks | **Fixed** | `ChartV2Block.tsx:155-158,190` renders a `<ul class="zb-chart-marks">` inside the same wrapper as the table. That wrapper is visible before the chart is drawn and becomes `zb-sr-only` afterwards, while the canvas stays `aria-hidden`. Each item reads "Reference line: label · value" or "Note at label: text". Values use the axis formatter, and the y2 axis is used for right-axis references. The lazy fallback (`BlockRenderer.tsx`, `ChartV2Fallback`) has the same list, and SSR tests cover it. The list sits in reading order right after the table, which is an acceptable reading order |
| M2: reference lines out of range | **Fixed** | `chart-config.ts:66-74,200-208`. A probe on data peaking at 210 with references 250 and -50 gave `suggestedMin -50, suggestedMax 250`. With an author `{min:0,max:200}`, only `min 0, max 200` is set and nothing is suggested. With `{max:300}`, it gives `max 300, suggestedMin -50`, so each end the author sets is respected on its own. Left and right axes are split correctly (a missing `axis` counts as left), and scatter y is widened too |
| L1: fallback differs from the server table | **Fixed** | The fallback now has a "Label"/"Nhãn" header, `th scope=row` cells, formatted values (decimals, percent, currency code, unit), the marks list and a `figcaption`. It still differs cosmetically: see Info 1 |
| L2: CSV quotes some negative numbers | **Fixed, and the guard is intact** | `chart-data.ts:92`. Values come from `chartGrid` as `String(finite number)`, so the exemption only ever covers numbers. Labels and headers still go through `csvField` with the formula guard. Probe output: `'+S`, `'=A`, `'-B` and `'@C` are prefixed, while `-1e-7` and `-0.30000000000000004` stay raw |
| L3: small values skip locale formatting | **Partly fixed**: see R2-L1 | |
| L4: stricter contract | **Done** | The PR body now has a contract note, and the follow-up is tracked in #303 |
| L5: Studio editor edge cases | **Fixed** | `ChartFields.tsx:115`: series rows are keyed by `${i}-${length}`, so removing a row remounts the `RawInput`s from props. The editor has no reorder control, so the count change covers the stale-text case. Lines 172 and 202 key the reference and annotation rows the same way. Lines 198-216 keep an out-of-range annotation and flag it with an "(không còn)" option, `aria-invalid` and a `role=alert` hint. Nothing is silently dropped. A DOM test covers it |
| L6: fullscreen canvas | **Answered with a comment, not verified** | `blocks.css` states that Chart.js lowers the drawing height to the canvas `max-height`. That is plausible and still low risk |

### Test-leak fix

**Restoration.** `chart-v2-dom.test.ts:87-133` saves `URL.createObjectURL/revokeObjectURL`, `HTMLAnchorElement.prototype.click` and `HTMLCanvasElement.prototype.getContext/toDataURL` after `register()`, then restores them in `afterAll` before `unregister()`. It also removes `IS_REACT_ACT_ENVIRONMENT` and restores `process.env.SSR`.

**Order probe.** A probe file run after `chart-v2-dom` found every patched member back in its original state. However, the same probe also passed against the old `856c906` test file. Locally, Bun did not seem to keep the argument order, so the probe proves restoration but not the original leak; green Linux CI is the evidence for the fix.

**Other patches.** I grepped both PR test files for other global or prototype patches:
- `chart-v2.test.ts:18-27` restores `process.env.SSR`.
- `chart-v2-dom.test.ts:232,273` only call the native `value` setter and do not patch anything.
- The one patch that is not restored is `mock.module('chart.js/auto')` at `chart-v2-dom.test.ts:45`: see Info 2.

### New findings

**R2-L1 (Low, non-blocking): L3 is still open for values from 1 to 10 with 11 decimals**
- **Where:** `src/lib/blocks/chart-data.ts:42`
- **Problem:** The new path only applies when `Math.abs(n) < 1`. Values from 1 to just under 10 can still produce 11 decimals at 12 significant digits, which fails `NUMBER_RE` and skips locale formatting.
- **Scenario:** Probe output in the vi edition: `1.23456789012` is shown as `1.23456789012`, with a `.` decimal point. `12.3456789012` is shown as `12,3456789012`, and `0.000123456789012` as `0,0001234568`.
- **Fix:** Use the `toFixed(10)` path whenever `NUMBER_RE` fails and `Math.abs(n) < 1e15`, not only when `|n| < 1`.

**Info 1: the lazy fallback still differs cosmetically from the server table**
- **Where:** `BlockRenderer.tsx`, `ChartV2Fallback`
- **Labels:** ISO date labels are shown raw; the server table uses `formatChartLabel`.
- **Currency:** the fallback shows `1.000 USD` where the server shows `$1,000`.
- **Missing values:** the fallback shows `''` where the server shows `0`. Validation keeps the lengths equal, so this does not happen in practice.
- **When it shows:** only while the chunk loads or after it fails. This is the deliberate trade-off that keeps the formatting code out of the chunk, so no action is needed.

**Info 2: the `chart.js/auto` module mock is not restored**
- **Where:** `chart-v2-dom.test.ts:45`
- **Problem:** `mock.module('chart.js/auto')` applies to the whole process, and Bun cannot undo it.
- **Why it is harmless now:** no other test file imports `chart.js/auto`.
- **Fix, if one is needed later:** if another DOM test ever needs the real Chart.js, give it its own process or add the mock there as well.

### Verdict: **MERGE**

M1 and M2 are fixed, L1, L2, L4 and L5 are fixed, and the test leak is fixed with CI green. All gates pass. R2-L1 is a non-blocking display issue for a narrow range of values and can go to a follow-up or a one-line fix.

Status: DONE
Summary: MERGE. Gates: focused 32/0; the DOM pair 31/0 in both orders; `bun test` 1933/0; build 0 errors, 0 warnings. CI Test & Build passes and the PR is mergeable and clean. Chart.js is still out of the worker. Nothing blocks; R2-L1 is open (Low: values from 1 to 10 with 11 decimals still skip vi formatting).
