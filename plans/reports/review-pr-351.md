# Review: PR #351 (Closes #263)

`fix(blocks): clear code toolbar, label diff lines and drop patch headers from copy`
Head `1278e41c1c27c43bfdf2b7fcad6bd81b4e7fd3f3`. Its merge base is `6082c49`, which is the current `origin/main`.
Reviewed in a read-only temp worktree, `%TEMP%\rv351`, which has since been removed.

**Verdict: MERGE.** There are no blocking or medium findings. The four Low items below can be follow-ups.

## Scope

`git diff --stat origin/main...HEAD` lists exactly 6 files, with 200 insertions and 26 deletions:
- `CodeBlock.tsx`
- `code-syntax.ts`
- `definitions/text.ts`
- `blocks.css`
- `tests/code-block-dom.test.ts`
- `tests/code-block-v2.test.ts`

## Gates

| Gate | Result |
|---|---|
| Fail on main: new tests run against main's 4 source files | 22 pass, **11 fail**. This matches the claim, and the failing test names match the PR body. The files were restored afterwards and the tree was clean. |
| `bun test tests/code-block-v2.test.ts tests/code-block-dom.test.ts` | 33 pass, 0 fail |
| `bun test` | 2157 pass, 0 fail, 118 files |
| `bun run build` | 0 errors, 0 warnings, build complete |
| `gh pr checks 351` | Test & Build: pass (2m28s) |

## Claims

| # | Claim | Verified | Evidence |
|---|---|---|---|
| 1 | Toolbar overlap fixed, with server markup matching | Yes (CSS logic; pixel check left to the coordinator) | `blocks.css:117` matches both the server `<pre class="zb-code">` (`CodeBlock.tsx:170`) and the hydrated plain `pre`. It skips blocks with a language label, and blocks after a filename caption (`.zb-code-head + .zb-code`). The only other `.zb-code` user, the `DiagramBlock.tsx:75` fallback, has a lang span, so it is excluded. The rule survives the build: `.zb-code:not(:has(>.zb-code-lang)):not(.zb-code-head+.zb-code){padding-top:2.6rem}`. |
| 2 | SR labels are visually hidden and unselectable | Yes | `CodeBlock.tsx:74` adds `zb-sr-only zb-diff-sr` to add/del lines only. `.zb-diff-sr { user-select: none }` (`blocks.css:140`) builds to `-webkit-user-select:none;-moz-user-select:none;user-select:none`, so Safari is covered. |
| 3 | Diff headers excluded from copy; a lone `-- comment` stays code | Yes | `code-syntax.ts:149-163`. Probe results: the CRLF patch gives `head,head,head,del,add`, copy `"b\n"`. `--- /dev/null`+`+++ b/x` reads as headers. `--- note` alone reads as del. |
| 4 | Diff copy label and empty state | Yes | `CodeBlock.tsx:197-204`. An all-removed diff, a headers-only diff or blank code each give `data-state="empty"` with an info toast, and nothing is written. |
| 5 | Toolbar is one tab stop with arrows and Home/End | Yes | `CodeBlock.tsx:205-238`. Roving tabindex; ArrowLeft/Right wrap around; `onFocus` keeps the index in sync after a mouse click. |
| 6 | Bidi controls stripped, not rejected | Yes | `text.ts:145`, `:163`. Stripping runs before the `FILENAME_RE` check. A filename that is only bidi characters becomes "no filename". |
| 7 | 22 pass and 11 fail on main | Yes | Reproduced exactly. |

## Concerns from the brief

- **Label leakage into text or export output: none.** No product code reads the `<code>` DOM text. Every derived output reads the stored `b.code`:
  - Markdown: `text.ts:195`
  - Search: `searchText`, `text.ts:196`
  - AI text: `aiText`, `text.ts:197`
  - Email: `article-email-render.ts:298`
  - JSON feed: uses the article summary only
  - Copy button: `copyText(block)`

  `renderToStaticMarkup` is used only by tests. The test helper `codeText` is the only consumer that needed the strip. The DOM test at `code-block-dom.test.ts` intentionally asserts that `textContent` includes the label. That is correct, because only CSS keeps the label out of the visible text.
