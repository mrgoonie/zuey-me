# Review round 2: PR #137 (closes #67), block registry foundation

Head `4ef9cab`. This is a delta review of the fix commit on top of `1d807a9`. It ran in an isolated worktree that did not write the PR, and nothing was pushed.

## Verdict: APPROVE

All round-1 findings are fixed correctly, and the new card `level` is validated strictly. I found no new way for the paywall to leak. One cosmetic nit remains.

## Gates

- `bun test`: **1022 pass, 0 fail** (4 snapshots, 57 files).
- `bun run build`: astro check reports **0 errors, 0 warnings** (66 hints, 718 files), and the build completes.

## Fix verification

### 1. Card footer leak (Medium): fixed

`src/lib/blocks/paywall.ts`, `cardUnitCounts` and `joinUnits`:
- The code counts units at any depth under each card's body frame, once over all units and once over the kept units.
- A card keeps its footer only when the two counts are equal.
- Every consumer derives from the `applyPaywall` output: SSR and the API (`articles.ts:578`), the public part (`articles.ts:791`), the search preview (`indexer.ts:79`), AI context (`context.ts:221`), surveys and the email teaser (`article-email-render.ts:240`).

I ran adversarial checks against the PR head with an anonymous viewer and `knowledges` access. I tuned the weights so the card was really cut partway.

| Structure | Result |
|---|---|
| section > card > layout, last cell withheld (the round-1 repro) | footer and withheld body absent |
| section > layout > card (partly kept) + sibling cell | footer, withheld body and sibling absent in the doc, Markdown and search text |
| the same, through `renderArticleEmail` in teaser mode | footer and withheld body absent from the HTML and text |
| two cards: first fully kept, second fully withheld | `FOOT1` kept; card B's title and footer absent |
| card fully kept | footer kept (correct) |
| card with an empty body (title and footer only) as the withheld tail | title and footer absent (the whole leaf unit is withheld) |
| card > toggle | the toggle is one whole unit, so the card was either whole (footer allowed) or partial |
| footer-only card | rejected by the validator (needs a title, an image or a block) |

### 2. Validator split (Low): fixed

- `validator-core.ts` is a verbatim move of the `Validator` class, plus a `DefinitionLookup`. `validate.ts` wires in the registry, and `readStoredDocument` stays lenient.
- `isOneOf` dropped its `typeof v === 'string'` guard. It still uses strict `===` against the list, so string enums behave exactly as before.
- In the built client:
  - `StudioApp` is the only chunk that contains registry definitions.
  - `ZueyAiPanel` now imports `validator-core.*.js` (7.9 kB raw), down from the 33 kB shared `validate` chunk.
  - `registry.ts` no longer reaches the panel.
- `validateInteractiveBlock` still accepts valid artifacts. It rejects a missing html/js and an out-of-range height, and it rejects other block types ("not allowed here").
- The retargeted source-text test in `tests/analytics.test.ts` still asserts `protocol === 'https:'`. That check now lives only in `validator-core.ts`, so the test still pins the real check and is not weakened. I also confirmed the behaviour: an `http://` image URL is rejected.

### 3. Reserved anchors (Low): fixed

`page-ids.ts` builds the list from `LOCKED_TITLE_ID`, `RELATED_VIDEOS_ID`, `CONFIG_ELEMENT_ID` (`zuey-analytics`), `main`, `content` and `top`. The article and lesson pages now use those constants. I confirmed that a section anchor `zuey-analytics` is rejected.

### 4. Toggle note (Nit): done

The section note now says "never inside a layout, toggle or card".

### 5. Card `level`: correct

- **Validation:** `isOneOf([2,3,4])` with strict equality. These values are all rejected: `"3"`, `"2 onload=x"`, `"1><script>"`, `"h3"`, `1`, `5`, `3.5`, `true`, `[3]`, `null`. The tag name can only become `h2`, `h3` or `h4` in the renderer, and `h3`, `h4` or `h5` in email, so nothing can be injected into it.
- **Backward compatibility:** a stored card without `level` reads with `dropped 0`, renders `<h3 class="zb-card-title">` and is not rewritten with a `level`. The v1 compat snapshot still passes.
- **Markdown:** `## L2`, `#### L4`, `### Ld` (default).
- **Email:** the title changed from a bold `<p>` to `h{level+1}`, sized 20, 17 or 16 px.
- **Studio:** a `NumberSelect` from 2 to 4, clamped to a valid level.
- **OpenAPI and MCP:** `BlockCard.level` is `{type: integer, enum: [2,3,4], default: 3}` in `blockSchemas`, which both `openapi.ts` and `mcp.ts` (`block_schema`) read. `BLOCK_SCHEMA_NOTES` mentions it as well.

## Findings

- **Nit** (`tests/section-card-blocks.test.ts:349`): a missing newline joins `it('keeps documents without sections on the original cut', () => {` and `const doc = …` on one line. This is cosmetic only.
- **Note, no action needed:** on a lenient read, a stored card with an invalid `level` is dropped as a whole card instead of losing only the field. This cannot happen through the API, because writes are validated strictly.

## Follow-up candidates (out of scope)

- In a section, a layout whose cells are all empty yields no paywall units. A card whose body is only such a layout would disappear from both the kept part and the withheld outline. This is not a leak, and it was already the behaviour before this change. The validator accepts a layout with an empty cell. A possible follow-up is to treat a unit-less container as one leaf unit.

## Cleanup

The `rv137` worktree, the `review-137` branch, the temporary adversarial test files, and the `dist/` and `.wrangler/` folders inside that worktree were all removed.
