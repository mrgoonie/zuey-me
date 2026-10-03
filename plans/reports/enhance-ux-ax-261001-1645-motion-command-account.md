# Motion, command palette, public activity and account preview

## Scope and DONE contract
Update the existing offline advisory HTML only. Preserve all accepted pricing/access/privacy requirements. No deployment or application backend changes. GSAP 3.15.0 embedded from the official npm distribution, retaining its license header; animate panel/dialog entrances, button micro interactions and bounded mascot motion. Reduced motion, typing, dragging, hidden tabs and page teardown must cancel owned motion without hiding content.

Add Cmd/Ctrl+K palette with filtered keyboard navigation, empty state and actions for chat, article search, OAuth MCP configuration, pricing, subscription and account. All actions close the palette, move to the correct surface and focus an appropriate control. Mobile has a visible trigger. Add a separate account page view with avatar upload, personal info, activity, subscription management and own chat sessions; local preview changes stay in memory and never claim server persistence or completed payment.

Add “Zuey đang làm gì” near the home profile using genuine public GitHub events from mrgoonie, whose identity is confirmed by `gh api user` (Duy /zuey/). Embed a dated sanitized snapshot so initial load stays offline; explicit refresh may call only the public Events API without credentials. Show date/event counts and public repository links. Heatmap counts events in the fetched window, not commits or the full contribution calendar. Loading, empty, rate-limit and network failures retain the last valid data. Production collection: server cache/ETag/backoff, public-only data, no browser token.

OAuth contract for proposed /mcp: OAuth 2.1 authorization-code + PKCE S256, protected resource metadata RFC9728 with authorization_servers, RFC8414/OIDC discovery, WWW-Authenticate discovery, exact redirect/state checks, resource/audience/issuer/expiry checks, narrow consent scopes, revocation and live entitlement checks per tool. Verified identity + server admin allowlist, never client-claimed email or scope alone. OAuth endpoints remain proposed until live interoperability tests pass.

Acceptance: existing 43 browser interactions pass; new keyboard palette actions, OAuth disclosure/copy, account info/avatar/session operations, graph day selection and real public API refresh/error fallback pass. Four widths 320/375/768/1440 have no page overflow/runtime errors; screenshots reviewed. Confirm no external HTTP on initial load; intentional API refresh reported separately. Syntax passes. Own browsers terminate. Independent bounded UX/AX critique required.

## Sources
- https://gsap.com/docs/v3/GSAP/
- https://registry.npmjs.org/gsap/-/gsap-3.15.0.tgz
- https://docs.github.com/en/rest/activity/events#list-public-events-for-a-user
- https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization

## Todo
- [x] Integrate motion and new surfaces.
- [x] Verify browser actions, live public API and error handling.
- [x] Review responsive screenshots and independent critique.

## Verification
- Direct headless Chrome/CDP: **82/82 pass**. The earlier 43 interactions remain passing. New checks cover actual Cmd/Ctrl+K, arrows/Enter/Escape, every palette action, accent-insensitive search/empty state, focus return, OAuth view and real Clipboard API + denied-permission fallback.
- Account: safe profile text, local real PNG avatar upload/decode/reset, private memory preference/reset, own sample chat search/read, actual .md download and local deletion, recorded preview activity, pricing from account and back navigation. No real user data or provider writes.
- GitHub: genuine dated sanitized snapshot, 84 dated event cells/day drilldown, explicit real public API refresh passes without credentials. Real browser offline network emulation proves refresh fails without replacing valid data. Initial/offline UI operations make zero HTTP requests; the separate refresh phase calls only the mrgoonie public Events API. API network evidence is in interaction-report.json, not counted as offline traffic.
- Found/fixed: palette pointer-trigger focus return; cached refresh hiding an offline failure (explicit refresh now cache:no-store); graph losing latest-day scroll while hidden on account resize (restores when homepage becomes visible); sorted events newest first; mobile locale menu alignment; 44px chart/link hit targets and a nonempty profile status.
- Four-width renderer 320/375/768/1440: **0 errors / 0 warnings**. New command/account/GitHub screenshots reviewed at mobile and desktop. Reduced-motion test confirms native dialog content remains visible with no GSAP entry tween. Actual autonomous mascot GSAP tween and cancellation on typing pass direct browser assertions. Embedded GSAP version 3.15.0 confirmed in browser; retained distribution license header, SHA256 of embedded runtime 92bb9a96476f983d212a2bc4f54c889039c1696dd4461d40a736860938570fbb.
- Runtime and harness node --check pass. Fresh application bun test: **21 pass / 0 fail**. Fresh bun run build: **0 errors / 0 warnings**, 2 existing informational FormEvent hints. Application source/endpoints unchanged; these tests do not prove live OAuth or new account backend.
- Full OAuth client interoperability, consent/revocation/token audience and live entitlement tests, /account persistence/tenant authorization, real billing portal, production video/weather, AI artifacts, CLI sprite generation and measured frame timing remain implementation acceptance gates. No benchmark smoothness or production launch claim from preview checks.
- Docs impact: minor, advisory artifact and own reports only. No evergreen production docs or contracts changed. Own headless Chrome profiles are closed/removed by finally; no dev server started.

## Independent review resolutions
Reviewer found two concrete issues: six of seven palette actions visible on mobile without a cue, and avatar wrapper retaining its initial accessible name. Added a live action count / scroll cue; upload/reset now update the wrapper name. Browser assertions verify both. Reviewed final mobile palette screenshot; native scrolling keeps the seventh action available and the close button reachable. Earlier latest-date graph scroll issue also verified after account navigation.

## Unresolved questions
No input needed for this preview. Live OAuth issuer/provider configuration, protected account persistence, production retention, checkout and sprite CLI/performance acceptance remain future implementation gates.
