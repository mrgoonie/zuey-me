# Pricing and article sharing preview

## Scope / DONE contract before verification
Same offline `plans/visuals/explain-zuey-membership.html`; application/backend unchanged. Pricing dialog opened from profile, AI price, knowledge subscription and paywall, preserves monthly $9/$9/$19/$29 and existing entitlements. Plan selection shows next-step/provider description, never grants paid access.

Article toolbar opens an accessible share dialog: native share or copy fallback, article URL, access-aware copy Markdown, Markdown URL, plain Markdown preview and ChatGPT/Claude/Gemini links. URL examples are proposed product routes, not live endpoints. Provider links use official home pages, no invented prefill contract: copy public-URL prompt, open provider, user pastes. No message is sent automatically. Copy full sample Markdown only for Knowledge entitlement; share/native/send payloads contain public canonical URLs only. No credential or private chat in links/prompts. `.md` backend contract: only text/markdown, same locale/revision/auth as reader, media/embed/interactive link fallback, protected caching and no protected public indexing.

Accept: dialogs close via button/Escape and return focus; prices/benefits unchanged; selection leaves membership unchanged; Markdown preview is literal text, public export excludes paid sample, member includes authorized sample; URLs contain no token; Clipboard API or visible selected manual fallback; AI destinations correct and prompt only references public URL; mobile layout/touch/keyboard pass; existing 28 interactions stay passing; four viewport renders stay clean. Assets and noindex unchanged. Native share clipboard and provider behavior tested honestly, not called a live backend pass.

## Verification
- Direct Chrome/CDP browser interactions: **43/43 pass**, zero runtime exceptions and external HTTP requests in the preview test.
- Exercised real Clipboard API: public Markdown excludes full sample, Knowledge export includes authorized full sample, Markdown URL ends in `.md` without query/token. Browser permission denial produces a visible, selected manual-copy textarea; no Clipboard API mock.
- Tested plan choices $9/$9/$19/$29 without changing reading entitlement; pricing/share Escape, opener focus, inline restore, existing 28 interactions, mobile dialogs at 320/375. Latest modal screenshots in `zuey-membership-ux-render-check/`.
- Main preview rendering four widths: **0 errors / 0 warnings**. Dialog screenshots manually inspected; sticky heading and scroll reset keep close reachable in the long mobile pricing view. Inline runtime `node --check` passed.
- AI provider hrefs checked and copy handler tested with public-only prompt; external navigation prevented by test-only event listener. No actual AI message submitted. Native OS share picker is not exercised by headless Chrome; real-device native sheet remains a production acceptance check. Provider home pages verified via official ChatGPT/Claude/Gemini URLs; no unsupported deep-link/prefill claim.
- Application source unchanged; earlier application test/build evidence remains separate. No backend `.md` endpoint or checkout deployment is claimed. Independent bounded UX/AX critique found no concrete pricing/share defects. The flagged clipboard-denial check is now verified by the final 43/43 run. Native OS share remains explicitly unverified, not a preview blocker.

## Unresolved questions
Production `.md` routes, server-side export serializer, checkout/provider credentials and real MCP entitlement tests still pending implementation. Existing spritesheet CLI provenance/performance acceptance remains pending; no claim of new image generation.
