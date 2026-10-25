# Review: PR #343, fix(blocks): keep multi-line text cells in one card grid item (Closes #285)

- Head: `c5869e165ac08391e4ba5fe3b4e1605a46536999` (`fix/table-cards-multiline-text`), based on `origin/main` `0693668`
- Reviewer: isolated agent; did not write the code
- Verdict: **MERGE**

## Scope

`git diff --stat origin/main...c5869e1` lists only the two expected files:

- `src/components/blocks/TableBlock.tsx` (+2 / -1): `case 'text'` now returns `<span>{renderInline(raw)}</span>` instead of a fragment, plus a comment.
- `tests/data-table-dom.test.ts` (+12): new cards-mode test.

## Gates (temp worktree `%TEMP%\rv343`, foreground, one at a time)

| Gate | Result |
| --- | --- |
| `bun test tests/data-table-dom.test.ts` | 9 pass, 0 fail |
| Same test with main's `TableBlock.tsx` swapped in | 8 pass, 1 fail: line 188 `Expected length: 1, Received length: 2` (matches the PR claim). Restored with `git checkout HEAD --`; `git status` clean |
| `bun test` | 2127 pass, 0 fail, 118 files |
| `bun run build` | astro check 0 errors, 0 warnings; build complete, exit 0 |
| `gh pr checks 343` | Test & Build: pass (2m17s) |

## Single-node check per cell kind

A harness mounted the real `BlockRenderer` in cards mode with one cell per column kind and counted `td.childNodes`:

| Kind | main | PR |
| --- | --- | --- |
| text, single line | 1 `<span>` | 1 `<span>` (`span > span`) |
| text, single line with `**bold**` | 1 `<span>` | 1 `<span>` |
| text, `l1\nl2` | **2 `<span>`** (the bug) | 1 `<span>` |
| badge | 1 `<span>` | 1 `<span>` |
| boolean | 1 `<span>` | 1 `<span>` |
| link (valid) | 1 `<a>` | 1 `<a>` |
| link (invalid, `javascript:`) | 1 text node | 1 text node |
| date | 1 `<time>` | 1 `<time>` |
| number / currency / percent | 1 text node each | 1 text node each |
| empty `''` | 0 nodes (`null`) | 0 nodes |

The author's claim that the other kinds already render a single node is correct.

## Non-card and desktop rendering

- The only rule that targets cell children is `.zb-dt-cards .zb-table td > * { justify-self: start; }` (`blocks.css:218`), which applies in cards mode only. Neither `blocks.css` nor `global.css` has a `td > span` or `td span` rule, so outside cards mode the extra inline `<span>` does not change layout.
- Alignment does not change. `zb-num` (right-aligned) is set on the `td` for numeric columns, and the PR does not touch those cells: they still render as bare text nodes.
- Search text does not change. `visibleRows` searches `tableIndex(...).haystack`, which is built from the raw row data, not from the DOM. The cell's `textContent` is the same as before (`dòng 1dòng 2`).
- Server HTML and the first client render both include the wrapper, so they still match on hydration. Harness SSR output: `<td><span><span>dòng 1</span><span><br/>dòng <strong>2</strong></span></span></td>`.

## Findings

### Critical / High / Medium

None.

### Low

1. **The PR description overstates the scope of the fix.** It says the wrapper "also covers single-line text with inline Markdown (text, `<strong>`, text), which used to produce several grid items too." That is not true. `Inline` (`BlockRenderer.tsx:252`) always wraps each line in its own `<span>`, so on main a single-line Markdown cell is already one grid item (`<span>a <strong>b</strong> c</span>`). Only multi-line text was broken. This affects the description only; the code comment in `CellView` is accurate. No code change is needed. The author could correct the PR body.

### Nit

2. Single-line text cells now render `span > span`, one extra element per text cell. This is harmless, and it is the simplest fix that keeps `Inline`'s contract unchanged.

## Visual evidence (static harness, outside the repo)

- Script: `C:\Users\admin\AppData\Local\Temp\rv343-harness\render.ts`. It mounts the real `BlockRenderer` from the worktree in happy-dom (same setup as `tests/data-table-dom.test.ts`) with the test's `TABLE` fixture, `mobile: 'cards'` and the row `['dòng 1\ndòng **2**', '490000', 'true', 'Mới']`. It also renders `renderToStaticMarkup` for the same block to show the server-side default layout. It inlines the real `src/styles/blocks.css` and the built Tailwind/global bundle (`dist/_astro/policy.LntG4Rnn.css`).
- Cards mode appears only after hydration, because `mounted` is set in an effect. `renderToStaticMarkup` alone can never produce the cards layout, so the cards section comes from the hydrated client DOM, not from server markup.
- `C:\Users\admin\AppData\Local\Temp\rv343-harness\pr.html` (PR head)
- `C:\Users\admin\AppData\Local\Temp\rv343-harness\main.html` (main's `TableBlock.tsx`)

## Cleanup

The temp worktree `%TEMP%\rv343` (including `node_modules`, `dist` and `.wrangler`) was removed after the review. The harness files are kept. Nothing was pushed, commented or relabelled.
