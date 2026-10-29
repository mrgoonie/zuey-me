# Review: PR #261 — Code block v2 (closes #69, epic #4)

- Head: `ae27f7e` (`feat/69-code-v2`), base `60328c4` (origin/main is now `6864361`; merge-tree against it is clean)
- Reviewer: isolated agent, did not write the code
- Date: 2026-10-23

## Verdict

**Approve with minor follow-ups.** No blockers and no majors. Validation is tight. React escapes all output, so the XSS probes found nothing. Legacy blocks are byte-identical on every surface. Paywall weight is correct at top level and nested. The minors are about UX and accessibility polish, and none of them needs to block the merge.

## Gates

| Gate | Result |
| --- | --- |
| `bun install` | ok (744 packages) |
| `bun test` | **1715 pass, 0 fail** (104 files, 96.5 s) |
| `bun run build` | astro check **0 errors, 0 warnings** (70 hints); build complete |
| `git merge-tree` vs PR #260 head `45afdb1` | **clean** (exit 0). PR #260 touches `RenderContext`, the `interactive` case and the `BlockRenderer` props; #261 touches the imports, removes `CodeView` and changes the `code` case. The hunks don't overlap |
| `git merge-tree` vs origin/main `6864361` | clean |

## Backward-compatibility probe (base `60328c4` vs PR head)

I wrote a probe and ran the same file in both trees. The input was 10 legacy blocks:
- `ts` with a trailing newline
- no language
- `diff` language without the `diff` flag
- `html` containing `</script><img onerror>`
- an unknown language
- CRLF Python
- blank lines
- code nested in a section
- code nested in a toggle, with backticks and `$`

Every surface came out **IDENTICAL**: validated doc, `readStoredDocument`, `html`, `articleHtml` (with server highlights), the Studio `liveHighlight` HTML, `highlightBlocks` runs, Markdown, search text, AI text, `blockWeight`, the paywall cut, and both email modes (full and teaser). The snapshot diff in `v1-documents-compat` only adds the new `BlockCode` schema properties and the example.

## Probe results (PR head)

- **Filename XSS:** `<img onerror>` and `</figcaption><script>` are accepted as text. The SSR output and the email HTML render them as `&lt;…&gt;`. Double quotes, backticks and newlines are rejected with a path. A value over 200 characters is rejected. A whitespace-only value is dropped.
- **Code containing `</script>`:** rendered as escaped tokens. The Markdown fence grows past any backtick run in the code (```` ````ts title=… ````).
- **Highlight specs:**
  - `1-999999999` is rejected by the regex (`\d{1,6}`).
  - `1-999999` on a 3-line block is rejected ("within lines 1–3").
  - `0`, `3-2`, `1,,2`, `1-2-3`, `-1`, `1-`, full-width or Arabic digits, and the number `12` are all rejected.
  - 51 ranges are rejected. Spaces are normalised (`" 1 , 2 - 3 "` → `1,2-3`).
- **DoS:**
  - Validation is linear: rejecting a 10k-character spec 1000 times took 57 ms. The validator never expands ranges.
  - Worst valid render is 50k characters of code (25,000 lines) with 18 full ranges and line numbers: 111 ms and about 1.05 MB of HTML. That is bounded by `LIMITS.code`.
  - `highlightedLines` with an *unvalidated* spec (100 × `1-999999` over 999,999 lines) takes 3.4 s, but no path can reach it. Stored docs are validated, and the Studio preview clamps to the real line count.
- **`collapseAfter`:** 2, 501, 3.5, `"10"` and `true` are rejected; 3 and 500 are accepted. `null`, `false` and absent all normalise away. Flags reject `"true"` and `1`.
- **Weight:** a top-level block with code 100 + filename 50 weighs 150. A block nested in a section with 100 + 20 weighs 120. Both are correct.
- **Markdown diff:** gives ```` ```diff lang="ts" title="x.ts" ```` with the markers kept verbatim. A diff block with no language gives ```` ```diff ````.

## Findings

### Minor

1. **Toolbar covers the first code line of plain blocks without a language label** (`src/styles/blocks.css:102`, `src/components/blocks/CodeBlock.tsx:147`/`:181`).
   - After hydration every plain block gets the absolutely positioned toolbar, but not the `zb-code-top` padding. That padding is reserved for blocks with options so that their server HTML stays legacy.
   - The geometry:
     - The toolbar spans 0.35–2.35 rem from the top and about 4.5 rem from the right, on a 92 % opaque background.
     - With a language label, the first code line starts at about 2.42 rem, so it is clear.
     - With `language: ''` (allowed and common for shell output), the first line starts at 0.9 rem and sits under the buttons.
   - On a phone, or when the block scrolls sideways, the end of the first line is hidden.
   - Fix options:
     - give the toolbar room only after mount (for example, add a class on the `<figure>` once mounted that applies `padding-top` to a plain `pre` with no language). That causes one small layout shift, only for language-less blocks.
     - or place the toolbar outside the `pre` box.

