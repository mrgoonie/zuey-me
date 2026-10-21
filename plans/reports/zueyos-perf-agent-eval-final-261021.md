# ZueyOS perf and agent eval: final report (2026-10-21)

All measurements are against production at https://zuey.me after the epic #204 landed: #210, #211, #217, #228, #231 and #232, with main at 8d7bb03. The baseline before any change is in `agent-eval-baseline-261020.md`.

## Lighthouse (lighthouse@13.5.0, median of 3)

The article page is `/articles/tui-dang-xay-nhung-cong-cu-de-nguoi-khac-khong-can-den-minh-nua`.

| page | form | perf (baseline → now) | LCP ms | CLS | TBT ms | FCP ms |
|---|---|---|---|---|---|---|
| home | mobile | 56 → **96** | 1921 | 0.007 | 118 | 1279 |
| home | desktop | 90 → **95** | 699 | 0.013 | 18 | 407 |
| articles | mobile | 80 → **97** | 1385 | 0.000 | 22 | 1385 |
| articles | desktop | 88 → **97** | 375 | 0.001 | 0 | 375 |
| article | mobile | 62 → **100** | 1778 | 0.001 | 54 | 1202 |
| article | desktop | 91 → **100** | 521 | 0.001 | 0 | 441 |
| pricing | mobile | 99 → **100** | 1062 | 0.001 | 52 | 1051 |
| pricing | desktop | 99 → **99** | 380 | 0.001 | 0 | 380 |

Every target is met:
- Mobile perf ≥90, LCP <2.5 s, CLS <0.1 and TBT <200 ms on all four pages.
- Desktop perf ≥95 on all four pages. Home desktop is at the threshold (95).

## Agent eval

| Lane | Baseline | Now |
|---|---|---|
| fetch (no JS) | 10/14 (71%) | **14/14 (100%)** |
| mcp (anonymous) | 13/13 (100%) | **13/13 (100%)** |
| browser | 11/12 (92%) | **12/12 (100%)** |

Reproduce the fetch and MCP lanes with `bun run agent-eval:fetch` and `bun run agent-eval:mcp`.

### Browser lane

The browser lane ran on 2026-10-21 in the built-in browser, driven by claude-opus-5-5, signed in as the site admin. The viewport was 1024x768; the task list asks for 1280x800, but the pane's emulation was cropped.

| task | result | note |
|---|---|---|
| browser-open-pricing | PASS | Pricing window from the dock; Kết hợp shows $19/tháng |
| browser-open-zueytube | PASS | First video "Giới Thiệu AgentKit - Ship nhanh hơn, an toàn hơn." |
| browser-deeplink-pricing | PASS | Navigating from `/` to `/#pricing` on a loaded page opened Pricing. This was a deviation in the baseline and is fixed. |
| browser-standalone-pricing | PASS | `/pricing` is a normal page listing all four plans |
| browser-latest-article | PASS | Newest is "Tui đang xây những công cụ để người khác không cần đến mình nữa" |
| browser-read-article | PASS | First heading is "Sáu hướng thử nghiệm, một câu hỏi" |
| browser-find-mcp | PASS | MCP & API window shows `claude mcp add --transport http zuey https://zuey.me/mcp` |
| browser-open-github | PASS | Activity rendered on open, with no skeleton wait |
| browser-change-appearance | PASS | Switching to Sáng changed the chrome and the wallpaper previews; then switched back to Tối. The Liquid Glass toggle is visible. |
| browser-window-management | PASS | About was dragged. Reads was closed with its red button after clicking its title bar, because About overlapped Reads' traffic lights. |
| browser-mobile-layout | PASS | At 390x844 it opened straight to the home screen with no boot-window flash. The Pricing sheet's scrollWidth equals its clientWidth (390). |
| browser-keyboard-nav | PASS | Alt+4 opened Reads and a single Escape closed it. This failed in the baseline. |

## Verification on main at 8d7bb03

- `bun test`: 1569 pass, 0 fail.
- `bun run build`: complete, with 0 errors and 0 warnings.

## Follow-up issues filed (`ai-handle`)

- #219: flaky Shiki timeouts in tests.
- #229: in Safari and macOS Firefox, a second Escape after a mouse click does not close the window (PR #230 is open).
- #233: unfocused window titles fall below WCAG AA contrast (PR #234 is open).
- #238: `listArticles` runs twice per `/articles` render.

## Risks and open points

- Lighthouse was measured in the lab only; real-user field metrics (PostHog) were out of scope. The colo-dependent cold TTFB on `/articles` still varies by region, and #238 plus D1 read replication would reduce it.
- Liquid Glass drag smoothness on the Chromium liquid tier was measured locally before the fix. The menubar and dock keep their lens while a window is dragged; this was accepted as non-blocking in review.
- The Roboto bold fallback metrics are scaled from Arial rather than measured. Card heights on a real Android device have not been checked.
