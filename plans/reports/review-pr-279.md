# Review: PR #279, data table block v2 (closes #70, epic #4)

- Head: `feat/70-data-table-v2` @ `8708c80`. Base: `1c571be`. It merges cleanly onto the current `main` (`93ac444`): `git merge-tree` reports no conflicts.
- Reviewer: independent, adversarial. I did not write this code.

## Verdict

**Request changes (2 major, no blockers).**

What the PR gets right:
- Backward compatibility is byte-identical on every surface I probed.
- XSS is not reachable.
- CSV formula injection is closed for the realistic bypasses.
- The bundle claims are accurate.

It still misses two #4 non-negotiables:
- **Graceful loading failure:** a failed lazy chunk blanks the whole article.
- **Bounded resource usage:** content inside the caps can freeze the main thread for 0.7–1.5 s on a sort click or a keystroke.

On top of that, the Markdown/search claims in the docs and PR body are wrong, and the boolean cell breaks in cards mode.

## Gates

| Gate | Result |
| --- | --- |
| `bun test` | **1837 pass, 0 fail**, 4 snapshots, 62,430 expects, 111 files |
| `bun run build` | `astro check`: **0 errors, 0 warnings**, 69 hints (main: 70), 906 files. Build complete |
| Merge onto current `main` | Clean |

## Findings

### Major

**M1. A failed table chunk erases the entire article body.**
- Where: `src/components/blocks/BlockRenderer.tsx`, `LazyDataTable`/`DataTableSlot` (about lines 60–84).
- The cause: the client renders `lazy(() => import('./TableBlock'))` inside `<Suspense>`, and there is no error boundary anywhere in `src/`. `componentDidCatch` and `getDerivedStateFromError` are absent.
- Reproduction with React 19.2.8 (happy-dom): a lazy whose import rejects, inside Suspense, with the paragraphs `Intro`/`After` as siblings. After the failure the root's text is `""`. React unmounts the whole root on an uncaught error.
- Effect: the article is a single `client:load` island, so one 404 or network failure on `TableBlock.*.js` removes every block on the page, not just the table.
  - Deploy skew triggers this too: cached HTML pointing at a purged chunk hash after a redeploy.
- Why this matters for the PR: #4 requires "graceful loading failure" and "rich blocks degrade gracefully if client JS fails".
- The icon lazy slot has the same latent gap, so the pattern was copied. This PR extends it to a much more common block.
- Fix: wrap the slot in a small error boundary that keeps rendering the static/plain table. A `.catch` on the `import()` that resolves to a static fallback module also works.
- I could not exercise this against the production bundle in a browser:
  - `astro preview` is unsupported by the Cloudflare adapter.
  - `wrangler pages dev` crashes on the local workerd (`MessageChannel is not defined`).
- In dev mode the static `./TableBlock` import makes the abort test meaningless, because the whole island simply never hydrates and the SSR HTML stays.

**M2. Sort and search cost is unbounded by the caps (O(n log n) inline parsing).**
- Where: `src/lib/blocks/table-data.ts:245` and `:254-259`.
- `visibleRows` re-parses inline Markdown of every text cell on every keystroke (`formatCell` → `inlineToPlain`, line 245).
- The sort comparator calls `sortKey` → `formatCell` → `inlineToPlain` on **each comparison** (line 258), so a sort parses each cell about 2·log₂n times.
- Measured on the server copy of the function (bun, median). Every table passes validation (≤1,000 chars per cell, ≤100,000 total):

| Text cells | Search per keystroke | Sort per click |
| --- | --- | --- |
| 99 × 1,000 chars of `**a` | 797 ms | 1,326 ms |
| 199 × 500 chars of `**a` | 682 ms | 1,498 ms |
| 99 × 1,000 chars of `[a](https://x.y)` | 448 ms | 589 ms |
| 199 × 500 chars of `[a](https://x.y)` | 100 ms | 602 ms |
| Realistic 200 × 4 columns (47 KB, links and bold) | 7 ms | 0.4–2 ms |
| Plain text, any size | <1 ms | <1 ms |

