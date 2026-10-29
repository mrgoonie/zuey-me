# Review: PR #137 (closes #67): block registry, section and card blocks, width lanes

Head `09b8cd1`, merged locally with `origin/main` (`13ebe5d`). The merge was clean and nothing was pushed. Reviewed in an isolated context that did not write the PR.

## Verdict: REQUEST_CHANGES

There is one small paywall fix to make: a card footer can survive in the locked preview. Everything else is sound. The registry refactor holds v1 output byte-for-byte across all surfaces, nesting is enforced on the server, and the new render paths are escaped.

## Findings (by severity)

### Medium: a partly withheld card can keep its footer in the paid preview (`src/lib/blocks/paywall.ts:137`)

`joinUnits` drops the footer only when `copy.blocks.length < source.blocks.length`. That compares direct children. A card whose body is a single layout, with some layout cells withheld, has 1 kept child against 1 source child, so the footer stays.

Reproduction (anonymous viewer, `access: 'knowledges'`): section > card (footer `SECRETFOOTER`) > layout with cells [a] and [b, z], followed by paragraph x. Kept ids: `s, c, l, a, b`, and the footer is present in `out.doc`. The same document then feeds SSR, `.md`, the AI context, the search preview and the email teaser.

This contradicts the PR's own rule ("a partly kept card drops its footer"). The impact is small, because a footer is usually a CTA, but it is withheld-end content.

**Fix:** decide footer kept/dropped by units, not by direct children. For example, record each card's total unit count (or its last unit) in `sectionUnits`, and keep the footer only when every unit of that card is kept. Add a test with section > card > layout, partly kept.

### Low: the shared `validate` chunk doubled and is lazy-loaded on article pages (`src/lib/ai/artifacts.ts:27`)

Built client chunk `validate.*.js`:

| | Raw | Gzip |
|---|---|---|
| Before | 15,311 B | 5.0 kB |
| After | 33,094 B | 10.4 kB |

The registry now pulls in every definition's markdown, schema and examples. Two places import it:
- `StudioApp`;
- `ZueyAiPanel`, through `validateInteractiveBlock` → `validateDocument`. `ArticleAskAi` lazy-loads this panel on article pages when a reader opens Zuey AI.

So the PR's "reader islands do not load it" is not quite true, and the "+2.8 kB StudioApp" figure leaves out the shared chunk.

What is fine:
- The initial reader bundle is unchanged. `BlockRenderer` is 26,851 B, against 25,562 B on main, and it does not import the registry or the validator.

**Suggestion (follow-up is acceptable):** validate an interactive artifact through the `interactive` definition alone, or with a slim validator that does not import `registry.ts`. Also correct the bundle note in the PR body.

### Low: the reserved-anchor list is incomplete (`src/lib/blocks/definitions/containers.ts:146`)

`zuey-analytics` is accepted as a section anchor, but `Layout.astro:87` already renders `<meta id="zuey-analytics">` on every page. Two consequences:
- The duplicate id is invalid HTML.
- When analytics is off, `getElementById` resolves to the section.

It is not exploitable today, because the meta sits in `<head>` and wins when present.

**Suggestion:** derive the list from the shared constants (`CONFIG_ELEMENT_ID`, `locked-title`, `related-videos`, …), or add a prefix to section anchors.

### Nit: toggle wording in the schema notes (`src/lib/blocks/openapi.ts:35`, `containers.ts:139`)

The wording still says a toggle "may not contain toggle or layout". Section is excluded too. That is implied by the top-level rule and was kept for the v1 schema snapshot, so it is fine to leave. You could mention it once in the section note.

### Decision: card title heading level (`src/components/blocks/ContainerBlocks.tsx:38`)

`h3` is the right default for the main use case: a grid of cards under a section `h2`, which is also the `block_schema` example. It breaks the outline in two cases:
- a top-level card directly under an `h1` skips a level;
- a card under an `h3` subsection becomes a sibling of that subsection.

**Recommendation:** add an optional `level: 2 | 3 | 4` (default 3) to the card schema, and use it in all four places:
- the renderer (`h${level}`);
- markdown (`#`.repeat(level));
- the email output (font size);
- a Studio select.

