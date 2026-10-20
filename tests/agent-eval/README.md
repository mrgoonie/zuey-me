# ZueyOS agent eval suite

Repeatable measurement of how well agents can use the site, in three lanes. Each task has an id, a
natural-language prompt and a machine-checkable expectation. Runners print a PASS/FAIL table and the
lane pass rate; task failures never change the exit code (only runner errors do).

| Lane | Run | What it simulates |
| --- | --- | --- |
| fetch | `bun run agent-eval:fetch [--base URL] [--json out.json]` | No-JS agent: starts at `/`, `/llms.txt`, `/index.md`, follows links whose URL/anchor text match the task intent (`follow`, `maxHops`). No deep URL is hard-coded. |
| mcp | `bun run agent-eval:mcp [--base URL] [--json out.json]` | Anonymous JSON-RPC against `${base}/api/mcp`; read-only tools only (allowlist in `tasks-mcp.ts`). |
| browser | `bun tests/agent-eval/run-browser.ts [--base URL]` | Prints a checklist and a results template for a browser-driving agent; not automated. |

Default base is `https://zuey.me`. Expectations are `link` (a discovered absolute URL matches), `text`
(fetched text matches) or `notText`, as case-insensitive regexes. The latest-article task resolves its
ground truth from the MCP API at run time. Pure parts (link extraction, matching, crawling with a fake
fetcher) are covered by `agent-eval.test.ts`, which needs no network.

Tasks must reflect what an agent legitimately needs: never edit them to make a baseline pass.