- Authors are trusted, so this is not an attack surface. It is still a #4 "bounded resource usage" miss on the reader's main thread, and the fix is cheap:
  - Precompute per-row folded haystacks and per-column sort keys once per `block`, in a `useMemo` or a WeakMap cache in `table-data`.
  - Then search is a string scan and sort a key compare.
- There is no ReDoS: every regex is linear (`NUMBER_RE`, `DATE_RE`, `MD_LINK_RE`, the fold, `split(/\s+/)`). The search uses `includes`.
- Related: the search `<input>` has no `maxLength`. A 100,000-character pasted query takes 494 ms per change on the max table (`TableBlock.tsx:142`).

### Minor

**m1. Boolean cells break the cards layout.**
- Where: `TableBlock.tsx:42` together with `blocks.css`, `.zb-dt-cards .zb-table td { display: grid; grid-template-columns: … }`, inside `@container`.
- The boolean cell renders two nodes: the icon `<span>` and a text node ` Không`. In the two-column grid, the text node becomes its own anonymous grid item and wraps into the **label column of a new row**.
- At 375 px the card reads: `Hỗ trợ 24/7 | ✗`, then a row `Không` in the label position. Screenshot: `scratchpad\pw\shots\dt279\mobile-dt.png`.
- Fix: wrap the boolean content in one `<span>`, as `Inline` does for text cells.
- Related nit: badges in cards stretch to the full cell width, because a grid item blockifies `inline-block`. Fix with `justify-self: start`.

**m2. The docs and PR body claim formatted values in Markdown and search; the code emits canonical values.**
- Where: `docs/agent-article-playbook.md:110` says "Markdown, search and Zuey AI get the same values" (as readers). The PR body says Markdown has "formatted cells".
- Actual output (`definitions/data.ts:133-141`) for the row `Pro | 490000 | 12.5 | 2026-01-15 | true | [Xem](…)`:
  - Markdown: `| Pro | 490000 | 12.5 | 2026-01-15 | true | [Xem](https://zuey.me/p) |`, with unit-labelled headers.
  - Search text: `490000`, `12.5`, `2026-01-15`, `true`.
  - AI text: the same canonical values.
- Readers see `490.000 ₫`, `12,5%`, `15/01/2026`, `Có`. A site search for `490.000` or `Có` misses the row.
- Pick one and make the docs match. Canonical Markdown is arguably better for agents, but the search index probably wants the formatted forms too.

**m3. Formatting and labels are Vietnamese-only, including translated editions.**
- Where: `table-data.ts:105-115` and `:141`, `TableBlock.tsx:10-24`, `article-email-render.ts` (`tableCellHtml` ignores `input.locale`).
- An English edition (localization keeps typed cells as is) shows `1.234,5` for 1234.5. That reads as "one point two three four five" to an English reader.
- It also shows `Có`/`Không` and `Hiển thị n/N hàng`, and the English email does the same.
- The chrome labels follow BlockFrame's hard-coded-vi precedent. The number format, however, is actively misleading, not just untranslated.

**m4. Cards mode amplifies the SSR HTML about 95×.**
- Where: `TableBlock.tsx:183`, `data-label={block.headers[c]}` on every cell.
- With 20 × 500-char headers and 200 rows of empty cells, the document JSON is 22.5 KB. The SSR HTML is **2.15 MB** in cards mode, against 48.5 KB in scroll mode.
- The 100,000-character total cap counts headers once, not once per row.
- Fix: count `headers × rows` toward the cap for `mobile: 'cards'`, or cap the header length for data tables.

**m5. Studio column settings follow the index, not the header.**
- Where: `ArticleEditor.tsx:~493`. The comment says "Column settings follow their header", but `headers.map((_, i) => columns[i] ?? …)` is positional.
- Example: deleting the first of `A(text), B(number), C(date)` leaves `B` typed text and `C` typed number. The next save then fails with 422 on every date cell.
- Rows are not resized either, which is pre-existing.

