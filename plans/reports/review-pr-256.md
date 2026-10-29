# Review: PR #256, fix(about): draw a graphic mark for every product link icon

- PR head: `8674450` (parent `a0c1489`). Closes #199, supersedes #200.
- Merges cleanly with current `origin/main` (2 commits ahead of the PR base).
- Reviewer did not write this code.
- Date: 2026-10-23 (Asia/Saigon)

## Verdict

**Changes requested.** I found one major issue and no blockers. The icon resolution is correct, tests and build pass, and the About page renders as intended. The problem is the generic Lucide fallback: it pulls the whole curated icon map into the eagerly loaded home-page shell. The repo had deliberately kept that map lazy.

## Verification

| Check | Result |
| --- | --- |
| `bun test` (PR head) | 1655 pass, 0 fail. A first run failed 5 tests (`zueyos-liquid-glass` and others) because I was running the base build at the same time; a clean rerun passed. |
| `bun run build` (PR head) | astro check 0 errors, 0 warnings, 69 hints. Build completed. |
| Bundle comparison | Built `a0c1489` (the PR parent) and the PR head, then compared `dist/_astro`. |
| Screenshots | Viewed `about-icons-desktop.png` and `about-icons-mobile-future.png`. All product rows show a glyph badge. Future rows show the link mark or a Lucide icon. No initials. |

## Findings

### 1. Major: the home page now eagerly ships the whole curated Lucide map (~50 KB raw, ~12.7 KB gzip)

- `src/components/BrandIcons.tsx:4` statically imports `ICON_COMPONENTS` from `./blocks/block-icons`. Line 251 uses it for the generic name/alias fallback.
- `src/components/blocks/BlockRenderer.tsx:26-30` documents the existing decision: "The icon map (~40 KB) ships to the browser only for documents that use icons." That is why `block-icons` is loaded with `lazy(() => import('./block-icons'))`. This PR bypasses that decision for every page that renders `BrandIcon`.
- Evidence from `dist/_astro`:
  - The only static importer of `block-icons` used to be `StudioApp`. Now it is `StudioApp` and `ZueyOS`.
  - `ZueyOS` is mounted with `client:load` on `src/pages/index.astro`, so the import is on the critical path of the home and About page.
  - I computed the full static-import closure of the ZueyOS chunk:
    - Base: 26 files, 279,543 B raw, 101,048 B gzip.
    - PR: 29 files, 329,947 B raw, 113,777 B gzip.
    - Delta: **+50,404 B raw (+18%), +12,729 B gzip (+12.6%)**.
  - New chunks on the critical path: `block-icons` (49,071 B raw, 11,242 B gzip) and `icons` (3,273 B raw, 1,576 B gzip).
- The six product badges alone cost very little: `Vault` and `Clapperboard` are inlined into ZueyOS, which grew only +3.5 KB raw. Almost all of the delta comes from the generic fallback, and no current link needs it.
- Fix options. The first is simplest.
  1. Drop the generic Lucide resolution from `BrandIcon`. Keep the six product badges and the neutral link fallback. That still fixes #199 and stops initials from ever appearing. If a future product needs a mark, add one more entry to `PRODUCT_BADGES`.
  2. Keep the feature but load it lazily. Use the same `Suspense`/`lazy` pattern as `IconSlot` in `BlockRenderer.tsx`, with an SSR static import and a same-size placeholder so hydration does not mismatch. Only `resolveIconName` (the small `icons` module) would stay static.
  - With either option, update the MCP and OpenAPI wording (finding 3) to match.

### 2. Minor: the Vault glyph reads as a boxed X at 18px

- `src/components/BrandIcons.tsx:16` uses `vault: { Icon: Vault, ... }`.
- Evidence: in `about-icons-desktop.png` and `about-icons-mobile-future.png`, the "AK Vault" row shows a square with a diagonal cross, like ⊠. At this size the Lucide `Vault` bolt and handle detail collapses. In a product list that reads as "close", "error" or "unavailable".
- Suggestion: use a glyph that survives 18px, such as `KeyRound`, `LockKeyhole` or `ShieldCheck`. The emerald background can stay.

