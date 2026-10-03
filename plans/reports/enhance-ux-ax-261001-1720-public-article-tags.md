# Public article tags addition

## Scope / acceptance
User addition during commit/handoff packaging: articles can carry public tags. Update accepted offline preview and handoff, then include in requested commit/push. No production endpoints or article data changed. Tags are public topic metadata, separate from claim evidence/fact/freshness; all readers see tags on lists/detail, and Markdown/API/MCP expose only approved published metadata under the existing access policy.

Added sample badges for 15 multilingual article rows, reader badges, an explicit admin-demo tag editor with duplicate/count/length/character checks and safe text nodes. Search matches displayed tags; edits apply VI sample, do not grant membership or reveal full content. API/MCP shared tag schema/admin revision/audit/public metadata/index constraints documented. Empty selection removes all tags; unknown taxonomy evidence does not become a topic tag automatically.

## Verification
Fresh final browser: **145/145 pass**, no runtime exceptions. Five added checks cover free public list/reader tags, safe duplicate-eliminating edit, search with unchanged entitlement, rejected unsafe markup, public tags in preview-only Markdown. Four viewport renderer: **0 errors / 0 warnings**; complete application runtime and harness syntax checks pass. Fresh **bun test: 21 pass / 0 fail**, **bun run build: 0 errors / 0 warnings**, two existing hints. These are not live backend acceptance. Self-review verified badges stay inside the existing article hit target (no nested buttons), text-node insertion and VI-only updates. Browser helper capture removed; owned browser/profile and completed check runners cleaned.

## Unresolved questions
None for preview/handoff. Actual tag persistence/editor/REST/MCP/indexing belongs to the implementation described in the handoff.