This is deterministic, needs no render-time pre-pass, and stays backward compatible. Deriving the level from the preceding heading would need a document pre-pass in `BlockRenderer` and in the markdown serializer. That is more coupling for little gain. This can be a follow-up issue and does not block the PR.

## Verified OK

- **v1 compatibility.** I copied the PR's `v1-documents-compat` test, fixtures and snapshot onto unmodified `origin/main` and ran them with `CI=true`: 4/4 pass. So the snapshot really records pre-registry output, and the PR reproduces it exactly. The snapshot covers:
  - SSR HTML (plain and article mode with highlights);
  - markdown, search text and AI text;
  - weights, the paywall split and the outline;
  - email (full and teaser);
  - v1 block JSON schemas.

  The fixtures include every v1 type and keep the #111 image `width`/`height` (image, gallery). The #108 lenient read is preserved: dropped 3, degraded 1, a nested bad child is skipped inside a toggle, and the toggle `caption` quirk is kept.
- **Paywall split inside sections.**
  - Locally seeded paid article with wide, full and prose sections: the SSR HTML and the `.md` view contain no withheld paragraph, and `locked-title` is shown.
  - Fully withheld cards do not leak their titles into `locked_outline`; only `heading` blocks are listed, as before.
  - Top-level blocks outside sections are split exactly as before (#138 covers top-level layout and toggle).
- **Nesting enforced on the server.** REST and MCP `article_create`/`article_update` both go through `parseArticleInput` → `validateDocument`.
  - Rejected: section in section, section in layout, section in card, card in card through a layout, a duplicate anchor, a bad anchor, a `javascript:` card image.
  - On a lenient read, a nested section is dropped and counted.
  - Studio uses the same `canContain`/`childContext`.
- **Escaping.** I tried card title, footer, image alt and URL, and a paragraph, each containing `<img onerror>`, `"><script>` or `[x](javascript:…)`:
  - SSR: no raw tags and no `javascript:` hrefs. React escapes everything; class names come only from enums, and the anchor is slug-validated.
  - Email: the same (`inlineHtml`, the `image()` helper).
- **OpenAPI/MCP.** `BlockSection`/`BlockCard` are generated from the registry and included in the `Block` `oneOf`/discriminator. The card `anyOf` encodes "title, image or ≥1 block". `block_schema` returns the examples. The v1 schemas are unchanged (snapshot).
- **Studio.** Load, save, confirm (#112) and the root `BlockListEditor` are untouched. Only the catalogue, defaults, `SectionFields`/`CardFields` and the shared nesting filter changed.
- **Traversals.** `walkBlocks`/`findBlock` go through `childBlockLists`, so surveys, code highlighting, the indexer and lesson ids all see blocks inside sections and cards.

## Gates

- `bun test` (merged): **989 pass, 0 fail**, 4 snapshots, 55 files.
- `bun run build` (merged): astro check reports **0 errors, 0 warnings** (711 files), and the build completes.
- The new tests fail on `origin/main`: `section-card-blocks.test.ts` and `block-frame.test.ts` cannot resolve `nesting` or `BlockFrame`. The compat test passes on main by design, since it is a regression guard.

## Browser smoke

Dev server on port 4455, local D1 only (`wrangler d1 migrations apply --local`, plus seeded `i67-lanes`, `i67-lanes-paid` and `i67-plain`).

- **1440px, lanes article:**
  - article 1240px; wide 1040px; full 1142px; prose 764px; paragraph 764px;
  - no horizontal page overflow (scrollWidth 1425 ≤ 1440, the long code line scrolls inside `.zb-scroll`);
  - 0 console errors.
- **375px:**
  - lanes, plain and paid articles: scrollWidth 375, so no overflow;
  - plain article: no lanes markup;
  - paid article: shows 2 partial sections and the lock box;
  - 0 console errors.

The server's process tree was stopped afterwards. The temporary worktrees (`rv137`, `rv137-main`), including `.wrangler/` and `dist/`, were removed.
