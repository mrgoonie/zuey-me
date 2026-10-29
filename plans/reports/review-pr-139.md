# Review: PR #139 (closes #127)

fix(ai): refuse to attach an artifact over a recovered article draft
Head `3e8bfb5`, reviewed with the latest `origin/main` (`39b84d8`) merged in locally. Nothing was pushed.

## Verdict: APPROVE

No blocking or medium findings.

## Checks

| Check | Result |
| --- | --- |
| Recovery detection matches Studio (#108/#112) | Yes. `getArticle().draft_recovery` comes from `readStoredDocWithRecovery` (`src/lib/blocks/articles.ts:175-185`). It is non-null exactly when `unreadable \|\| dropped > 0 \|\| degraded > 0`, the same predicate as Studio's `parseDraftRecovery` and `needsOverwriteConfirm` (`src/components/studio/recovered-draft.ts:22-52`). A draft whose blocks were all dropped is reported `unreadable`, so it gets the `draft_unreadable` path. |
| TOCTOU between check and write | Safe for this fix. The recovery flag and the blocks that get appended come from the same `getArticle` read of the same `draft_json` (`admin-chat.ts:76-80`). The write goes through `updateArticle`, which uses `WHERE revision = ?` (`articles.ts:708-712`). Every edition draft write bumps `articles.revision`, so a concurrent Studio save makes the attach fail with `revision_conflict`. One pre-existing, very narrow window is noted under L1. |
| Confirm flag strict | Yes: `body.confirm_recovered_draft === true` (`admin-chat.ts:78`). The string `"true"` and `1` are rejected. `unreadable` is refused even when the flag is true (`admin-chat.ts:45-48`). |
| Admin-only auth unchanged | Yes. `requireCan(p, 'admin')` still runs first, and the reason and audit for another member's artifact are unchanged (`admin-chat.ts:67-75`). The route is unchanged apart from its doc comment. |
| `error.recovery` leak | None. It holds only `{dropped_blocks, degraded_embeds, unreadable}` counts, the same shape the admin draft read already returns. `jsonError` spreads `extra` into `error`, so the documented `error.recovery` field is accurate (`src/lib/http.ts`). |
| OpenAPI fragment | Accurate. The `confirm_recovered_draft` boolean and the three 409 codes are documented (`src/lib/ai/openapi.ts:145,150`). `error.recovery` is described in prose only; that is acceptable because `DocumentRecovery` is already a named schema. |
| Other paths that append to drafts | None found. `updateArticle` has three callers: REST `PUT /api/v1/articles/{slug}`, MCP `article_update` (`src/lib/blocks/mcp.ts:217`) and this attach. REST and MCP replace the whole document with one the caller supplies. With no document they keep `draft_json` byte for byte and refuse an unreadable draft (`articles.ts:702`). Their read tools (`article_get` with `draft: true`, `article_revisions`) already return `recovery` and warn that writing it back makes the loss permanent. Nothing in `src/lib/ai` or `src/lib/ai/mcp.ts` writes articles. No import route writes drafts. `survey.ts:62` reads the draft only. |

## Findings

### Low

- **L1 (pre-existing, not introduced here): `updateArticle` is not atomic** (`src/lib/blocks/articles.ts:708-719`). It bumps `articles.revision` and then writes `article_editions.draft_json` as two separate statements. A reader in between can see revision R+1 with the old draft. An attach in that window that already holds `expected_revision` R+1 could write the old draft plus the block over a Studio save that is still landing. The window is milliseconds long, and the caller would need the new revision before the draft lands. Wrapping the two statements in `db.batch`, or doing the edition write first, would close it. This affects every `updateArticle` caller. If the maintainer cares, it belongs in its own issue, not this PR.
- **L2 (test gap, nit): the test does not check `error.recovery`** (`tests/ai-chat.test.ts:648-652`). It never asserts the `error.recovery` payload, or that a non-boolean `confirm_recovered_draft: "true"` is still refused. The code handles both correctly. An assertion on each would protect the contract.

### Info

- When the artifact belongs to another member, `recordAdminAccess` runs before the recovery refusal (`admin-chat.ts:73-78`), so a refused attach still leaves an audit row. That is consistent with the existing 404 path and arguably correct, since the attempt is audited.
- When the request is lossy and also carries a stale `expected_revision`, it gets `draft_needs_recovery` rather than `revision_conflict`. Both are 409, and the client re-reads either way.

## Gates (merged worktree `D:\www\zuey\rv139`)

- `bun install --frozen-lockfile`: OK.
- `bun test`: 988 pass, 0 fail across 54 files. `tests/ai-chat.test.ts` on its own: 26 pass, 0 fail.
- `bun run build`: astro check reports 0 errors, 0 warnings and 65 hints. The build completes.
- Regression proof: with `src/lib/ai/admin-chat.ts` taken from `origin/main`, the new test fails with `Expected: 409, Received: 200`. It passes again once the PR version is restored.
