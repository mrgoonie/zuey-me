# Review: PR #250, Math v2 with KaTeX (closes #68, epic #4)

- Head: `6ff047f` (`feat/68-math-katex`), 2 commits, 22 files, +656/-44
- Reviewed in an isolated worktree (`.claude/worktrees/review-250`, now removed). Reviewer did not write this code.
- Date: 2026-10-23 (Asia/Saigon)

## Verdict: APPROVE

There are no blockers and no majors. The security, paywall, bundle-isolation and compatibility claims hold up under direct probing. The findings below are minor or nit, and they can be fixed in a follow-up.

## Evidence

| Check | Result |
| --- | --- |
| `bun install` | 744 packages, KaTeX 0.19.0 |
| `bun test` run 1 | **1643 pass, 0 fail** (99 files, 119.5 s) |
| `bun test` run 2 | **1643 pass, 0 fail** (85.9 s) |
| ZueyOS tests (4 files) run while `bun run build` was compiling | 56 pass, 0 fail (12.2 s) |
| `bun run build` | **0 errors, 0 warnings**, 69 hints, Complete |
| `dist/_worker.js` total | 467 files, **10,363 KiB raw, about 2,850 KiB gzip** (sum of per-file gzip, including the 2.4 MiB wasm) |

## Security (XSS / injection / DoS)

`src/lib/blocks/math-render.ts:26-37` sets `trust: false`, `maxSize: 20`, `maxExpand: 1000`, `throwOnError: true` with a catch, and a fresh `macros: {}` on every call. I confirmed these with a probe script that calls `renderTex` directly.

- `\href{javascript:…}`, `\url{javascript:…}`, `\htmlClass`, `\htmlId`, `\htmlStyle`, `\htmlData{onerror=…}` and `\includegraphics` all render as red command names. The output has no `href=`, `src=`, injected class, id, `data-*` or style.
- Raw `<img onerror>` and `<script>` in TeX, `\text{"><img …>}` and `\operatorname{"onmouseover=…}` come out as escaped text (`&quot;&gt;&lt;img…`) inside `<mtext>`, `<mi>` and `<annotation>`. They are never inside an attribute.
- `\color{red;background:url(...)}` and `\colorbox{url(x)}` are rejected as invalid colours.
- `\rule{1000em}{1000em}` is clamped to `20em`, and `\kern{1000em}` is clamped to `margin-right:20em`. `.zb-math-formula` has `overflow-x:auto; overflow-y:hidden`, so negative kerns and raised boxes are clipped to the formula row.
- `\gdef\foo{BAR}\foo` followed by `\foo` in the next call raises "Undefined control sequence", so nothing leaks between formulas.
- `\def\a{\a}\a`, nested `\def` bombs and `\edef` bombs each stop at "Too many expansions" in under 5 ms.
- Copy TeX: `BlockFrame` uses a `copyText` closure, so there is no data attribute to break out of. The `<details>` source and the `aria-label` on `TexSource` are React-escaped children and props (`src/components/blocks/MathBlock.tsx:107,182`).
- The only `dangerouslySetInnerHTML` is `MathBlock.tsx:162`, and its input comes only from KaTeX output.

## Paywall

- The article page typesets `view.document.blocks`, which is the document after `applyPaywall`. The lesson page typesets `lessonSegments(view.document.blocks)`, and `view.document` is absent on a denial. Withheld formulas are therefore never typeset and never reach the island props.
- The KaTeX stylesheet is linked only when `hasMath` finds math in the visible document.
- Math is a leaf unit, and tests cover it at top level and inside toggle, layout, section and card (`tests/math-block.test.ts`, the "paywall" cases). Markdown, search and AI text use the existing paywalled document paths; `searchText` and `aiText` add only TeX and caption.

## Bundles, CSS and CSP