**m6. Number formatting edge cases.**
- Where: `table-data.ts:17` (`NUMBER_RE`) and `formatNumber`.
- Leading zeros validate. `00012` renders as `00.012`, which in vi notation looks like a different number.
- `-0` renders as `-0`.
- Fix: reject or normalize leading zeros and `-0` in `canonicalCell`.

### Nits

- **Table title is unchecked plain text.** It allows newlines and raw HTML. Markdown emits `**T\n\n# Injected heading…**` and `**<img src=x onerror=…>**` verbatim (`data.ts:134`). The chart title has the same precedent, and readers and email escape correctly, so only `.md` consumers are affected.
- **Link labels.**
  - `HTTPS://…` keeps its scheme in the label, because the strip in `table-data.ts:67` is case-sensitive.
  - `https://zuey.me@evil.com` displays as `zuey.me@evil.com`; userinfo is allowed. Consider rejecting userinfo in link cells.
- **CSV.**
  - Full-width `＝1+1`, `－1` and a leading ZWSP are not guarded. They are harmless in vi/en Excel and LibreOffice; some CJK Excel builds reportedly treat `＝` as a formula.
  - Canonical `1234.5` opens as text in a vi-VN Excel (decimal comma). That is a fidelity issue, not a security one.
  - Headers are exported raw (inline markers such as `**x**` stay), while text cells are `inlineToPlain`'d.
- **Schema/validator mismatch.** The `columns[].type` schema says `required`, but the validator defaults a missing type to `text` (`data.ts` `tableColumns`).
- **Duplicate accessible name.** Untitled data tables all get the region name `Bảng dữ liệu`. With a title, both the region and the `<table>` are `aria-labelledby` the same title, so the name is announced twice.
- **Suspense fallback flash.** The `PlainTable` fallback shows raw canonical values (`490000`, `true`) and no title. That is only visible on client-only renders (Studio preview) or if hydration falls back.

## Verified OK (with evidence)

### Backward compatibility
- **Probe:** the same corpus of 7 top-level legacy tables plus 3 nested ones, run through both `main` (`93ac444`) and the PR head.
  - Top-level tables cover inline Markdown, `=1+1` / `-1+cmd|x` / `@SUM`, HTML-ish cells (`<script>`, `<img onerror>`, `</td>`), pipes and newlines, a header-only table, a 5,000-character cell, and a 20 × 200 wide table.
  - One table carries junk options: `sortable:false, columns:null, title:'', caption:null, mobile:null, csv:false`.
  - The nested tables sit in a layout column, a toggle in a layout, and a card in a section.
- **Result:** identical on every surface. Lengths and sha256 prefixes:

```
validated        73844 6a7ca8dd8166c193     stored          73877 76fcd90f014b391a
html            184438 c4b96248b1fc3bed     htmlInteractive 184438 c4b96248b1fc3bed
markdown         73217 d4dbcad8e24f8649     search          62923 a3f6af5df43925f3
ai               71988 4ee35cd8ec3acb0f     emailFull       14023 6805701da4a3ac38
emailTeaser      14427 b4764f0b241e60cf     translatables  309656 68ff5ca37cfeafa5
manifest        421342 8402e2c7283fb0fa     skeleton        13469 d4cddc85b01d5ece
weight (per block)  50 0a47e83a9ad4fc3b     paywall         70160 8c83fec37b72d1f6
```

- **Studio:** a legacy table is only rewritten when the user edits a field. Unset options are deleted, not stored as false or empty.
- **Behaviour change:** API callers that previously sent an ignored `caption` or `title` now get a data table, with the 1,000/100,000 caps and type checks. A non-boolean `sortable` is now a 422. This is consistent with the strict-validation house style.

### Security
- **Rendered output:**
  - Title, badge, link label, `data-label` and inline cells are React-escaped. Text cells with `[x](javascript:…)` render as plain text.
  - Email uses `escapeHtml` (which also escapes `"` and `'`).
  - Links get `target=_blank rel="noopener noreferrer nofollow"`.