2. **Diff semantics are hidden from screen readers** (`src/styles/blocks.css:133-136`, `CodeBlock.tsx` `LINE_TAG`).
   - The `+`/`-` markers use `content: '+' / ''`, which sets empty alt text. The marker is decorative for assistive technology.
   - The only remaining cue is `<ins>`/`<del>`. VoiceOver doesn't announce these by default, and NVDA and JAWS only announce them under some settings.
   - A screen-reader user hears removed and added lines as one block of code. The epic's "accessible fallback" requirement applies here.
   - Suggestion: alt text such as `content: '-' / 'xoá: '` and `'+' / 'thêm: '`, or a visually hidden prefix span that copy and selection skip (`user-select: none`).
   - Line numbers should stay silent, and they already are (`counter(zb-line) / ''`, line 126).

3. **Unified-diff headers are treated as diff lines** (`src/lib/blocks/code-syntax.ts:151`).
   - Authors will often paste `git diff` output. Running `--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b` through the parser gives:
     - display text `-- a/x`, `++ b/x`, `@@ -1 +1 @@`;
     - the `---` header marked as removed and `+++` as added;
     - copy output `++ b/x\n@@ -1 +1 @@\nb`, which is broken code.
   - The schema does document "each line starts with +, - or space", so the code behaves as specified. But the "copies code that runs" promise breaks on the most likely input.
   - Fix options:
     - treat `---`, `+++` and `@@` header lines as meta: render them muted and leave them out of the copy;
     - or reject them in validation with a clear message.

4. **Copying the post-change code is the right default, but the button doesn't say so** (`CodeBlock.tsx:177`).
   - Copying the code after the change, with removed lines dropped, is what readers of a tutorial "change this to" want, and the result runs. I agree with it as the default.
   - Two problems:
     - the button label and tooltip say only "Chép code". On a diff it should say something like "Chép code sau thay đổi", so a reader who wanted the patch isn't surprised;
     - an all-removed diff copies `""` and still reports success ("Đã chép code").
   - The Markdown export keeps the raw patch, so agents still get the full diff.

### Nit

5. **Too many tab stops** (`CodeBlock.tsx:190`). The rule `tabIndex={collapsed || !wrap ? 0 : undefined}` makes every hydrated non-wrapped `<pre>` focusable, even one that doesn't overflow. With two toolbar buttons, each block adds three tab stops. Make the `pre` focusable only when it overflows (`scrollWidth > clientWidth`) or is collapsed. A focusable `pre` also has no accessible name; consider `aria-label` set to the filename or language.
6. **`role="toolbar"` without arrow-key navigation** (`CodeBlock.tsx:195`). The ARIA toolbar pattern expects one tab stop with arrow keys, and here both buttons are in the tab order. Either drop the role (`role="group"` is enough) or implement roving tabindex.
7. **The schema pattern is stricter than the validator** (`src/lib/blocks/definitions/text.ts:209`). The published `pattern` rejects `"2, 4-6"`, but the server accepts it and normalises it. That is safe, but the description could mention that the value is normalised without spaces.
8. **Bidirectional control characters in `filename`** (`text.ts:140`). `FILENAME_RE` allows U+202E. A filename can be visually spoofed (Trojan-Source style), but only the article's own author can do it. Consider rejecting `‪-‮⁦-⁩`.
9. **Studio `collapseAfter` input** (`src/components/studio/ArticleEditor.tsx:454`). Values below 3 are stored while the author types and only fail with a 422 on save. The label already shows the 3–500 range, so this is acceptable. Optionally clamp the value or show an inline hint.
10. **Plain blocks remount on hydration.** The `!options && !mounted` branch (`CodeBlock.tsx:147`) swaps `<pre>` for `<figure><pre>` after mount, so React replaces the node. This is harmless: same size, no styles target `.zb-doc > pre`, and line 14 also covers `figure`. It does drop a selection the reader started before hydration.

## Checklist results

- **XSS:** pass (see probes).
- **Range parsing and DoS:** pass. The regex is bounded at 6 digits, there are at most 50 ranges, the value is at most 200 characters, ranges must go upwards and stay within the code's lines, and render cost is clamped to the line count.
- **Backward compatibility:** pass (identical on all 13 surfaces).
- **Paywall weight:** pass, top level and nested (150 / 120 in the probe, and the PR's test covers it too).
- **Exports:**
  - Markdown fence metadata is correct. Diff code is kept verbatim.
  - Search and AI text are the filename plus the code (diff markers kept, which is right for AI context).
  - Email escapes the filename; the text part is `filename\ncode`.
- **OpenAPI and MCP:** the properties and descriptions are accurate, and the example validates. `examples` sits in `extra` like the other definitions, which is fine for OpenAPI 3.1.0.
- **Studio:** fields are complete. Unchecked flags are removed rather than stored as false, matching the validator.
- **Accessibility:**
  - Buttons have labels, `aria-pressed` and `aria-expanded`, and visible focus.
  - The copy result is announced through an inline `role=status`. Article pages have no `<Toaster>` (it only exists in `ZueyOS.tsx:718`), so the fallback is the path actually used. It is mounted before its content changes, so it is announced.
  - Line numbers can't be selected and aren't read out.
  - Diff markers are not read out either (minor 2).
- **Bundle:** +1.65 KB gzip on `BlockRenderer` (`client:load` on article and lesson pages). That is acceptable for six features. The highlighter stays a lazy chunk.
- **Conflicts with #260:** none, either textual or semantic.

## Cleanup

Removed the `review-261` and `review-261-base` worktrees (including the probes and the build output in them) and the local `pr-261`/`pr-260` refs.
