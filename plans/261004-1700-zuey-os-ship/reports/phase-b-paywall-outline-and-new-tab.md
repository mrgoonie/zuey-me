# Phase B report: partial paywall outline + open-in-new-tab

Status: DONE

## What changed
- `src/lib/blocks/paywall.ts`: `applyPaywall` returns `outline?: LockedOutline` when truncated:
  `{ headings: [{ level, text }], blocks, words }`. Only top-level withheld heading blocks contribute
  (plain text via `inlineToPlain`); `words` uses `wordCount(documentText(...))` (CJK-aware). No other
  withheld text is returned. Entitled viewers / free articles get no outline.
- `src/lib/blocks/articles.ts`: `ArticleView.locked_outline?` set only when truncated. REST
  `GET /api/v1/articles/{slug}` and MCP `article_get` pass it through unchanged (no code change needed);
  `.md` route unchanged (uses only `document` + `truncated`).
- `src/lib/blocks/openapi.ts`: `Article` schema documents `locked_outline`.
- `src/pages/articles/[slug].astro`: when truncated renders `.zb-lock-wrap` > `.zb-lock-outline.zb-paywalled`
  (real h2/h3/h4 per block level, text blurred, sr-only "Locked section:" prefix, aria-hidden skeleton lines,
  fade gradient) + `.zb-lockbox` card (lock icon, title, "N more sections (~M min) for members", body,
  See plans / Sign in, 44px targets). JSON-LD `hasPart` selector `.zb-paywalled` still matches.
- `src/styles/blocks.css`: replaced `.zb-locked` with `zb-lock-*` / `zb-lockbox*` styles; reduced-motion
  disables the only transition. Lockbox text on white: stone-900 / stone-700 / amber-900 (all > 7:1).
- `src/components/knowledge/ArticleCard.tsx`: sibling `ExternalLink` icon link (`target=_blank rel=noopener`,
  localized aria-label `Open in new tab: <title>` + title), `z-10` above the card overlay, 44px on phones.
  Applies to the homepage panel and the /articles list (both use ArticleCard). KnowledgesPanel needed no change.
- `src/components/knowledge/strings.ts`: `lockedMore`, `lockedSection`, `openInNewTab` in vi/en/zh/ko/ja.
- `tests/blocks.test.ts`: unit tests (outline = withheld headings only, no withheld body text; entitled
  and free get no outline/truncation) + route test (REST outline shape, no paid text in REST/MCP/.md,
  admin gets full text and no outline).

## Verification
- `bun test tests/blocks.test.ts`: 24 pass. `bun test` (full): 313 pass, 0 fail.
- `bunx astro check`: no diagnostics in touched files. 2 errors remain in `src/components/os/os-i18n.ts`
  (missing `./look`, `./apps`) from the concurrent OS-shell agent's in-progress work.

## Notes
- Headings nested inside layouts/toggles of the withheld part are not outlined (top-level only, by design).
- No visual browser check was run (dev server is out of scope for this phase).
