# Review: PR #342 — fix(mcp): describe slug, names and aliases in the tag tool input schemas

- Closes #341. Head `0ab7f7d08b7b5191f014bbe0ab6bcd071cc7d5ba` (`fix/tag-mcp-descriptions`), single commit.
- Reviewed in an isolated read-only worktree (`%TEMP%\rv342`); the reviewer did not write this code.

## Verdict: MERGE

No blocking or medium findings. One low wording nuance and two nits, none of which need to hold the merge.

## Scope

`git diff --stat origin/main...HEAD` lists exactly the 4 files the author named:
`src/lib/taxonomy/mcp.ts`, `src/lib/taxonomy/openapi.ts`, `src/lib/taxonomy/tags.ts`, `tests/knowledge.test.ts` (+48 / -7).

## Gates

| Gate | Result |
| --- | --- |
| `bun test tests/knowledge.test.ts` | 69 pass, 0 fail |
| `bun test` | 2127 pass, 0 fail (118 files) |
| `bun run build` | astro check 0 errors, 0 warnings (80 hints, all from existing code); build Complete |
| `gh pr checks 342` | Test & Build: pass |

## Descriptions compared with the parser

The parser is `parseTagInput` in `src/lib/taxonomy/tags.ts`, plus `parseSlug`, `safeText` and `parseNamesInput` in `src/lib/taxonomy/common.ts`.

- **Slug, "lowercase kebab-case of at most 60 characters".** Correct. `parseSlug` trims, checks the length (60) before lowercasing, then tests against `TAXONOMY_SLUG_RE` (letters from any script, digits, single hyphens). Mixed-case input is accepted and lowercased, which fits "lowercase" as a description of the stored value.
- **Slug, "derived from the first name when omitted on create".** Correct. On create it falls back to `slugify(Object.values(names).find(Boolean))`, which is the first name in the order given. `slugify` also caps at 60.
- **Slug, "unique across tags (a deleted tag keeps its slug reserved)".** Correct for update: `slugOwner` counts soft-deleted rows, which the test at `knowledge.test.ts:879` covers. See L1 for create.
- **Names.** Correct on every point:
  - At least one name: `parseNamesInput` rejects an empty result.
  - Allowed locales are `en, vi, zh, ko, ja`, from `LOCALES`; unknown keys are rejected.
  - Each name is up to 40 characters (`TAG_LIMITS.nameLength`).
  - "Replaces the whole object": `updateTag` uses `input.names ?? tag.names`, with no merge.
- **Aliases.** Correct on every point:
  - At most 10 entries (`TAG_LIMITS.aliases`), and each must be a string of up to 40 characters (`safeText(..., nameLength)`).
  - "Duplicates collapse": the parser dedupes on `normalizeKey`, so matching ignores case and diacritics.
  - "Replaces the whole list": `input.aliases ?? tag.aliases`.

## `TAG_LIMITS.slugLength` changes no behaviour

`parseSlug(field, value, max = 60)` already defaulted to 60, so passing `TAG_LIMITS.slugLength` (60) gives the same result. No other caller of `parseSlug` changed. `slugify`'s hard-coded `.slice(0, 60)` matches the limit.

## REST `maxLength` change only affects the docs

- No code validates requests against the OpenAPI schema. No source file references `TopicTagInput` outside `openapi.ts`, and no AJV or other schema validator is wired to the REST routes. (`ajv` sits in `node_modules` only as a transitive dependency.)
- `POST /api/v1/taxonomy/tags` and `PUT /api/v1/taxonomy/tags/[id]` validate through `parseTagInput`, which the PR did not change, so request validation is unchanged for every client.
- The old `names.*.maxLength: 60` was wrong: the parser has always rejected names over 40 characters. The new value of 40 matches what the server enforces. The shared `names` constant is untouched, so the Category schema keeps its own limit of 60.

## MCP handlers

- `tag_create` calls `parseTagInput(args, 'create')` and `tag_update` calls `parseTagInput(args, 'update')`. This is the same parser as REST, so the MCP tools accept exactly what the descriptions say.
- `parseTagInput` only reads `names`, `slug` and `aliases`, so the extra `id` and `expected_revision` arguments on `tag_update` are ignored.
- `required` stays `['names']` for create and `['id', 'expected_revision']` for update.
- Sharing `tagFieldProps` between the two tools removes the old duplicated inline schemas.

## `/api/openapi.json`

- I called the route's `GET` on both the PR head and `origin/main`. Both return `200 application/json` with `openapi: 3.1.0` and 188 paths.
- In the head spec, all 136 `$ref`s resolve.
- A semantic diff against main shows changes only in `components.schemas.TopicTagInput`:
  - `names.description`: replaced with the full contract text.
  - `names.properties.{en,vi,zh,ko,ja}.maxLength`: 60 → 40.
  - `slug`: added `maxLength: 60` and a description.
  - `aliases`: added a description. Its `maxItems: 10` and `items.maxLength: 40` were already correct and are now built from `TAG_LIMITS`.

## Type safety

- None of the changed files contain `: any`, `as any`, or an unchecked inline cast.
- The new test reads schemas through the existing `rec()` guard helper.
- `LOCALES` is imported as a value, which is correct because it is used at runtime.

## Findings

### Low

- **L1. "A deleted tag keeps its slug reserved" overstates what happens on create.**
  - On update, renaming onto a soft-deleted tag's slug is `409 tag_conflict`, as the description says.
  - On create, `writeTagRow` (`tags.ts` around line 140) finds the soft-deleted row and restores it under its old id with the new names and aliases. The create succeeds rather than conflicting, because `assertNoCollision` only scans live tags.
  - An agent reading "reserved" may expect a 409 and not realise it is reviving the old tag.
  - Suggested wording: "...unique across tags; a deleted tag keeps its slug, so renaming onto it conflicts and creating with it restores that tag".
  - This is a documentation nuance and needs no code change. It can be a follow-up issue.

### Nits

- **N1.** The descriptions do not mention the forbidden characters (`< > { } \` \\` and control characters, from `safeText`). The parser's 400 message explains them, so this is optional.
- **N2.** Length limits use JS `.length` (UTF-16 code units), while JSON Schema `maxLength` counts code points. Names that use astral-plane characters, such as emoji, can be rejected slightly below the documented 40. This behaviour predates the PR and applies to every taxonomy field, so it is not this PR's concern.

## Test review

The new test at `knowledge.test.ts:740`:

- Pins the three REST descriptions.
- Checks that both MCP tools carry the identical text for each field.
- Exercises the parser at each boundary: a 60-character slug, a 40-character name and 10 aliases of 40 characters pass; a 61-character slug, a 41-character name, 11 aliases and a 41-character alias each throw `AppError`.

It is focused and does not weaken any existing assertion.

## Round 2 (coordinator check)

Head 6e1789f differs from the reviewed head 0ab7f7d only in the TAG_SLUG_DOC string (src/lib/taxonomy/tags.ts, 1 line), which now states that create restores a deleted tag and rename onto its slug conflicts. That fixes L1. The author reran the gates: knowledge.test.ts 69/0, bun test 2127/0, build 0 errors and 0 warnings. Verdict stays MERGE.
