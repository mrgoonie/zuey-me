# ZueyOS agent eval suite

Repeatable measurement of how well agents can use the site, in three lanes. Each task has an id, a
natural-language prompt and a machine-checkable expectation. Runners print a PASS/FAIL table and the
lane pass rate; task failures never change the exit code (only runner errors do).

| Lane | Run | What it simulates |
| --- | --- | --- |
| fetch | `bun run agent-eval:fetch [--base URL] [--json out.json]` | No-JS agent: starts at `/`, `/llms.txt`, `/index.md`, follows links whose URL/anchor text match the task intent (`follow`, `maxHops`). No deep URL is hard-coded. |
| mcp | `bun run agent-eval:mcp [--base URL] [--json out.json]` | Anonymous JSON-RPC against `${base}/api/mcp`; read-only tools only (allowlist in `tasks-mcp.ts`). |
| browser | `bun run agent-eval:browser [--base URL] [--json template.json]` | Prints a checklist and a results template (agent model, signed-in state, deviations) for a browser-driving agent; not automated. |

Default base is `https://zuey.me`. Expectations are `link` (a discovered absolute URL matches), `text`
(fetched text matches) or `notText`, as case-insensitive regexes. The latest-article task resolves its
ground truth from the MCP API at run time. Pure parts (link extraction, matching, crawling with a fake
fetcher) are covered by `agent-eval.test.ts`, which needs no network.

Tasks must reflect what an agent legitimately needs: never edit them to make a baseline pass.

## Reading results

- `PASS` / `FAIL`: the pages or tool responses were fetched fine; the expectation was met or not.
- `ERR`: a runner problem (network error, 5xx, malformed JSON-RPC, tool error). Any `ERR`, or a failed
  preflight (`/` for fetch, `initialize` for mcp), makes the process exit non-zero. Plain `FAIL`s never do.
- The mcp lane's `mcp-no-mutating-tools` fails if anonymous `tools/list` exposes any tool outside
  `READ_ONLY_TOOLS` (or one with a mutating verb suffix).
- `follow` regexes in `tasks-fetch.ts` are a proxy for agent judgement about which link to click, not a
  guarantee that every agent would follow them.
- `mcp-list-courses` originally required course data; with no course published it failed for the wrong
  reason, so the expectation became "valid JSON array" (a validity fix, not a tuning to pass).
- `lighthouse/` holds the scripts behind the Lighthouse baseline (`lh-run.sh <outdir>` then `lh-summary.py`).
