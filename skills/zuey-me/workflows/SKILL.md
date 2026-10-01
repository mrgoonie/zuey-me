---
name: zuey-me-workflows
description: "Find repeated AI workflows in Zuey's local Claude Code / Codex sessions, redact them, and save them as drafts on zuey.me/workflows (never auto-publish)."
user-invocable: true
keywords: [zuey, workflows, claude-code, codex, sessions, redaction, mcp]
metadata:
  author: zuey
  version: "1.0.0"
---

# Zuey's AI Workflows — local extraction

Use this skill to turn repeated tool sequences from **local** agent sessions into
workflow drafts on `https://zuey.me/workflows`.

## Privacy contract

- The script runs only on Zuey's machine; it is not part of the site bundle.
- Raw session text is never uploaded. Only aggregated tool/command sequences are kept,
  and every string is redacted (API keys, GitHub/AWS/Slack tokens, private keys,
  Bearer tokens, home paths, emails, the local username) before it is written to disk.
- The redaction regexes mirror the server scanner in `src/lib/workflows/secret-scan.ts`.
  Keep both lists in sync.
- Uploading requires an explicit `y` per candidate (or `--yes`). Uploads create/update
  **drafts only**; publishing is a separate, confirmed step in Studio or via
  `workflow_publish` with `confirm: true`. The server blocks publishing when secrets are found.

## Run

```bash
export ZUEY_API_KEY=<admin key>          # needed for diff + upload
node skills/zuey-me/workflows/scripts/extract-workflows.mjs --since 7d --dry-run
node skills/zuey-me/workflows/scripts/extract-workflows.mjs --since 14d     # prompts y/n per draft
```

Flags: `--since 12h|7d|2w`, `--claude-dir` (default `~/.claude/projects`),
`--codex-dir` (default `~/.codex/sessions`), `--out` (default `./workflow-candidates.json`),
`--url` (default `https://zuey.me` or `ZUEY_URL`), `--min-sessions 3`, `--top 10`,
`--dry-run`, `--yes`.

## Heuristic

Each session becomes an ordered list of tool tokens (`Read`, `Edit`, `$ bun test`, ...),
consecutive duplicates collapsed. 3–5-token n-grams are counted once per session; those
seen in at least `--min-sessions` sessions are ranked by `sessions x length`, and
sub-sequences of already chosen candidates are dropped.

## After extraction

1. Review `workflow-candidates.json` and the printed diff (`+` create, `~` update, `=` unchanged).
2. Upload chosen drafts (writes use `expected_revision`; a 409 means someone edited the draft — re-run).
3. Rewrite names/steps into a human story in Studio → AI Workflows, then publish with confirmation.

## Server API reference

- REST: `GET/POST /api/v1/workflows` (`?include_drafts=1` admin), `GET/PUT/DELETE /api/v1/workflows/{slug}`,
  `POST /api/v1/workflows/{slug}/publish` with `{ "expected_revision": n, "confirm": true }`.
- MCP: `workflow_list`, `workflow_get`, `workflow_create` (`expected_revision: 0`), `workflow_update`,
  `workflow_delete`, `workflow_publish`.
