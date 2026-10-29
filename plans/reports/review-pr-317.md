# Review: PR #317, composition widgets (tabs, stat, steps, comparison, progress)

- PR: mrgoonie/zuey-me#317 (Closes #73, epic #4)
- Head: `af3bc93b6da5ceb01895856f377f6551d0647094`, one commit on `origin/main` 3d14c0f (the current tip)
- Reviewer: a fresh-context agent, read-only. Nothing was pushed, commented or relabelled.
- Date: 2026-10-25

## Verdict: CHANGES

There is one blocking defect: a rating value is rounded in every text output. Everything else is solid or a non-blocking follow-up.

## Gates (run in a temporary worktree at af3bc93)

| Gate | Result |
| --- | --- |
| `bun install --frozen-lockfile` | OK (744 packages) |
| Focused: `tests/composition-widgets.test.ts`, `tests/tabs-dom.test.ts`, `tests/v1-documents-compat.test.ts` | 38 pass, 0 fail, 4 snapshots |
| Full `bun test` | **2050 pass, 0 fail** across 116 files |
| `bun run build` | `astro check`: **0 errors, 0 warnings** (924 files). Build complete. The client gets a separate `TabsBlock` chunk of 2.24 kB (1.18 kB gzip). |
| `gh pr checks 317` | `Test & Build` **pass** (2m54s) |
| Scope: `git diff --stat origin/main...af3bc93` | Exactly the 23 intended files, +2696/−26. No reverts and no deleted tests. The only change to `v1-documents-compat.test.ts` adds the 5 new schema names to the exclusion list. |

Cleanup: the temporary worktree (`%TEMP%\rv317`, which held its own `dist`) was removed and pruned. The main checkout has no `dist` or `.wrangler`.

## Findings

### 1. [Medium, BLOCKING] A rating is rounded to whole stars in every text output, including screen-reader text

- **Files:**
  - `src/lib/blocks/widget-format.ts:76-82` (`progressText`, which uses `block.decimals`, default 0);
  - `src/components/blocks/CompositionBlocks.tsx:226` (`aria-valuetext`);
  - `src/lib/notifications/article-email-render.ts:263` (the email stars use `Math.round`).
- **Scenario:** `{type:'progress', variant:'rating', items:[{label:'Q', value:4.5}]}` validates. I checked it with a probe against the head:
  - the visible value reads `5 / 5`;
  - `aria-valuetext` is `"5 trên 5 sao"`;
  - Markdown is `- **Q:** 5 / 5 ★`;
  - AI text, search text and the email text say the same, and the email shows 5 filled stars.
  - Only the CSS star fill and `aria-valuenow=4.5` keep 4.5. Screen readers announce `aria-valuetext`, not `aria-valuenow`.
  - A value of 4.6 renders as a perfect 5/5.
- **Why it blocks:**
  - The PR caveat says the screen-reader text shows 4.5. That is wrong.
  - The playbook promises that Markdown and Zuey AI get canonical numbers. For ratings they get a rounded number, so AI answers and the `.md` export misstate the data.
  - A star rating that rounds up to "perfect" misleads readers in a way that ordinary bar rounding (72.6 → 73%) does not.
- **Fix (small):** choose one:
  - (a) For `rating` (or all progress/stat values), reject values that need more precision than `decimals`, with a 422 message such as "set decimals: 1".
  - (b) Default the displayed decimals to the value's own precision when `decimals` is absent.
  - Then use the same value for the email stars, so a half star is not shown as a full one, and add a test for 4.5 with no `decimals`.

### 2. [Low, non-blocking] Studio number inputs show stale values after a reorder, removal or JSON edit

- **Files:**
  - `src/components/studio/CompositionFields.tsx:24-26` (`NumInput` keeps its own `raw` state; `shown` prefers `raw` whenever `Number(raw) !== value`);
  - `:175-176` (`SparklineInput` never resyncs);
  - the items are keyed by index (`:120`, `:193`, `:358`).
- **Scenario:** a stat block has items with values 10 and 20. Remove item 1. The remaining item's value is 20, but its input still shows `10`. The value stored and saved is 20, so what the author sees disagrees with the document. The same happens after moving an item or editing in the JSON tab.
- **Fix:** resync `raw` when `value` changes from outside, or key items by a stable id.

### 3. [Low, non-blocking] Studio: moving tab 0 changes which tab opens first

- **File:** `src/components/studio/CompositionFields.tsx:121`
- **Scenario:** when `defaultTab` is undefined (that is, 0), the remap compares `block.defaultTab === i` against `undefined`. Moving tab 0 down therefore leaves `defaultTab` unset, and the tab that moves into first place becomes the default.
- **Fix:** use `(block.defaultTab ?? 0)` in the remap.

### 4. [Info, non-blocking] A paywall-cut tabs block or comparison can fall below its authoring minimum

- **File:** `src/lib/blocks/paywall.ts` (`keepItems`)
- **Behaviour:** a non-member can receive one tab or one option. I checked the truncated document with a probe:
  - `validateDocument(truncated)` fails with "must contain 2–8 tabs".
  - The reader renders it without trouble: the tab list has one tab and the comparison has a single column.
