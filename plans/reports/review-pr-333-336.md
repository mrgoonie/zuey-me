# Review: PR #333 (Closes #331) and PR #336 (Closes #325)

Date: 2026-10-25. Fresh-context, read-only review. Both PRs are based on current `origin/main` (780cfe2).

| PR | Head | Verdict |
| --- | --- | --- |
| #333 label conflict maps only `(kind, slug)` | 4d4e375 | **MERGE** |
| #336 `label_update` MCP schema lists `slug`, `aliases` | ffbf066 | **MERGE** |

## Gates (temp worktree `%TEMP%\rv333`, run one at a time)

| Gate | #333 @ 4d4e375 | #336 @ ffbf066 |
| --- | --- | --- |
| `bun install --frozen-lockfile` | ok (744 pkgs) | lockfile unchanged vs 333 |
| `bun test tests/knowledge.test.ts` | 67 pass / 0 fail | 67 pass / 0 fail |
| `bun test` | 2090 pass / 0 fail (117 files) | 2090 pass / 0 fail |
| `bun run build` | 0 errors, 0 warnings (76 hints), exit 0 | 0 errors, 0 warnings (76 hints), exit 0 |
| `gh pr checks` | Test & Build: pass | Test & Build: pass |
| Both merged together (4d4e375 + ffbf066, local `--no-commit`) | knowledge.test.ts 68 pass / 0 fail | |

Worktree, `dist`, `.wrangler` and probe outputs removed. Nothing pushed, commented or relabelled.

## PR #333

### Verification

- **Regex vs real error text (probe with bun:sqlite):**
  - Duplicate `(kind, slug)` on INSERT: `UNIQUE constraint failed: taxonomy_labels.kind, taxonomy_labels.slug`, match = true.
  - Rename UPDATE onto a taken slug: same text, match = true.
  - Primary key `taxonomy_labels.id` collision: match = false.
  - D1-wrapped text `D1_ERROR: UNIQUE constraint failed: taxonomy_labels.kind, taxonomy_labels.slug: SQLITE_CONSTRAINT`: match = true. The `taxonomy_labels.id` and `...slug_alt` variants: match = false.
- **Coverage, no regression to 500:** on main, only `runLabelWrite` in `labels.ts` mapped unique errors to `label_conflict`. Its two callers are `createLabel` (INSERT, `labels.ts:182`) and `updateLabel` (UPDATE, `labels.ts:208`). Both still go through it. No other `INSERT`/`UPDATE taxonomy_labels` in `src/` remaps unique errors. Soft delete (`labels.ts:233`) never changes `slug`. The schema (`migrations/0009_knowledge_taxonomy.sql:130`) has exactly one unique index besides the PK, `UNIQUE (kind, slug)`.
- The existing real-SQLite race test (`tests/knowledge.test.ts`, "loses the (kind, slug) race") still produces 409 for both create and update. So the regex is exercised by real engine text, not only by the mocked strings in the new test.
- It follows the same pattern as #330 (`tags.ts:114`, `/UNIQUE constraint failed: topic_tags\.slug\b/i`).
- Scope: `labels.ts` and `tests/knowledge.test.ts` only.

### Findings

| Severity | File:line | Scenario |
| --- | --- | --- |
| Nit | `src/lib/taxonomy/labels.ts:160` | `\b` after `slug` still matches a hypothetical future composite index whose column list starts `kind, slug, …` (probe: `…slug, taxonomy_labels.x` matches). No such index exists. The #330 tag regex has the same property. No action needed. |
| Nit | `tests/knowledge.test.ts` (new case) | The `(kind, slug)` positive case uses a synthetic message. Real-engine text is already covered by the race test above, so this is acceptable. |

No blocking or major findings.

## PR #336

### Verification

- **Descriptions against the code:**
  - `LABEL_SLUG_DOC` ("Lowercase kebab-case, unique per kind (a deleted label keeps its slug reserved); built-in labels cannot change it"):
    - `parseSlug` (`common.ts:102`) lowercases and enforces `TAXONOMY_SLUG_RE` kebab-case.
    - `assertSlugFree` (`labels.ts:158`) checks per kind, including soft-deleted rows.
    - `updateLabel` (`labels.ts:200`) rejects slug changes on built-ins with 400 `builtin_label`.
    - Accurate.
  - `LABEL_ALIASES_DOC` ("at most 10 strings of up to 60 characters; replaces the whole list"): `parseLabelInput` (`labels.ts:132-134`) enforces ≤10 entries and `safeText(…, 60)` per entry. The update writes `input.aliases ?? label.aliases`, so the list is replaced whole. Accurate.
  - The MCP handler (`mcp.ts:132-135`) passes `rest` through `parseLabelInput(rest, 'update')`, so the newly listed fields are really accepted.
- **Valid JSON Schema:** ajv 2020 (`validateSchema`) passed every one of the 28 taxonomy MCP tool input schemas. `label_update` props are now `id, expected_revision, slug, names, aliases, description, version, approve`. The compiled schema accepts `{slug, aliases:[…]}` and rejects `aliases: "x"`.
- **REST contract:** `/api/openapi.json` GET returns 200 `application/json`. All 136 `$ref`s resolve, and all 136 component schemas pass ajv `validateSchema`. A full spec diff, main vs ffbf066, shows only two added `description` strings on `TaxonomyLabelInput.slug` and `.aliases`. No type, required or path change.
- Scope: `labels.ts`, `mcp.ts`, `openapi.ts`, `tests/knowledge.test.ts` only.

### Findings

| Severity | File:line | Scenario |
| --- | --- | --- |
| Low | `src/lib/taxonomy/labels.ts:110` and `mcp.ts:61` | The doc comment says the constants are shared by "the MCP label tools", but `label_create` still lists bare `slug`/`aliases` with no descriptions. REST POST and PUT both show them, because they share `TaxonomyLabelInput`. This is an inconsistency, not a bug. A follow-up issue could reuse the constants in `label_create`; it should not widen this PR. |
| Nit | `src/lib/taxonomy/labels.ts:111` | `LABEL_SLUG_DOC` omits the 60-character max that `parseSlug` enforces (`common.ts:102`, `max = 60`). It also says "built-in labels cannot change it" inside the REST create body, where it does not apply. |

No blocking or major findings.

## Merge order

- `git merge-tree --write-tree 4d4e375 ffbf066` gives a clean tree (4eb1775), exit 0.
- `origin/main` + #333 is clean (856af27), and `origin/main` + #336 is clean (bfd4879).
- Both PRs touch `labels.ts` and `tests/knowledge.test.ts` in disjoint hunks: #333 changes the import and lines 155-170, #336 adds lines 110-113. A local merge of both auto-merged with no conflicts, and `knowledge.test.ts` passed (68/0).
- Either order works. The second PR will need its branch updated if branch protection requires up-to-date, but it will not conflict.

## Unresolved questions

- None blocking. Optional: open a follow-up issue so `label_create` reuses `LABEL_SLUG_DOC`/`LABEL_ALIASES_DOC`.

Status: DONE
Summary: #333 MERGE, #336 MERGE. All local gates green at both heads (2090/0 tests, build 0 errors/0 warnings), CI Test & Build passes on both, and the PRs merge cleanly in either order.
