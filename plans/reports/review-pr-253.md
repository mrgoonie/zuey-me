# Review: PR #253 — 200lab versioned JSON catalogs + learning paths (closes #198)

Reviewer: isolated agent (did not write this code). Head `d428812`, base `main`.
Date: 2026-10-23 (Asia/Saigon).

## Verdict

**Approve with one major to fix (or a strict deploy-order guard) before merge.** The core work is solid: feed validation is strict, the referral builder is correct, the migration is additive, and the UI meets the issue's acceptance criteria. The only real risk is the code/migration deploy order (M1). Everything else is minor or a nit.

## Verification run

| Check | Result |
|---|---|
| `bun install` | ok (742 packages) |
| `bun test` | **1636 pass, 0 fail** (98 files), matching the PR body |
| `bun run build` | astro check **0 errors, 0 warnings**, 69 hints; build complete |
| Temporary probe tests (deleted afterwards) | link builder, hostile URLs, markdown injection, missing table, schema drift; results below |

Remote D1 was not touched. Nothing was pushed or commented on GitHub.

## Findings

### Major

**M1 — Deploy-order hazard: `/api/v1/lab200` returns 500 until migration 0030 is applied** (`src/lib/lab200/store.ts:129-134`, `:185`; `src/pages/api/v1/lab200.ts:18-19`)
- `readRows()` runs `SELECT … FROM lab200_catalog` without a guard. A probe against a DB without the table threw `SQLiteError: no such table: lab200_catalog`. The API turns that into `500 internal_error`, so the `#200lab` window on the homepage shows its error/retry state. `/200lab` and `/200lab.md` catch it and render the empty state. `/200lab.md` sends `Cache-Control: public, max-age=300` (`src/pages/200lab.md.ts:13`), so the empty page can stay cached for 5 minutes after the migration lands.
- CI deploys production on merge to `main`, and the migration is a manual `wrangler d1 execute`. Merging first therefore always opens a window where these errors happen.
- Applying the migration **first** is safe: the old code reads only `lab200_snapshot`, which the migration leaves alone.
- Recommendation (pick one, ideally both):
  1. Make the read tolerant. In `getLab200Catalog`, catch an error whose message matches `/no such table: lab200_catalog/` and return `emptyLab200Catalog()` with a `console.warn`. Do **not** fall back to a live fetch on every request, which would send each page view to 200lab. Keep the existing 500 for other DB errors (`tests/lab200-route.test.ts:66` still holds), and add a test for the missing-table case. With this guard, deploy order no longer matters; the worst case is an honest empty state.
  2. Put an explicit step in the PR or merge checklist: "apply 0030 to remote D1 (after `wrangler d1 time-travel info`) **before** merging."
  - Keeping the old `courses.md` fallback is not worth it: it reintroduces the parser this PR deletes and the issue asks to remove.

### Minor

**m1 — A partial schema drift shrinks the last good catalog** (`src/lib/lab200/catalog.ts:241-245`, `store.ts:115-121`)
A feed is rejected only when **no** item is valid. Probe: last good had 2 courses, and the next feed renamed one item's `url` path → the stored catalog dropped to **1**. If 200lab changes a URL scheme or price shape for most items, a 28-course catalog could quietly become 1 course. That respects the letter of the issue ("invalid/empty … do not replace"), but it weakens the last-good guarantee. Suggestion: reject the feed when the valid share falls below a threshold (e.g. < 50% of `list.length`), and log the dropped count.

**m2 — Markdown injection through `summary` in `/200lab.md`** (`src/lib/lab200/markdown.ts:12-14`, `:35`)
`mdText` replaces only `<` and `>`. Titles are escaped (`[`/`]`), but summaries and meta are not. Probe output:
`- [T\](javascript:x)](https://200lab.io/courses/a?ref=T2CWW3D7): [click](javascript:alert(1)) ![x](https://evil/x.png) · …`
So a compromised feed can plant `javascript:` links or tracking images in `/200lab.md`, which is meant for LLMs and Markdown viewers. The React UI is not affected (the text is escaped). Fix: in `mdText`, escape `[ ] ( ) ! \` and backticks (or the full set of Markdown inline metacharacters), and add a test.

**m3 — `content_hash` is computed but never used to skip writes** (`src/lib/lab200/store.ts:116-121`)
Every successful refresh (at most once per 5 minutes per feed) rewrites `items_json` even when the content is the same. The hash is stored and nothing reads it. Either compare it with the stored hash (`… WHERE kind = ? AND content_hash <> ?`, still updating `synced_at`) or drop the column's claim from the docs. Low cost either way. The test "updates the hash only when the feed changes" passes trivially because the hash is deterministic.

### Nits

- **n1 — The link builder keeps any upstream query and drops fragments** (`catalog.ts:124-127`, `:253-258`). `ref` is set exactly once (verified: `?ref=X&ref=Y&utm=1#frag` → `?utm=1&ref=T2CWW3D7`), and foreign, `javascript:` and look-alike hosts fall back to `https://200lab.io/?ref=T2CWW3D7`. Two things to know: (a) any upstream query parameter is kept as-is (`?next=https://evil.com` passes validation; it stays on the 200lab host, so the risk is limited to an open redirect on 200lab's side), and (b) `URLSearchParams` re-encodes `%20` as `+`. Consider allowlisting query keys (e.g. `utm_*`) if 200lab ever adds them.
- **n2** — The copy still claims "Giảm 20%" plus a `−20%` badge (`copy.ts`), while prices say 200lab confirms the discount at checkout. The PR records this as a product decision, so it is left to the maintainer.
- **n3** — Tab a11y: ArrowLeft and ArrowRight both toggle, which is correct for two tabs, but would need index-based logic if a third tab is ever added. Tab panels have no `tabIndex={0}`. That is acceptable because each panel starts with a focusable link or button.
- **n4** — `track()` fires only on `onClick`, so middle-click or open-in-new-tab is not counted. This was already the case before the PR.