- **Can it crash the reader or a re-save? No:**
  - Every `readStoredDocument` and `validateDocument` call site reads the full stored document from D1 (articles.ts, ai/context, the search indexer and the taxonomy code).
  - Admins and writers always get the full document (`canReadFull`), so a truncated document never comes back through a write.
- **Other checks:** `defaultTab` is remapped correctly, or dropped when the default tab was withheld. Withheld tabs, options and their matrix columns are not sent, so nothing leaks.
- The PR body documents this behaviour and a test covers it. It is acceptable as is.

### 5. [Info, non-blocking] Email keeps or drops each widget whole

- **File:** `src/lib/notifications/article-email-render.ts:362-365`
- The body budget is checked per top-level block. A large tabs block that comes first (up to 8 tabs × 50 blocks) is always kept, because the first part is always pushed. Cards and toggles already work this way, so this is not new risk. The PR documents it.

### 6. [Info, non-blocking] Test gaps

- `tests/tabs-dom.test.ts` has no case for a malformed fragment such as `#%E0%A4%A`. The code guards it (`TabsBlock.tsx:15`, where `decodeURIComponent` is wrapped in try/catch), so the gap is only in coverage.
- There are no behaviour tests for the Studio editor beyond the nesting menu and `newBlock` validity, which is why findings 2 and 3 went unnoticed.

## Checked and fine

1. **Schema validation.**
   - Limits are bounded and consistent between the validator and the OpenAPI schema: tabs 2–8 with 50 children per tab, stat 1–8, sparkline 2–50, steps 1–20, comparison 2–4 options with 10 pros/cons and 30 features, progress 1–12 items and 5 thresholds, labels 120, affixes 20, decimals 0–4, numbers |x| ≤ 1e15.
   - Nesting (`nesting.ts`):
     - `inWidget` carries down through toggles, cards and layouts, so no item widget can appear at any depth inside another item widget;
     - a toggle excludes tabs;
     - a section is top-level only.
   - The v1 OpenAPI snapshot is unchanged, and the `BlockToggle` description was kept on purpose.
   - In lenient (stored) mode, an anchor that is reserved or duplicated is dropped instead of failing the whole block.
2. **XSS.**
   - There is no `dangerouslySetInnerHTML`, `set:html` or `innerHTML` anywhere in the diff.
   - The web renderers use React text nodes and the existing `Inline` renderer.
   - The email output passes every field through `escapeHtml` or `inlineHtml`, and the style values are constants.
   - Anchors must match `ANCHOR_RE` and are checked against `RESERVED_ANCHORS` and the shared section namespace. Block ids are restricted to `[A-Za-z0-9_-]{1,64}`, which I checked with a probe. The derived `-tab-N`, `-panel-N` and `-meter-N` ids are therefore safe.
3. **Tabs.**
   - Roles are `tablist`, `tab` and `tabpanel`, with `aria-selected`, `aria-controls`, `aria-labelledby` and a roving `tabIndex`.
   - Keys: Left and Right wrap, Home and End jump to the ends.
   - Without JavaScript every panel shows under its own heading.
   - The first client render matches the server, and nested blocks keep their node identity (covered by a happy-dom test).
   - The hash handler is guarded, and unrelated fragments are ignored.
   - `replaceState` is wrapped in try/catch.
   - `.zb-tab-panel[hidden]` keeps hidden panels hidden.
4. **Edge constraints.**
   - There are no Node builtins, and no `any`, `as any` or unchecked member casts (I scanned every added line).
   - `TabsBlock` follows the existing `import.meta.env.SSR` static/lazy pattern of ChartV2 and Table. On SSR it is static, so the first render matches. The client gets its own chunk.
5. **The reduced-motion CSS** applies only under `prefers-reduced-motion: no-preference`. Each state colour is also given as text.
6. **Localization and read modes** list all the new text fields for translation. Numbers, anchors and affixes stay as in the source.
7. **Docs.**
   - `docs/agent-article-playbook.md` gets a new "Composition widgets" section, and `README.md` is updated.
   - `BLOCK_SCHEMA_NOTES` and the toggle note are updated.
   - The `Block{Type}` schemas are generated from the registry into `/api/openapi.json` and Scalar `/docs`, and a test asserts that.
   - The `block_schema` MCP examples are registered in `schema-view.ts`.
   - The playbook should gain one line about rating decimals once finding 1 is fixed.

## Required before merge

1. Fix finding 1, so that rating text, aria text, Markdown, AI text and email all keep fractional ratings, and add a test.

## Follow-ups (non-blocking; file separate issues per AGENTS.md)

- Finding 2: Studio `NumInput` and `SparklineInput` show stale values.
- Finding 3: the Studio `defaultTab` remap when tab 0 moves.
- Finding 6: add a malformed-hash test to `tabs-dom.test.ts`.

Status: DONE
Summary: CHANGES. One blocker: a rating is rounded in every text output (4.5 shows as "5 / 5" in aria-valuetext, Markdown, AI text and email). Gates are green: bun test 2050/0 and the build has 0 errors and 0 warnings. CI Test & Build passes, and the scope is the 23 intended files.

