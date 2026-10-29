# Review: PR #323 — fix(taxonomy): return 409 label_conflict when a label rename takes a used slug

- Closes: #318
- Head: `315b6b63ff6a4ad4bae7efee716e312d54539907`
- Reviewed in a fresh temp worktree (`%TEMP%\rv323`), now removed with its `dist/` and `.wrangler/`.

## Gates

| Gate | Result |
| --- | --- |
| Scope (`git diff --stat origin/main...315b6b6`) | 3 files: `src/lib/taxonomy/labels.ts`, `src/lib/taxonomy/openapi.ts`, `tests/knowledge.test.ts` (+99/-11) |
| `bun install --frozen-lockfile` | OK |
| `bun test tests/knowledge.test.ts` | 65 pass, 0 fail |
| Same file with `labels.ts` and `openapi.ts` from `origin/main` | 62 pass, 3 fail (the changed 409-doc test and both new tests) |
| `bun test` (full) | 2034 pass, 0 fail, 115 files |
| `bun run build` | astro check 0 errors, 0 warnings (74 hints); build complete |
| `gh pr checks 323` | `Test & Build` pass (2m4s) |

## Verification against the brief

1. **Pre-check scope.** `assertSlugFree` (`labels.ts:154-157`) filters `kind = ? AND slug = ? AND id <> ?`, so it is scoped by kind. `updateLabel` (`labels.ts:200-201`) only runs it when `slug !== label.slug`, so a no-op rename passes. The test checks this case and gets 200. A kind change still fails earlier with `400 invalid_field` (`labels.ts:199`), and built-in labels fail with `400 builtin_label`. As a result the pre-check always uses `label.kind`, which is the stored kind. A tool label taking a domain label's slug returns 200, and the test covers it.
2. **Unique-violation mapping.** `runLabelWrite` (`labels.ts:160-167`) uses `isUniqueViolation` (`members/runtime.ts:92`), which matches any `UNIQUE constraint failed` message. On `taxonomy_labels` the only unique keys are the `id` PK and `UNIQUE (kind, slug)` (migration `0009_knowledge_taxonomy.sql:130-146`). No triggers touch this table. The UPDATE never changes `id`, so there a unique violation can only come from `(kind, slug)`. The INSERT could also hit an `id` PK collision. See finding L1. Other constraint errors (CHECK on `kind`, NOT NULL) do not match the regex and still propagate. No misleading 409 is possible for those.
3. **Soft-deleted slug.** Returns 409. This is the intended semantics. `createLabel` on main already checked `(kind, slug)` with no `deleted_at` filter. The DB index also reserves deleted rows, so allowing the rename is impossible without a hard delete or a schema change. The new behavior is consistent with create and with the index. The tag equivalent is tracked separately in #320.
4. **Revision checks.** The order is `requireRevision` (shape) → load → built-in/kind guards → slug pre-check → `UPDATE ... WHERE revision = ?`. This is the same order as `updateCategory` (`categories.ts:103-111`) and `updateTag` (`tags.ts:170-179`). A stale revision with a free slug still matches 0 rows and returns `revision_conflict`. A stale revision whose UPDATE would collide matches no row, so no unique violation fires and it still returns `revision_conflict`. A stale revision combined with an already-taken slug returns `label_conflict` first, the same as the sibling resources.
5. **OpenAPI.** `openapi.ts:20,26-27`. PUT 409 now documents `label_conflict` (with the deleted-label reservation note) or `revision_conflict`. These are exactly the two 409 codes `updateLabel` can throw. POST shares the `label_conflict` text, and that matches `createLabel`. The 409-doc test asserts the exact code set per operation.
6. **Tests.** The tests exercise real SQLite through `createTestD1`. REST and MCP are both checked for a taken slug and a soft-deleted slug. The same-slug no-op and the cross-kind case are also covered. The race test wraps one statement so that it inserts the competing row right before `run()`. That hits the real unique index, so the race is not mocked. All 3 fail on main source.
7. **Scope.** Only the 3 declared files.

## Findings

| # | Severity | Location | Scenario |
| --- | --- | --- | --- |
| L1 | Low | `src/lib/taxonomy/labels.ts:160-167` (`runLabelWrite`), `src/lib/members/runtime.ts:92` | On INSERT, a `UNIQUE constraint failed: taxonomy_labels.id` error from a primary-key collision would be reported as `409 label_conflict` for a slug that is actually free. `newId` uses 64 random bits (`common.ts:15`), so this is practically unreachable, and the UPDATE path cannot hit it. An optional hardening would match the column list (`/taxonomy_labels\.kind, taxonomy_labels\.slug/`). Not blocking. |
| L2 | Low | `tests/knowledge.test.ts` (label section, ~755-810) | No test asserts that a label PUT with a stale `expected_revision` (with or without a slug change) still returns `revision_conflict`. Code reading confirms the behavior is unchanged (`labels.ts:213`). This is a coverage gap only, not a defect. |
| I1 | Info | `src/lib/taxonomy/labels.ts:146-148` | When the slug belongs to a soft-deleted label, the error reads `Label domain:x already exists`, but `GET`/list never shows that label. The documented OpenAPI note explains the reservation, and the message matches the existing create behavior. Optional wording tweak. |
| I2 | Info | `src/lib/taxonomy/mcp.ts:63` (not in diff) | The MCP `label_update` input schema does not list `slug`, yet it is passed through `parseLabelInput`. This is pre-existing and already tracked as #325. It is out of scope here. |

No Critical, High or Medium findings.

## Verdict

**MERGE**. The fix is correct, scoped by kind, and consistent with the category/tag patterns and with create's soft-delete semantics. Tests are meaningful and fail on main. All gates and CI are green. L1 and L2 are optional follow-ups.