- **Link validation:**
  - Rejected: `javascript:`, `JAVASCRIPT:`, `data:`, `http:`, `//evil`, `[x](javascript:…)`, and a link with trailing text.
  - Accepted: `https:alert(1)`, `https:\\evil.com` and `\u0001https://…`. All three are still https under WHATWG parsing, so they are safe.
- **Numeric cells cannot carry a formula.** These are all rejected by `NUMBER_RE`: `-1+cmd|' /C calc'!A0`, `−1` (U+2212), ` 1`, `1 `, `+1`, `1,5`, `1.234,5`, `1e5`, `0x10`, `Infinity`, `NaN`, Arabic-Indic and full-width digits, `1\n`, `-1\n=1+1`, 16-digit integers and 11-digit fractions.
  - The numeric exemption in `csvField` re-tests `NUMBER_RE` itself, so even an unvalidated value cannot slip through.
- **CSV output (real browser download):**
  - UTF-8 BOM `efbbbf`, CRLF line endings, RFC 4180 quoting of `"`, `,`, CR/LF and leading/trailing spaces.
  - Guarded with a leading `'`: `'=1+1`, `'=cmd|x` (from `**=cmd|x**`), `'@SUM`, `'+1`, `'\t=1`, `"line\r=1"`, and a `'=H` header.
  - The filename is an ASCII slug: `bang-gia-goi.csv`; `../../etc/passwd` becomes `etc-passwd.csv`.
  - The export follows the filtered rows and their display order.

### Caps
- 1,001-character cell: 422.
- More than 100,000 total characters: 422.
- Title longer than 200 characters: 422.
- Lowercase or missing currency code: 422.
- `decimals` on a text column: 422.
- Wrong `columns` length: 422.
- `mobile: "grid"`: 422.
- A lenient stored read drops an invalid data table and keeps its siblings (`dropped: 1`).

### Cost on the largest typed table
Mixed types, 20 × 200 cells (44 KB):

| Operation | Time |
| --- | --- |
| Validate | 0.7 ms |
| Search | 4 ms |
| Sort (any column) | ≤0.6 ms |
| All filters + search + sort | 2.8 ms |
| `filterChoices` × 20 | 0.3 ms |
| Full CSV | 1 ms |

### Browser checks
Chromium at 1280 px and 375 px, through the real `BlockRenderer client:load` island on a temporary dev page (port 4461).
- **No JS:** all 60 rows render with formatted values and the caption. There are no controls and no dead buttons.
- **Controls appear only after hydration.** Every input and select is labelled, for example `Giá từ`, `Giá đến`, `Ra mắt từ`, `Tìm trong bảng`.
- **Scroll region:** `tabIndex=0`, labelled by the title.
- **Keyboard sort:** Enter, Space, Enter cycles `aria-sort` through ascending → descending → none. Empty cells stay last.
  - The `role=status` line reads `Hiển thị 60/60 hàng, sắp xếp theo Giá tăng dần`.
- **Filters:** `ha noi` returns 11 of 60 rows (accent-insensitive). The badge select, price range and reset all work.
- **Sticky header:** stays at its top offset while the region scrolls (max-height 630 px).
- **Container query:**
  - The table inside a 373 px layout column switches to cards, even on desktop.
  - The 20-column table scrolls inside its own box.
  - No horizontal page overflow at either width.
  - No console errors.

### Bundle
Production build of the PR against `main` (`93ac444`):

| Chunk | Size change |
| --- | --- |
| Eager `BlockRenderer` | 35,436 → 35,896 B (**+460 B**, as claimed) |
| `InteractiveFrame` | +301 B |
| `StudioApp` | +7,931 B |
| CSS total | +3,459 B |
| `TableBlock` (new) | 5,842 B |
| `table-data` (new) | 4,990 B |

- The chunk graph shows `BlockRenderer` reaches `TableBlock` only through `import("./TableBlock…")`. The static `./TableBlock` import is dropped from the client bundle, so pages without a data table never fetch the chunk.
- In dev mode the static import is not tree-shaken, so the dev server always loads `TableBlock.tsx`. That is dev only.