---

## Round 2: head `dfe0913bc9dd5c9f68374c7b7da6117c2e3f01f3` (rebased onto `origin/main` e995b32)

### Verdict: MERGE

Finding 1 is resolved. One new Low item is a non-blocking follow-up.

### What changed

The branch is now two commits, `c10e441` (the feature) and `dfe0913` (the fix). The fix (`git diff c10e441 dfe0913`) touches 4 files:
- `src/lib/blocks/widget-format.ts`:
  - with no `decimals`, `canonicalNumber` now uses `toFixed(4)` and strips trailing zeros;
  - `decimals` is optional in both `canonicalNumber` and `localeNumber`.
- `src/lib/notifications/article-email-render.ts:276`: email stars use `Math.floor`, so a partial star shows as empty and the rating is never overstated.
- `tests/composition-widgets.test.ts`: a new test covering every output.
- `docs/agent-article-playbook.md`: one sentence on default precision.

The rest of `git diff af3bc93 dfe0913` (courses, taxonomy, tags, analytics docs) comes from the rebase onto `main`, not from this PR.

### Blocker check (finding 1)

Every formatter caller goes through `canonicalNumber` or `localeNumber`, and every one passes `decimals` through as optional. I searched all of `src/`:
- the page text and aria in `CompositionBlocks.tsx:67,214`;
- Markdown, search and AI text in `composition.ts:268-294,571-578`;
- the email HTML and text in `article-email-render.ts:233,268,310,338`.

The new test asserts the same outputs:

| Output | Asserted value |
| --- | --- |
| vi page text | `4,5 / 5` |
| vi aria-valuetext | `"4,5 trên 5 sao"` |
| en aria-valuetext | `"4.5 out of 5 stars"` |
| Markdown | `4.5 / 5 ★` |
| Search text | `4.5 / 5` |
| AI text | `Điểm 4.5 / 5` |
| Email HTML | `<strong>4,5 / 5</strong>` with `★★★★☆` |
| Email text | `4,5 / 5` |
| Stat without `decimals` | `2.15%` |

**Resolved.**

### Float artifacts (probed with `bun` at the new head)

| Input | Canonical | vi | en |
| --- | --- | --- | --- |
| 0.1+0.2 | 0.3 | 0,3 | 0.3 |
| 1.23456789 | 1.2346 | 1,2346 | 1.2346 |
| -1.5 | -1.5 | -1,5 | -1.5 |
| -0.00004 | 0 (no "-0") | 0 | 0 |
| -1234567.125 | -1234567.125 | -1.234.567,125 | -1,234,567.125 |
| ±1e15 | ±1000000000000000 | ±1.000.000.000.000.000 | ±1,000,000,000,000,000 |
| 1e-7 | 0 | 0 | 0 |
| 100, 10.5, 0 | 100, 10.5, 0 | 100, 10,5, 0 | 100, 10.5, 0 |

- Separators are correct in both locales. A delta of 0.00004 shows `0` with no `+` sign.
- **[Low, non-blocking] Very large fractional values show binary noise:**
  - `999999999999999.9` → `999999999999999.875`;
  - `123456789012345.67` → `123456789012345.6719`.
- **Why:** above about 1e11, `toFixed(4)` prints digits beyond double precision.
- **Fix:** `String(Number(value.toFixed(4)))`, which is the shortest round-trip form. It needs no exponent handling, because values are capped at |x| ≤ 1e15 and anything below 1e-4 rounds to 0.
- **Not blocking:** realistic figures this large are whole numbers. An explicit `decimals: 4` hits the same pre-existing `toFixed` behaviour.

### Existing articles and snapshots

- `canonicalNumber` and `localeNumber` are used only by the five new widgets, and none of them exist on `main` yet. No stored document can change its rendering.
- The 4 snapshots (the v1 schemas) pass unchanged, and no existing test was edited.

### Scope

- `git diff --stat origin/main...dfe0913` lists the same 23 files, +2731/−26.
- No reverts and no deleted tests.

### Gates (temporary worktree `%TEMP%\rv317b`, run one at a time)

| Gate | Result |
| --- | --- |
| `bun install --frozen-lockfile` | OK |
| Focused: the 3 PR test files | 39 pass, 0 fail, 4 snapshots |
| Full `bun test` | **2067 pass, 0 fail** across 117 files |
| `bun run build` | `astro check`: **0 errors, 0 warnings** (925 files). Build complete. |
| `gh pr checks 317` | `Test & Build` **pass** (2m33s) at head dfe0913 |

Cleanup: the worktree, its `dist` and its `node_modules` are removed and pruned. No `.wrangler` was created.

### Follow-ups (non-blocking)

These carry over from round 1:
- finding 2 (stale Studio number inputs);
- finding 3 (the `defaultTab` remap);
- finding 6 (malformed-hash test).

New:
- large fractional values show float noise (above).

Status: DONE
Summary: Round 2 MERGE. The rating-rounding blocker is fixed in every output, and the new test covers each one. Tests 2067/0, build 0 errors and 0 warnings, CI passing, scope 23 files. One new Low follow-up: float noise above about 1e11.