## Checklist against the brief

| Area | Result |
|---|---|
| Issue DoD: only `/courses.json` + `/learning-paths.json` fetched, no og:image or per-item scraping | Met. `store.ts:87-99` fetches only `LAB200_FEEDS[kind].url`; `jsonUrl` is validated but not fetched |
| Fail-closed validation: version, locale, empty list, item level | Met (see m1 for partial drift) |
| XSS in titles/URLs, `javascript:` links | UI safe: React escapes text, URLs are canonical `https://200lab.io/<prefix>/<slug>`, covers come only from `https://assets.200lab.io` (probe: `javascript:` cover → null, `200lab.io.evil.com` / `evil.com@200lab.io` / `%61` → rejected). `/200lab.md`: see m2 |
| Huge payloads | 1 MB cap, by header and while streaming (`store.ts:54-78`); ≤ 500 items, ≤ 10 prices, ≤ 8 variants, URL ≤ 2048, text capped |
| One feed failing never empties the other | Met. Separate rows, independent claims, and `refreshLab200Feed` catches fetch errors (test "a failing feed neither blocks nor wipes the other") |
| Referral `ref=T2CWW3D7` exactly once, host restricted | Met (n1) |
| Migration additive, old tables intact | Met. `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE`, idempotent; `lab200_snapshot` left as is; backfill re-validated on read; legacy row `checked_at = 1970` triggers a background refresh straight away |
| Migration number 0030 vs PR #235's 0029 | OK. No other open PR uses 0029 or 0030; the two migrations are independent, so either merge order works (a temporary gap at 0029 is harmless) |
| Deploy order | **M1** |
| Refresh path: timeout, redirects, edge constraints | 5 s `AbortSignal.timeout`, `redirect: 'manual'` + `status !== 200`, Web APIs only (`fetch`, `TextDecoder`, `crypto` via `hashString`); SWR via `ctx.waitUntil`; atomic claim on `checked_at`. No cron (on-demand only), which is fine. Errors use the `src/lib/http.ts` envelope |
| A cold feed blocks SSR | Only when a feed has no items (first request): one awaited fetch of at most 5 s; acceptable |
| OpenAPI | Updated with Cover/Pricing/Course/LearningPath schemas, matching `jsonOk` field names. No MCP tool exists for 200lab, which is correct |
| Analytics / PII | `200lab_learning_path_click` registered in `events.ts` and `docs/analytics-events.md`; properties are only `slug` + `source` |
| Tabs a11y | `role=tablist/tab/tabpanel`, `aria-selected`, `aria-controls`/`aria-labelledby`, roving `tabIndex`, Arrow/Home/End keys, `:focus-visible` ring, reduced-motion respected |
| Regressions: homepage `#200lab`, `/200lab.md` | `index.astro` is unchanged and still lazy-loads `Lab200Window` (`client:visible`); the page-weight budget test is updated and passes. `/200lab.md` has both sections, source URLs, sync time, locale, disclosure and ref |
| Not verified by the author (stated in the PR) | Referral checkout price (requires a 200lab login) and post-merge production checks. These remain open DoD items for after deploy |

## Unresolved questions

1. Should the maintainer apply 0030 before merging, or should M1's tolerant read be added so that deploy order does not matter? I recommend doing both.
2. What threshold is acceptable for m1? 50% is a suggestion.

Status: DONE
Summary: Approve after fixing M1 (missing `lab200_catalog` table → `/api/v1/lab200` returns 500 and `/200lab.md` caches an empty page; make the read tolerant and/or apply 0030 before merge). No blockers. Minors: partial schema drift can shrink the last-good catalog, `/200lab.md` summaries allow Markdown link injection, and `content_hash` is never used.
