# User interactive API docs and key management preview

## Scope and DONE before edits
Extend the accepted offline membership HTML only. Reuse existing account navigation and command palette; expose API docs and API keys directly from the main-page MCP area. Repo already owns Scalar /docs, /api/openapi.json, Studio keys and CLI; they do not yet establish per-member identity/entitlements. No production endpoint, authentication, billing or secret is issued/changed by this preview.

Deliver interactive user docs with endpoint selector, params/schema, REST/CLI/MCP examples, public placeholder-only copy, OpenAPI proposed export, explicit offline request simulator returning structured success/error examples. User chooses a hypothetical membership independently of their unchanged Free sample account. Scope and membership are both checked by simulator; anonymous/revoked/expired/missing-scope/insufficient-membership examples must never return paid content. Actual docs must eventually run real authenticated requests on the site's own origin with request cancellation, schema validation, visible side effects, sanitized errors and quota/request IDs; no real key in this file or logs.

Deliver own-user key list/create (name/scopes/expiry), one-time clearly nonfunctional specimen, hide-on-leave, masked list, last-use metadata, rotate and targeted revoke with confirmation/cancel. Rotation creates replacement while keeping old key until explicit revocation, explaining overlap. Key creation cannot grant admin or bypass membership. No localStorage, URL or analytics storage of specimen. Production contract: cryptographically random secret, hash-only storage, one-time reveal, session+CSRF protection for management, user ownership, least privilege, expiration, revoke/rotation, per-call current entitlements and rate/budget limits, secret-safe audit. OAuth remains preferred for remote MCP clients; supported direct clients can use scoped key through authorization header, never query strings. Shared REST/CLI/MCP policy.

## Todo
- [x] Add account views, shortcuts, docs simulator and key interactions.
- [x] Verify existing/new browser behavior and four viewport rendering.
- [x] Independent UX/AX critique and resolve material findings.

## Acceptance
Existing 99 checks preserved except action count intentionally grows by two. Test discovery/navigation/focus, docs request/schema/code/copy/export, anonymous and scope/plan denials, key create/reveal-once/hide-on-leave/rotate/revoke/cancel, subscription downgrade/revoked key denial, no external HTTP/no secret persistence and mobile layouts. Full bun test/build per repository; proposed contracts remain distinct from live integrations.

## Verification
Direct Chrome/CDP **140/140 pass** (previous 99 checks retained, command count intentionally seven → nine; 41 added developer checks). No runtime exceptions. Offline docs/key UI made zero HTTP requests; only the preserved explicitly triggered public GitHub refresh test made network requests. Verified actual clipboard and denied-clipboard fallback, actual proposed OpenAPI file download and parameter/request/error schema content, structured 401/403/422/429 examples, plan/scope conjunction, checkout not paying/granting access, metadata-only list, scope validation, one-time specimen destruction, targeted revoke/cancel/focus and rotate overlap, plus docs/key layouts at 320/375/768/1440. Expiration and cross-user isolation are implementation contracts, not a live backend acceptance claim.

Four viewport renderer: **0 errors / 0 warnings**; removed empty validation message layout track. Inspected 375px docs/key screenshots with native vision. Captures: `zuey-membership-ux-render-check/user-api-docs-*.png`, `user-api-keys-*.png`. Runtime and harness node syntax checks pass. Fresh **bun test: 21 pass / 0 fail**; **bun run build: 0 errors / 0 warnings**, two existing informational hints. Bun resolved from /Users/duynguyen/.bun/bin after absent shell PATH; no package installation.

One cancel-focus assertion originally queried before native dialog close dispatched; bounded wait now verifies the actual close handler, without changing its criterion. Fixed preserving original main-page opener across account cross-links. Code example changes clear old manual-copy data; request-input changes hide previous response. No key/specimen is persisted in localStorage, URL, analytics or reports. Prototype specimens cannot authenticate. Production credentials, member-scoped endpoints, live Try it and CLI/MCP interoperability remain unimplemented. Owned browser/profile cleaned and completed idle runners stopped.

Docs impact: minor; accepted preview and own reports only. Existing application routes, OpenAPI/Scalar and CLI left unchanged; their current Studio/admin authentication is not presented as subscriber-ready.

## Independent review resolutions
[Independent critique](ui-ux-designer-261001-1715-user-api-docs-review.md) found four bounded items. Resolved: per-key Rotate/Revoke accessible names include both name and stable key ID (browser assertion); checkout CLI now has required --provider polar (browser assertion); read schema matches Knowledges/Combo/Community entitlements; sandbox explains no expired-key fixture is provided and real-time expiry/cross-user isolation remain backend acceptance. No requested capability or business decision removed. Also aligned OpenAPI search response data array with the explorer, wrapped long key names, and verified request changes clear stale responses.

## Unresolved questions
No missing input for preview. Production user-key policy, real /docs authorization and CLI/MCP interoperability must be implemented and verified later.
