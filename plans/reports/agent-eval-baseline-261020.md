# Agent eval baseline — 2026-10-20

Base: https://zuey.me (production, before any #204 change). Suite: `tests/agent-eval/`.
One baseline report for the epic: Lighthouse (below) plus the agent eval lanes.

| Lane | Pass rate |
| --- | --- |
| fetch (no JS) | 10/14 (71%) |
| mcp (anonymous) | 13/13 (100%) |
| browser | pending — run by orchestrator (checklist of 12 tasks) |

## Lighthouse (production, 2026-10-20, lighthouse@13.5.0, median of 3)

Article = `/articles/tui-dang-xay-nhung-cong-cu-de-nguoi-khac-khong-can-den-minh-nua`.

| page | form | perf | LCP ms | CLS | TBT ms | FCP ms |
|---|---|---|---|---|---|---|
| article | desktop | 91 | 1466 | 0.000 | 0 | 678 |
| article | mobile | 62 | 6722 | 0.001 | 398 | 1872 |
| articles | desktop | 88 | 789 | 0.117 | 0 | 789 |
| articles | mobile | 80 | 1794 | 0.003 | 16 | 1794 |
| home | desktop | 90 | 1231 | 0.017 | 0 | 1077 |
| home | mobile | 56 | 6244 | 0.006 | 319 | 2247 |
| pricing | desktop | 99 | 657 | 0.000 | 0 | 657 |
| pricing | mobile | 99 | 1714 | 0.001 | 57 | 1714 |

## Failing fetch tasks

- `fetch-pricing-url`: no link to `/pricing` is discoverable from `/`, `/llms.txt` or `/index.md` (the home HTML has no pricing anchor; llms.txt does not list it).
- `fetch-list-apps`: the server-rendered home HTML does not name the ZueyOS apps (pricing missing; the desktop is a JS island).
- `fetch-app-deeplink`: nothing fetched documents `/#<app>` deep links.
- `fetch-referral-url`: no link to `/referral` is discoverable.

Notes: the MCP lane was 12/13 on the first run because `mcp-list-courses` required data while no course is published; its expectation was corrected to check for a valid JSON array (an empty catalog is a valid answer). Reproduce with `bun run agent-eval:fetch` and `bun run agent-eval:mcp`.

## Unresolved questions

- Browser lane baseline is pending (orchestrator).
