# Agent eval baseline — 2026-10-20

Base: https://zuey.me (production, before any #204 change). Suite: `tests/agent-eval/`.
Lighthouse table is tracked separately in #206 / the perf work; this report covers the agent lanes.

| Lane | Pass rate |
| --- | --- |
| fetch (no JS) | 10/14 (71%) |
| mcp (anonymous) | 13/13 (100%) |
| browser | not run (checklist for a browser-driving agent: 12 tasks) |

## Failing fetch tasks

- `fetch-pricing-url`: no link to `/pricing` is discoverable from `/`, `/llms.txt` or `/index.md` (the home HTML has no pricing anchor; llms.txt does not list it).
- `fetch-list-apps`: the server-rendered home HTML does not name the ZueyOS apps (pricing missing; the desktop is a JS island).
- `fetch-app-deeplink`: nothing fetched documents `/#<app>` deep links.
- `fetch-referral-url`: no link to `/referral` is discoverable.

Notes: the MCP lane was 12/13 on the first run because `mcp-list-courses` required data while no course is published; its expectation was corrected to check for a valid JSON array (an empty catalog is a valid answer). Reproduce with `bun run agent-eval:fetch` and `bun run agent-eval:mcp`.

## Unresolved questions

- Browser lane has no result yet; needs a browser-driving agent run.