### OpenAPI, MCP and docs
- `BlockTable` documents every field (snapshot +151 lines, insertions only).
- `block_schema` ships a validated `data_table` example, and `BLOCK_SCHEMA_NOTES` has a data-table rule.
- No endpoints changed.
- The docs are accurate except for m2.

## Suggested fixes before merge

1. M1: add an error boundary, or a catching `import()`, around `DataTableSlot` that falls back to the static table.
2. M2: precompute sort keys and search haystacks once per block, and add a `maxLength` to the search input.
3. m1: wrap the boolean cell content in a single element.
4. m2: align the docs and PR body with the actual Markdown and search output, or index the formatted values too.

## Cleanup

- Removed the temporary worktrees, including their `node_modules`, `dist/` and `.wrangler/`:
  - `scratchpad\pr279`
  - `scratchpad\main279`
  - `D:\www\zuey\zuey-me\.claude\worktrees\r279`, a short path needed because the long scratch path broke esbuild and workerd (MAX_PATH).
- The temporary probe page lived only in that worktree, so it is gone with it.
- The dev server I started is stopped.
- A separate process on 127.0.0.1:4461 (`D:\www\zuey\r272m`, another session) was left untouched.
- Probe scripts are kept in `scratchpad\r279\` and `scratchpad\pw\` (`seed-dt279.ts`, `dt279-check.mjs`, `dt279-prod.mjs`, shots in `pw\shots\dt279\`).
- Nothing was pushed, commented or merged.

## Round 2 (head `cdd744e`, rebased on `7066f88`; current `main` `e59d472`)

### Verdict

**MERGE.** All 2 major and 6 minor findings are fixed, and so are the nits the author claimed. Nothing regressed. Two small gaps that remain are filed as P3 follow-ups.

### Gates (fresh worktree at a short path, run once in the foreground)

| Gate | Result |
| --- | --- |
| `bun test` | **1869 pass, 0 fail**, 4 snapshots, 62,644 expects, 111 files (145 s) |
| `bun run build` | `astro check`: 908 files, **0 errors, 0 warnings**, 69 hints. Build complete |
| Merge onto `e59d472` | Clean. `main` moved only in analytics files |

### Backward compatibility
- The round 1 corpus gives the same lengths and sha256 prefixes on all 14 surfaces for `main` `e59d472` and the PR. They are also identical to the round 1 hashes (html `184438 c4b96248b1fc3bed`, search `62923 a3f6af5df43925f3`, and so on).
- The new search indexing and locale code only touch typed columns. A plain table resolves every column to `text`, so its output is unchanged.
- **Compat snapshot change (−3 lines) is legitimate.** It only removes `required: ["type"]` from `columns[].type`. That relaxes the documented schema to match what the validator already accepted (a missing `type` defaults to `text`). Every payload that was valid before is still valid, so this is not a breaking public-contract change.

### Claimed fixes, verified

| Finding | Status | Evidence |
| --- | --- | --- |
| **M1** lazy chunk failure blanks the article | Fixed | `LazyBoundary` (`getDerivedStateFromError`) wraps both `DataTableSlot` and `IconSlot` (`BlockRenderer.tsx:48-105`). The fallback is the plain table or the icon placeholder. The DOM test rejects a `React.lazy` inside boundary and Suspense, and the siblings survive (`IntroFallbackAfter`). The production chunk graph still reaches `TableBlock` only through `import("./TableBlock.*.js")` |
| **M2** unbounded sort and search cost | Fixed | A per-block `WeakMap` index holds display, folded and haystack text plus lazily built sort keys per column (`table-data.ts` `tableIndex`, `columnSortKeys`). Search and text-filter inputs have `maxLength={200}`. The round 1 worst cases now cost 2.5–40 ms for the one-time index build, then **0.01–0.04 ms** per keystroke or sort, down from 600–1500 ms. The test `parses each cell once per table` asserts `tableWork.cells` grows by 99 over 6 searches and 3 sorts |
| **m1** boolean cell in cards | Fixed | Single wrapping `<span>`, plus `td > * { justify-self: start }`, which also fixes the stretched-badge nit |
| **m2** search and docs mismatch | Fixed | `searchText` emits `raw formatted` for typed non-link cells (`490000 490.000 ₫`, `true Có`). The playbook now says Markdown and AI get canonical values and search gets both |
| **m3** locale | Fixed | `tableLocale`: `vi` or absent gives vi formatting, anything else gives en. Probe on `en`/`fr`/`zh`: `1,234,567.5 ₫ · Jan 15, 2026 · Yes · 12.5%`. The reader page passes `view.locale`, email uses `input.locale`, and chrome labels are translated (tests `formats English editions…`, `formats emails for the edition locale`) |
| **m4** cards HTML amplification | Fixed | `data-label` is set only when `mounted`, so SSR has no `data-label`. The 20 × 500-character header case is now **48,485 B** of SSR HTML, down from 2.15 MB. Without JS the table scrolls sideways, as documented |
| **m5** Studio header rewrite | Fixed | `headerSources` keeps the index when the count is unchanged (a rename), otherwise matches by trimmed text. Columns *and* cells move with their header. Delete-first gives `[1,2]`, insert gives `[0,-1,1]` |
| **m6** number edge cases | Fixed | `normalizeNumber` at validation: `00012`→`12`, `-0`→`0`, `-0.0`→`0.0`, `-00.50`→`-0.50`, `000`→`0` |
| Title one line | Fixed | `\n` → 422 `must be one line`. A trailing `\r` is trimmed away |
| Links with credentials | Fixed | `https://zuey.me@evil.com`, `https://u:p@x.y`, `[a](https://u@x.y)` and `https://%40@x.y` are all rejected. `HTTPS://x.y/` now shows as `x.y` |
| CSV full-width and zero-width guard | Fixed | `＝`, `＋`, `－`, `＠` and leading ZWSP/ZWJ/WJ/BOM get a `'` prefix. Headers are exported as `inlineToPlain` |
| Duplicate accessible name | Fixed | Only the scroll region carries the name (`aria-labelledby` = title, else `aria-label`). The `<table>` no longer repeats it |

