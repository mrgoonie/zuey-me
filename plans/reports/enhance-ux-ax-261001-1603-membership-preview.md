# UX/AX preview update — Zuey membership

## Scope and environment
User explicitly requested edits to `plans/visuals/explain-zuey-membership.html`; implementation applies only to this offline advisory artifact and its own assets/reports. No application routes, deployed data, Dewee configuration or real MCP tools are changed. macOS, Node, local headless Chrome, Asia/Saigon. Existing ivory/serif brand and previously chosen membership prices/access retained.

## Baseline evidence
Prior rendered baseline: `zuey-membership-preview-render-check/375x812.png`, `768x1024.png`, `1440x900.png`, `desktop-home.png`, `mobile-ai.png`. Prior report found 0 errors and 0 warnings, but user feedback identifies experience gaps: permanent dense filters, language/access dropdowns, no thumbnails, boxed static character, missing announcement/admin-session/policy surfaces.

## Ranked proposals
1. Must — Progressive disclosure for knowledge tools. One compact search/filter trigger; expanded search, category, sort, applied-filter summary, clear/reset and useful empty states. Remove local language/access selects. Verify collapsed default and filter/reset actions.
2. Must — Shared page language and per-row entitlement. One page locale controller; each article has a branded thumbnail, category/read-time and accessible locked/unlocked icon. Verify all five locales, row state and no conflicting controls.
3. Must — Cutout sprite companion. Embed actual generated 4x4 atlas with alpha. Roam within viewport, drag by pointer, interact by keyboard, express states, overhead bubble. Pause/hide/restore, reduced motion and focus/input avoidance. Verify atlas cells, movement bounds, drag, controls and pointer pass-through outside silhouette.
4. Must — Distinct announcement channel. Preview event with admin identity badge, expression, start/expiry, visitor dismissal and no resurfacing of dismissed event. Never present the preview as a live MCP event. Verify TTL, dismissal, expression and separation from ambient bubbles.
5. Must — Honest privacy policy and admin access. Clear service-only purpose, no sale/advertising/unapproved training, processor limits, private per-user storage, memory controls, retention disclosure, limited audited admin session query. Include proposed admin MCP session/stat/query and announcement tool contracts. Verify no claim that admin cannot see messages.
6. Should — Trust copy near chat; clear interaction hints, compact disclosure of stored sessions and admin access, privacy dialog with keyboard/focus behavior. Verify mobile focus and dialog close/restore.

## DONE contract (defined before edits)
- Every Must and Should above is represented by a working preview interaction or an explicitly proposed backend contract; real services stay labelled unimplemented.
- Original article/paywall/price/editor/multilingual requirements remain present.
- Offline file renders at 1440×900, 768×1024, 375×812 and reflows at 320px without broken images, page overflow, unreadable controls or high visual issues.
- Pointer, keyboard, Escape/focus return and reduced-motion behavior pass for changed controls; autonomous motion can be paused.
- Only public sample article data is exposed in public sharing/copy examples; no real private chat data, secrets or production identifiers in preview.
- Existing previews stay self-contained: no external HTTP requests. Generated source asset copied into workspace and embedded for offline use.
- Discovery scan is reported truthfully: this file is a non-production, noindex advisory artifact without HTTP routes/sitemap/Markdown twins, so deployed-site discovery and CWV are not passes. Inspect public-contract text instead; no unrelated production SEO changes.
- Relevant HTML/JS syntax, renderer and interaction checks pass. Application test/build results, if run, reported separately and not substituted for preview checks.
- Own browser/test processes stop. DESIGN/REVIEW/AGENTS product documentation unchanged because user scope is the preview; report preserves the artifact's design and constraints.

## User additions during work
- Editor and reader support YouTube, SoundCloud, Vimeo, Spotify, X, Facebook, Instagram, TikTok and LinkedIn embeds; URL recognition, preview, captions, responsive/lazy loading, opt-in provider load and fallback documented.
- Weather scenario interaction changes background treatment and mascot expression; production route opts into coarse location/manual city. Preview has no live weather API, location request or video media.
- Enterprise section placed after membership matrix: one-off consultation $1,999; all $1,999 credited against separately scoped 3–6 month engagement. Read linked source via direct HTTP after web tool internal error; used its assessment/foundation/build/handover structure. Source-specific customer, team size, quoted fees and achievement claims not reused as generic marketing.
- Added verification: weather state/expression, exact enterprise price/credit and provider inventory.

## Verification
Application `bun test`: 21 pass / 0 fail. `bun run build`: 0 Astro errors / 0 warnings, 2 informational hints. HTML runtime extracted and `node --check` passed. Preview interaction checks: **28/28 pass**, zero runtime exceptions and zero external HTTP requests. Renderer: **0 errors / 0 warnings** at 320×812, 375×812, 768×1024 and 1440×900. Report: `zuey-membership-ux-render-check/render-report.json`; interaction evidence: `zuey-membership-ux-render-check/interaction-report.json`.

Reviewed screenshots: branded compact list at 375/320; AI composer, mascot bubble and controls; desktop enterprise, mobile enterprise and weather. Generated alpha atlas: 1254×1254 RGBA, four rows × four frames; browser displays one cell with CSS background positioning, flips walk direction. Sprite alpha edge quality is prototype art, not certified production sprite QA. Motion and bubbles clamp to the viewport, with 16px margin plus controls. Pause/hide restore and reduced motion verified. Incoming announcement waits during typing. TTL expires; dismissed event does not replay on restore. No geolocation/weather/provider requests in this offline artifact.