- **No-JS strip of about 1.7rem:** this is acceptable. See L1 for an option that removes it.
- **CRLF:** handled. `codeDisplay` runs `normalizeCode` (`\r\n?` becomes `\n`) before header detection. A probe confirmed it.
- **Headers-only diff:** `copyText` returns `''`, and the button reports "Không có code để chép". This is covered by a test (`code-block-v2.test.ts`, "copies nothing from an all-removed diff").
- **Manual select-all and copy:** the label is `user-select: none`, with build-added prefixes. That keeps it out of the copied text in Chromium and Firefox. I did not verify this in a real browser, so the coordinator should do a select-all and copy on `pr.html`. The same applies to `ArticleAskAi.tsx:32`, which reads `getSelection()`.
- **No `any` and no unchecked casts.** Indexing is guarded: `TOOL_STEP[e.key] ?? 0` sits behind `Object.hasOwn`, and `COPY_RESULT` is typed `Record<Exclude<CopyState,'idle'>, …>`.

## Findings

No Critical, High or Medium findings.

**L1. Readers without JavaScript see an empty strip above plain blocks with no language** (`src/styles/blocks.css:117`).
- It is 2.6rem of padding against the base 0.9rem, so about 1.7rem of empty dark space, and no toolbar ever appears.
- The trade-off is reasonable: the space is reserved on first paint, so nothing shifts on hydration.
- Optional follow-up: wrap the rule in `@media (scripting: enabled) { … }`. JS readers would still get the space from first paint, and no-JS readers would keep the old layout. Support: Chrome 120+, Firefox 113+, Safari 17+. Older browsers fall back to today's overlap.

**L2. Git extended header lines are not recognised** (`src/lib/blocks/code-syntax.ts:149`).
- The unrecognised lines are `new file mode`, `deleted file mode`, `old mode`, `new mode`, `similarity index`, `rename from`, `rename to` and `Binary files … differ`. Each is marked `ctx` and is copied.
- Probe: `diff --git …\nnew file mode 100644\nindex 0000000..2b\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+a` copies `"new file mode 100644\na"`.
- The issue only named `---`, `+++` and `@@`, so this is a follow-up, not scope creep.

**L3. The file-pair heuristic can misread real code** (`src/lib/blocks/code-syntax.ts:158-163`).
- A removed line `-- x` directly followed by an added line `++ y` is written `--- x` then `+++ y`, which is read as a header pair. Probe: `'--- old\n+++ x'` gives `head,head`.
- This is very rare, and it is the documented trade-off. Accept it.

**L4 (nit). Invisible bidi characters are written literally in source** (`src/lib/blocks/definitions/text.ts:145`; also the test strings in `tests/code-block-v2.test.ts`, in the validation block).
- GitHub flags files with hidden bidi characters, and a reader cannot see what the regex contains.
- The neighbouring `FILENAME_RE` already uses `\u` escapes.
- Suggested form: `/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g`. Use `\u` escapes in the tests too.

## Visual harness (kept, outside the repo)

- `C:\Users\admin\AppData\Local\Temp\rv351-harness\pr.html`: the PR's `CodeBlock.tsx`, `code-syntax.ts` and `blocks.css`.
- `C:\Users\admin\AppData\Local\Temp\rv351-harness\main.html`: main's versions of the same files.

How the pages are built:
- Each page has three cases: a plain block with no language, a plain `bash` block for reference, and a `ts` diff with full git headers.
- Each case is real `CodeView` output, rendered on the server with `renderToString` and wrapped in `div.zb-doc` as `BlockRenderer` emits it.
- The pages are hydrated by an inlined, minified browser bundle of the same sources.
- Styles are the raw `blocks.css` from each version, plus the compiled global CSS (Tailwind + `global.css`) from the PR's `dist`. `global.css` is unchanged by the PR.
- Append `?nojs` to skip hydration. Comparing the two states checks both the "no shift on hydration" claim and the no-JS strip.
- Both pages hydrate and show 3 toolbars. The PR page has copy labels `Chép code | Chép code | Chép code sau thay đổi`, the SR labels `Đã xoá: ` and `Đã thêm: `, and 5 header lines. Main has none of these.
- happy-dom logged React recoverable error #418 (text mismatch) for **both** builds alike. React then client-renders, so the final DOM is the same. Because it appears on main too, it is not caused by this PR; the cause is probably how happy-dom parses `innerHTML`. Check the browser console when measuring.
- Supporting files in the same folder: `compose.ts`, `*.json` (the server markup and highlights), `*.client.js`, `*.blocks.css` and `global.compiled.css`.

## Cleanup

- The temp worktree `%TEMP%\rv351` is removed, along with its `node_modules` and `dist`. No `.wrangler` folder was created. `git worktree prune` was run.
- Nothing was pushed, commented or relabelled.
