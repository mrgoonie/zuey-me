# Review: PR #153, paywall splits top-level layouts, toggles and cards (closes #138)

Head: `177ddd2c93bfff3c5745b8b720c82c46c7acc14f`. Base: `cb3249b` (#137). `main` is one commit ahead (#148, Dodo payments). That commit does not touch these files.

**Verdict: APPROVE.** Findings 1 to 4 below are non-blocking.

## Gates

| Gate | Result |
| --- | --- |
| `bun install` | OK |
| `bun test` | 1057 pass, 0 fail |
| `bun run build` (astro check + build) | 0 errors, 0 warnings |
| Adversarial suite written for this review (not committed) | 7 of 7 pass, 15,234 expects |
| Cleanup | worktree, `review-153` branch, `dist/` and `.wrangler/` removed |

## What changed

The PR touches only `src/lib/blocks/paywall.ts` for logic. `sectionUnits` became `blockUnits` and now runs on every top-level block:

- Sections, cards and toggles are split by body block.
- Layouts are split cell by cell.
- A container with nothing to split stays as one unit.

`joinUnits` now also rebuilds toggle bodies. The rule that a partly kept card drops its footer is unchanged. `outline.words` is now `wordCount(doc) - wordCount(kept)`. The other changes are wording in OpenAPI and `articles.ts`, plus tests and one snapshot line.

## Security checks

### 1. No withheld text in any output

I ran a seeded fuzz over 400 random valid documents; 345 of them were truncated, and all 345 were checked. The documents mix sections, cards, toggles and layouts (nested up to 2 deep), headings and paragraphs, nested up to 4 levels. Every text field held a unique token. For each truncated document:

- The kept tokens appear in the source in the same order. The kept part is a reading-order prefix.
- No withheld token appears in any surface: kept JSON, SSR HTML (`BlockRenderer`), Markdown, AI text, search text, and the teaser email (HTML and text).
- The only withheld token that can sit before the last kept token is the footer of a partly kept card, and that footer is dropped.
- The kept document passes `validateDocument`.
- Outline headings are only text from withheld `heading` blocks. A toggle summary or card title never appears there.

Targeted cases also passed:

- **Toggle whose summary is the only free text:** with the body fully withheld, the summary is absent everywhere, including the outline. An empty-body toggle is one unit and is withheld whole.
- **Card with secret text in its title, cut after the title:** the title is kept (it comes before the body) and the footer is dropped. When the body is fully withheld, the title is withheld too.
- **Layout cell > card > toggle, cut inside the toggle body:** the footer and later cells are withheld, the summary is kept, and the result validates.
- **Cut exactly at a unit boundary:** the next toggle's summary and body are both withheld.
- **Performance:** a document with about 366 blocks (limit 500), built as sections > cards > layouts > nested layouts. `applyPaywall` averages about 2 ms.

REST, `.md` and MCP `article_get` all go through `articles.ts` and `applyPaywall`. The PR's `blocks.test.ts` case covers them. The other consumers (`ai/context.ts`, `search/indexer.ts`, the teaser email and `survey.ts` block lookup) also read only `applyPaywall(...).doc`.

### 2. Is it safe to keep a toggle summary when the toggle is partly kept?

Yes. The summary comes before the body in reading order, so it is free text before the cut. The same rule already applied to card titles and images in #137. A fully withheld toggle is not emitted, and its summary is counted only in `words`.

### 3. Locked outline and word count

- `documentText` joins trimmed parts with `\n`. `wordCount` is additive across those parts, and the kept document's parts are a subset of the source's parts. So `words` is exactly the withheld word count and can never be negative. The fuzz asserted this on 345 documents, and `Math.max(0, …)` is only a guard.
- `words` is an aggregate size only. It now also counts withheld summaries, titles and footers. It reveals no text.
- Headings inside withheld toggles and layouts now appear in the outline. This matches the documented contract ("withheld headings") and how sections behave since #137.

### 4. Stored articles cut as before

I ran a differential test against `main`'s `paywall.ts` on 112 random documents. They had no top-level toggle, layout or card, no toggle inside a section, and no empty containers. In every case the kept document, `truncated`, the outline headings and `blocks` were identical. `words` was also identical whenever the document had no cards.

The prose and legacy snapshots are unchanged. In the kitchen-sink snapshot only `outline.blocks` changed, from 18 to 22: its withheld top-level layouts and toggle are now counted unit by unit. The kept ids, `truncated` and `words` (56) are unchanged. This change is intended and correct.

### 5. Validator

The validator was not changed in this PR. `validate.ts`, `validator-core.ts`, `nesting.ts` and `definitions/` have no diff. The rule that a toggle may not contain a toggle or a layout has existed since `66b0ca2` (2026-10-02, when toggles were added), so stored documents can only have that shape if they were written by hand. Load-time behaviour does not change. The PR body says such a shape is "now rejected"; it would be more accurate to say it is "rejected by the validator".

### 6. OpenAPI and docs

The OpenAPI notes, `locked_outline` descriptions and `ArticleView` JSDoc now match the behaviour ("withheld headings"; units inside sections, cards, toggles and layout cells). README and `docs/` describe neither the outline nor the cut granularity, so nothing there is stale.

## Findings (non-blocking)

1. **The cut's weight no longer counts container text.** When a container is split, its text (toggle summary, card title, footer and image weight) leaves the `total / 3` weight. A kept card or toggle head is therefore shown without counting toward the free share. This is bounded by the short-text limit and matches how sections behave since #137. It does not leak anything.
2. **PR body wording about the validator.** The rejection of a toggle containing a layout is not new (see point 5 above).
3. **Headings in collapsed toggles now appear in the outline.** This is consistent with the contract. Raise it with the product owner if headings inside collapsed toggles were meant to stay private.
4. **#150 is fixed but not closed.** The fix and its test are in this PR. The validator question #150 asks is still open, so leaving #150 open is reasonable.

## Unresolved questions

- Should container head text (title, summary, image) count toward the paywall weight? This is a product choice and affects no security property.
