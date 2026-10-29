# Review: PR #339 (Closes #338)

**PR:** fix(mcp): describe slug and aliases in the label_create input schema
**Head:** `0a770caf282d1cf75482846b39817232ff860741` (branch `fix/label-create-schema-descriptions`), one commit
**Reviewer:** isolated reviewer agent, which did not write this change
**Date:** 2026-10-25 (Asia/Saigon)

## Verdict: MERGE

The change is small and correct, and every claim matches the source. All gates pass. Nothing blocks the merge.

## Scope check

`git diff --stat origin/main...0a770ca` lists only the 3 files the author named:

- `src/lib/taxonomy/labels.ts` (+1 / -1): adds "of at most 60 characters" to `LABEL_SLUG_DOC`
- `src/lib/taxonomy/mcp.ts` (+1 / -1): `label_create` now uses `LABEL_SLUG_DOC` and `LABEL_ALIASES_DOC` for `slug` and `aliases`
- `tests/knowledge.test.ts` (+11 / -7): the schema-parity test now covers both `label_create` and `label_update`, and asserts the limit text in the REST schema

## Claims checked against the source

| Claim | Evidence | Result |
| --- | --- | --- |
| Slug limit is 60 | `parseSlug(field, value, max = 60)` in `src/lib/taxonomy/common.ts:102`. `parseLabelInput` calls it with the default (`labels.ts:129`). `safeText` rejects anything longer than `max`. The kebab-case rule is `TAXONOMY_SLUG_RE`. | Correct |
| Aliases: at most 10, each up to 60 characters | `labels.ts:132-133`: `body.aliases.length > 10` is rejected, and each alias goes through `safeText(..., 60)`. Unchanged text in `LABEL_ALIASES_DOC`. | Correct |
| MCP `label_create` accepts these fields | `mcp.ts:131`: `createLabel(d1, parseLabelInput(args, 'create'), ...)`. `parseLabelInput` reads `slug` and `aliases`, and `createLabel` writes both (`labels.ts:187-191`). | Correct |
| OpenAPI picks the change up automatically | `openapi.ts:6` imports `LABEL_SLUG_DOC` / `LABEL_ALIASES_DOC`, and `TaxonomyLabelInput` (`openapi.ts:152-153`) references them. I ran the `/api/openapi.json` GET handler directly: status 200, OpenAPI 3.1.0, 188 paths, and `TaxonomyLabelInput.slug.description` contains the new text. | Correct |

The updated test asserts `toEqual` between the MCP props and the REST props for both tools, so the MCP and REST descriptions cannot drift apart later.

## Findings

### Critical / High / Medium

None.

### Low (author's concern): "built-in labels cannot change it" in `label_create`

**Decision: not misleading enough to change in this PR. Leave it as is.**

Reasons:

1. **The clause is still true at create time.** `createLabel` rejects the built-in kinds `claim` and `freshness` (`labels.ts:181`, `builtin_kind`) and always inserts `builtin = 0`. So `label_create` can never make a built-in label, and the clause cannot mislead a caller into a failing request. At worst it is extra information that applies later, to `label_update`.
2. **REST already shows the same text on create.** `TaxonomyLabelInput` serves as the body for both POST and PUT through `crud('label', ..., 'TaxonomyLabelInput', ...)` (`openapi.ts:74`). The REST create endpoint has carried this wording since #336. The PR only makes MCP match REST, which is the stated goal of #338 and what the parity test enforces.
3. **A fix belongs in its own change.** Separate create and update wording would need two constants and a separate REST create schema, which touches the OpenAPI contract. That goes beyond #338. AGENTS.md says such follow-ups get their own issue rather than a wider PR.

**Optional follow-up (not required):** if you want create-specific wording, file a separate issue to split it into a shared base (`Lowercase kebab-case of at most 60 characters, unique per kind (a deleted label keeps its slug reserved)`) plus an update-only suffix. Apply the split to the REST POST/PUT bodies too, so parity holds.

### Nit (pre-existing, outside this PR)

`tag_create` / `tag_update` (`mcp.ts:51-52`) and `TopicTagInput` also have no field descriptions. That gap was there before this PR and is out of scope here. It is a candidate for its own issue if wanted.

## Gates (run one at a time in the foreground, in a temp worktree at the PR head)

| Gate | Result |
| --- | --- |
| `bun install --frozen-lockfile` | OK, 744 packages |
| `bun test tests/knowledge.test.ts` | 68 pass, 0 fail, 480 expects |
| `bun test` | 2122 pass, 0 fail, 118 files, 65270 expects |
| `bun run build` (`astro check && astro build`) | exit 0, 0 errors, 0 warnings, 80 hints, build Complete |
| OpenAPI handler smoke run | 200, valid 3.1.0 spec, label input schema carries the new descriptions |
| `gh pr checks 339` | Test & Build: pass (2m49s) |

## Unresolved questions

None blocking. Whether to add create-specific slug wording is optional and belongs in its own issue.