- The `KaTeX parse error` string appears only in `dist/_astro/math-render.*.js` (256 KiB, ours), `dist/_astro/katex.*.js` (Mermaid's existing lazy copy) and `dist/_worker.js/chunks/math-render_*.mjs` (590 KiB).
- The only client chunk that references `math-render` is `BlockRenderer.*.js`, through a dynamic `import()` that runs only when `liveMath` is set (Studio). The Zuey AI panel and the shared chunks are KaTeX-free.
- The server chunk named `math-assets_*.mjs` (107 KiB) is a Rollup shared chunk holding BlockRenderer and similar code. It contains only the CSS URL string from KaTeX, not KaTeX itself.
- The `_lesson_*.css` bundle contains only our `.zb-math-*` rules, not KaTeX `@font-face`.
- There is no CSP on article or lesson pages; the CSP grep finds only the sandbox doc and OAuth pages. The KaTeX CSS and fonts are same-origin under `/_astro`.
- **Worker size.** About 2.85 MiB gzip is well under the Workers Paid limit of 10 MiB compressed. The account is on Workers Paid, according to `docs/presence-operations.md:46` (Durable Objects). It would be close to the 3 MiB Free-plan limit, but Free does not apply here.

## Compatibility, OpenAPI and MCP

- A v1 `{type:'math', tex, caption}` document reads back unchanged with `degraded: 0`. Defaults (`mode: display`, `numbered: false`) are not stored, and `null` is accepted.
- The v1 snapshot diff contains only the new math markup and the schema additions.
- `BlockMath` documents `mode` (enum, default `display`) and `numbered` (boolean, default `false`). `BLOCK_SCHEMA_NOTES` and the `math` example in `block_schema` match the validator, and the example validates. The `numbered`+`inline` rejection is stated in prose only, not as `if/then`; this is acceptable.

## Findings

### minor: equation numbering collides with KaTeX's own numbered environments and `\tag`

- **Where:** `src/lib/blocks/math.ts:36` and `src/lib/blocks/math-render.ts:26`
- **Evidence:** In display mode, `\begin{equation}`, `\begin{align}` and `\begin{gather}` produce `.eqn-num` spans. KaTeX numbers these with a document-wide CSS counter (`body{counter-reset:katexEqnNo}`, `.katex .eqn-num:before{content:"(" counter(katexEqnNo) ")"}` in `katex.min.css`). `\tag{7}` renders its own tag.
- **Impact:** These numbers are independent of the block `numbered` counter. A document that mixes a `numbered: true` block with an `equation` or `align` block shows two "(1)"s. A `numbered: true` block that contains `\begin{equation}` or `\tag{}` shows two numbers on one line. In Studio, every preview shares one counter.
- **Fix:** Either reset or hide `.eqn-num` inside `.zb-math` and steer authors to `numbered` plus `equation*`/`aligned`, or document the interaction in `BLOCK_SCHEMA_NOTES` and the playbook. Add a test either way.

### minor: the TeX-character budget does not bound server CPU per render

- **Where:** `src/lib/blocks/math-render.ts:15,51`
- **Evidence:** On Bun on this machine, a valid document with 10 formulas of about 9,900 characters each, all within `LIMITS.math` and the 100k budget, costs about 0.9 s CPU per render for `\frac` nesting depth 900. It costs 0.6 s for 4,900 Unicode subscripts and 0.34–0.4 s for nested `\sqrt`, flat `x+x+…` or nested `\overbrace`. Every one of those formulas then fails the 200k markup cap, so the CPU is spent for nothing.
- **Normal cost:** A typical 30-formula document costs about 9–21 ms. A cold import costs about 12 ms.
- **Context:** Only admin keys can author, anonymous pages are `public, max-age=300` (`src/lib/blocks/paywall.ts:57`), and the plan allows 30 s CPU, so this is self-inflicted. However, admin and personalized views are `no-store` and pay this cost on every request.
- **Fix:** Track elapsed time and stop typesetting after a time budget, for example about 50 ms per document. Or lower the per-document budget. Or cache the renders per document `content_hash`.

### minor: server markup is shipped twice

- **Where:** `src/pages/articles/[slug].astro:159` and `src/pages/courses/[slug]/[lesson].astro:164`
- **Evidence:** The KaTeX HTML+MathML (about 1.6 KB for `\int_0^1 x\,dx`, and up to 200 KB per formula by the cap) is in the SSR HTML and again, JSON- and attribute-escaped, in the `astro-island` `props`.
- **Impact:** Pages heavy with math roughly double their math bytes. This is expected for an islands architecture, but worth knowing. A later option is to render math outside the island or read the markup from the DOM.

### nit: KaTeX stylesheet is render-blocking on every Studio load

- **Where:** `src/pages/studio/index.astro:36`
- The 29.5 KiB CSS loads even when no math is previewed; fonts are lazy, so the cost is small. It could be injected on the first `math-render` import instead.

### nit: Studio field preview always numbers "(1)"

- **Where:** `src/components/studio/ArticleEditor.tsx:651`
- The number does not match the document position. Consider `(#)` or the real number from `mathNumbers(doc)`.

### nit: `aria-label` on a generic `div`

- **Where:** `src/components/studio/ArticleEditor.tsx:650`
- `aria-label` is ignored on a role-less `div`. Add `role="group"` or `role="region"`, or use a visible heading.

### nit: Markdown delimiters are not escaped

- **Where:** `src/lib/blocks/definitions/media.ts:104`
- Inline TeX containing `$` (for example `\$5`) or display TeX containing `$$` breaks the `$…$` / `$$…$$` fence in the Markdown export. This is rare; it could be escaped or fall back to a fenced `math` code block.

### nit: silent failure when the typesetter cannot be imported

- **Where:** `src/pages/articles/[slug].astro:85` and `src/pages/courses/[slug]/[lesson].astro:64`
- `.catch(() => undefined)` hides an import or runtime failure of `math-render`. Readers degrade correctly to the source, but nothing is logged. A `console.error` with the message would make a deploy-skew or bundling regression visible.

## Studio editor

I reviewed the editor by reading the code; I did not drive it in a browser. The mode select clears `numbered` when switching to inline, and the checkbox is disabled for inline. The live preview debounces at 150 ms, cancels on unmount or change, and falls back to the source with KaTeX's error message, or with "KaTeX could not be loaded". Block, history and document previews pass `liveMath`. I found no regression in the other field editors; the diff touches only the `math` case and three `BlockRenderer` call sites.

## Flaky tests

- The full suite passed twice (1643/1643 both times) and the ZueyOS files passed under parallel build load. I reproduced no flakiness.
- The PR touches no ZueyOS code or tests.
- The ZueyOS DOM tests rely on wall-clock waits: `tests/zueyos-controls-dom.test.ts:51` and `tests/zueyos-liquid-glass.test.ts:303` loop `setTimeout(r, 20)` rounds, and `zueyos-controls-dom.test.ts:374` waits `TOAST_MS.error + 50`. They can plausibly time out on a loaded machine.
- **Conclusion:** Any flakiness the author saw is unrelated to this PR. It is pre-existing test design and warrants its own issue, not a change here.

## Out of scope

Vietnamese inside `\text{}` (#251).