### 3. Minor: the API description overstates "any curated Lucide icon name", because `cloud` and `x` are shadowed

- Files: `src/lib/mcp/dispatch.ts:57` and `src/pages/api/openapi.json.ts:201`.
- `cloud` and `x` are canonical names in the Lucide allowlist (`src/lib/blocks/icons.ts`, `objects` and `status` groups). In `BrandIcon` they never reach the Lucide branch:
  - `cloud` hits `PRODUCT_BADGES` at `BrandIcons.tsx:15` and renders the sky-blue CloudCog product badge.
  - `x` hits the X/Twitter logo case.
- An agent that reads the description and sends `icon: "cloud"` for a weather or hosting link gets the Cloud Harness product mark.
- The contract change is purely additive: it only adds a description. It matches the validator, because link `icon` is an unvalidated free string in both the REST create (`src/pages/api/v1/links/index.ts:42`) and MCP `create_link` (`dispatch.ts:163`). "Unknown names render a neutral link mark" is accurate. Only the shadowing is undocumented.
- Fix: say that brand and product names take precedence. If finding 1 is fixed with option 1, drop the Lucide clause altogether.

### 4. Nit: the documentation is incomplete and duplicated

- The same 230-character description is copied into `dispatch.ts:57` and `openapi.json.ts:201`.
- `update_link` (`dispatch.ts:74`), the PUT body and the `LinkItem` schema (`openapi.json.ts:102`) still show a bare `icon: { type: 'string' }`, so the create and update docs disagree.
- Suggestion: one shared constant, applied to create, update and `LinkItem`.

## Items checked and found OK

- **Resolution order is correct** (`BrandIcons.tsx:37-254`):
  1. Trim and lowercase the name.
  2. Product badges.
  3. The existing brand `switch`.
  4. In `default`: `resolveIconName` (canonical name or alias), then a neutral `Link` badge.
  - Empty string and `null` (via `item.icon ?? ''` in `LinkCard.tsx:104`) reach the link mark.
  - Covered by `tests/brand-icons.test.ts` (13 tests). They check the six distinct glyphs, case and space handling, the `launch` alias resolving to `rocket`, unknown and empty names, unchanged AgentKit and Substack marks, and a LinkCard with no icon.
- **Accessibility is fine.** The `GlyphBadge` SVG is `aria-hidden="true"` and `focusable="false"` (line 33). The wrapping `div` has no role and no text. In `LinkCard` the visible title names the link, so the mark is decorative. This is correct, and better than #200's `aria-label` on a decorative icon.
  - Pre-existing, not introduced here: the hand-drawn brand SVGs carry no `aria-hidden`. The header social links have `aria-label`, so the impact is low.
- **No regression on the profile header social icons.** `ProfileView.tsx:40-48` hard-codes `ig`, `tiktok`, `whatsapp`, `youtube`, `fb`, `threads` and `x`, and all of them hit existing brand cases. `ShareModal` uses `x`, `fb`, `whatsapp`, `linkedin` and `messenger`, all known. `starburst` is known.
  - Only an unknown social name would change, from 2-letter initials to a stone link badge. Today that path is unreachable, and the change is acceptable: initials were the reported defect.
- **No network requests or `<img>`.** All marks are inline SVG. The tests assert there is no `src` or `href`.
- **Visual result is as intended.** The 28px badge (with an ~18px glyph) inside the 44px `bg-stone-100` slot matches the size of the existing brand badges at desktop 1280 and mobile 390 widths. AgentKit keeps its AK wordmark.

## Author notes

- **Vault reads like a boxed X:** confirmed. See finding 2.
- **Social-icon fallback:** acceptable. Every current caller passes a known brand name, so nothing visible changes. See "Items checked and found OK".

## Cleanup

- Removed both temporary worktrees: `.claude/worktrees/review-256` (PR head) and `.claude/worktrees/review-256-base` (base `a0c1489`).
- Their `dist/` and `.wrangler/` folders went with them, and the local `pr-256-review` ref was deleted.
- Nothing was pushed or commented on GitHub.