Bundle: the eager `BlockRenderer` chunk is now 36,200 B, against 35,896 B in round 1. The extra ~300 B is the error boundary. `TableBlock` is 6,255 B and `table-data` 6,405 B, both lazy.

### Remaining observations (none block merge)
- **Multi-line text cells in cards mode (minor).**
  - The same grid problem as m1 remains for text cells. `Inline` renders one `<span>` per line, so `<td><span>dong 1</span><span><br/>dong 2</span></td>` puts line 2 in the label column.
  - Round 1 missed this too.
  - Filed as **#285** (P3, bug).
- **Studio previews and the search index assume `vi` (minor).**
  - `ArticleEditor.tsx` renders `BlockRenderer` without `locale` (preview, history and validation views).
  - `searchText` formats with the default `vi`, so an English edition is not indexed as `1,234.5` or `Yes`.
  - Filed as **#286** (P3, enhancement).
- **Plain fallback is unformatted (author leftover).** Not filed. It shows only while the chunk loads on client-only renders, or after a chunk failure. Formatting it would pull `table-data` into the eager bundle. The trade-off is documented in #286.
- **CSV decimal point in vi-locale Excel (author leftover).** Not filed. The CSV deliberately holds canonical, machine-readable values (documented in the playbook), and localizing it would break other locales and re-imports.
- **Nits, not filed:**
  - `1.005` with 2 decimals shows `1,00` (`toFixed`).
  - Leading U+200E/U+202E before `=` is not guarded. Spreadsheets treat these as text.
  - `headerSources` treats a rename and an insert in one commit as two new columns, so that column's cells are dropped. Studio commits on blur, so this is rare.

### Cleanup
- Removed worktrees `D:\www\zuey\zuey-me\.claude\worktrees\r279b` (with its `node_modules` and `dist/`) and `r279m`.
- No `.wrangler/` was created.
- The local ref `pr279-r2` was deleted.
- Other sessions' `bun` processes on the host were left alone.
- I did not push, comment on, or merge the PR. The only GitHub writes were issues #285 and #286.