Discovery scanner cannot evaluate `file://` (HTTP URL required); not counted as a pass. Artifact carries `noindex,nofollow`; published-site SEO/GEO, route/auth/paywall/provider interoperability remain future implementation checks. No application source or deployed server changed. Docs impact: **minor**, preview and own report only; no evergreen product claims changed. No background service started; every owned headless browser closed in harness `finally`.

## Final review resolutions
Independent UX/AX critique found the fixed restore control covering content. Replaced it with an inline restore button placed beside visible reading content when the mascot is hidden; latest business/weather captures have no fixed restore overlay. Shared root language now follows VI/EN/ZH/KO/JA, while static advisory/policy text is explicitly Vietnamese and greeting/article titles retain their own language. Reader activation hands focus to the heading. MCP disclosure and panel controls expose `aria-controls`. Added focused assertions; latest 28/28 pass and four-width render remains 0 errors / 0 warnings. Reviewer report: `ui-ux-designer-261001-1603-membership-preview-review.md`.

## Additional verification requirements — 2026-10-01
User requested additions to the verification contract, not a claim that live integrations are complete.
- Direct browser acceptance: expected/actual for every user/admin flow, all tiers/locales/devices, keyboard/touch/reduced motion, reload/error/offline. Record steps, environment, screenshot/video, console/network and pass/fail/blocked; rerun after fixes.
- Sprite generation must use `codex` CLI, with command/prompt/output/frame manifest evidence. Current native image-generation prototype does not satisfy CLI provenance; CLI generation remains pending for implementation.
- Sprite acceptance includes consistent cells/scale/pivot/baseline/order, all requested action cycles and transitions, direction/drag/click/weather/notice changes, resize/rotate/scroll, preload/decode, pause/hide/restore/reduced motion and measured browser frame timing/resource stability. No smoothness claim from screenshots alone.
- Interactive code blocks can be generated, rendered and revised inside the Zuey AI panel; article blocks use the same renderer/schema. AI subscribers create private chat artifacts; admin attaches draft and approves publish. Browser acceptance verifies generation/render/edit/retry/cancel, article-panel parity, sandbox/proxy isolation and entitlements. Real generation remains an implementation requirement.
- Updated the HTML editor explanation and section 07; no application source, backend, CLI image-generation job or production state changed. Reran direct headless Chrome/CDP preview interactions: 28/28 pass, no runtime exceptions or external HTTP requests. Updated four-width rendering: 0 errors / 0 warnings. Full product browser acceptance, CLI provenance, measured sprite smoothness and live AI block generation are pending requirements, not these smoke-test results.

## Pricing and sharing addition
Pricing modal and article share/Markdown/AI menu added to the same artifact. Full scope and verification in `enhance-ux-ax-261001-1627-pricing-and-article-sharing.md`; newest browser checks 43/43 pass. `.md` route is a proposed server contract, while literal Markdown preview and clipboard export work offline. No production backend change.

## Motion, command, activity and account addition
Added embedded GSAP transitions/micro interactions/mascot movement, Cmd/Ctrl+K action palette, public GitHub events graph for verified mrgoonie identity, proposed OAuth /mcp configuration and a distinct account preview view. Avatar/info/activity/subscription/own-chat actions stay clearly local demo; GitHub refresh uses actual public API on explicit click. Final 82/82 browser checks pass; four viewport renderer 0 errors/0 warnings. Two independent accessibility findings fixed and verified. Full scope, sources and live-pending boundaries: [motion-command-account report](enhance-ux-ax-261001-1645-motion-command-account.md).

## Taxonomy and AI-assisted audit addition
Added typed classification facets, collapsed label filters, local proposal/interview/diff/approval preview and proposed shared API/MCP taxonomy, bulk audit and revision-safe approval contracts. Fact and outdated remain independent; evidence classification is locale/revision-specific. Final browser checks **99/99 pass**; four-width render **0 errors / 0 warnings**. Both independent review findings resolved. Actual AI source verification, corpus audit and production API/MCP remain implementation requirements. Details: [taxonomy and audit report](enhance-ux-ax-261001-1655-article-taxonomy-and-audit.md).

## User API docs and keys addition
Added account API docs/API keys views with main MCP-area and command shortcuts. Docs offer endpoint/schema/REST-CLI-MCP examples, placeholder clipboard, proposed OpenAPI download and explicit offline authorization/plan/quota response evaluator. Key preview includes scopes/expiry metadata, one-time noncredential specimen, rotate overlap, targeted revoke/cancel and own-user security contract. Independent critique resolved; **140/140 browser checks**, four-width renderer **0 errors / 0 warnings**, application **21 tests pass** and build **0 errors / 0 warnings** (two existing hints). Production user-key authentication, real Try it and CLI/MCP interoperability remain pending. Details: [user API docs and keys report](enhance-ux-ax-261001-1715-user-api-docs-and-keys.md).

## Public tags addition
Added public topic badges to list/detail, admin-demo tag attachment/edit, duplicate and unsafe-input validation, public Markdown metadata and shared editor/API/MCP requirements. Tags are independent of evidence labels and never grant full read rights. Final browser **145/145 pass**, renderer **0 errors / 0 warnings**, fresh application tests/build pass. [Public tags report](enhance-ux-ax-261001-1720-public-article-tags.md); implementation continuation: [handoff](../handoffs/zuey-membership-implementation-20261001-1730.md).

## Unresolved questions
Production chat retention duration and external processor retention/training settings must be verified/configured before making the policy a live guarantee. Preview will disclose these as launch prerequisites instead of inventing compliance.
