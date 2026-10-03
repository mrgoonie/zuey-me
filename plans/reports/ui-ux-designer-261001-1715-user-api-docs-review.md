# User API docs and keys: bounded UX/AX review

## Review basis

Read `README.md`, `enhance-ux-ax-261001-1715-user-api-docs-and-keys.md`, the stripped source, current runtime in `plans/visuals/explain-zuey-membership.html`, the interaction report, and `user-api-docs-{320,375,768,1440}.png` plus `user-api-keys-{320,375,768,1440}.png`.

The current evidence is strong for the offline boundary: **138/138 browser checks pass**, four viewport renders report **0 errors / 0 warnings**, and the checks cover actual clipboard, denied-clipboard fallback, one-time specimen destruction, targeted revoke/cancel/focus, rotate overlap, structured sandbox responses, export download, no secret persistence, and no unintended HTTP. I found no issue requiring a scope or business decision reversal.

## Ranked findings

### P1 — Key action buttons are ambiguous to assistive technology

`renderDemoKeys()` creates every action with the same accessible name, `Rotate` or `Thu hồi`, without an `aria-label`, `aria-labelledby`, or an action name that includes the key. With multiple cards, a screen-reader user tabbing through the list cannot tell which key will be changed; the visual proximity shown in the mobile captures does not provide equivalent context. This is in `plans/visuals/explain-zuey-membership.html:439`.

Give each button a unique accessible name, for example `Rotate key Laptop` / `Thu hồi key Laptop`, or point `aria-labelledby` at the card heading plus an action-specific hidden label. Keep the exact-key confirmation already present as the second safety boundary.

### P1 — Checkout CLI example omits a required request field

The checkout schema and generated REST/MCP examples require `provider`, but `apiExamples()` generates only `zuey subscription checkout '…' --locale vi`. A reader copying the proposed CLI contract cannot construct the request represented by the other examples. The mismatch is in `plans/visuals/explain-zuey-membership.html:453`, against the checkout body requirement at `:478`.

Add an explicit `--provider polar` (or the documented environment/config equivalent) to the checkout CLI specimen, and keep the copy marked proposed/offline as it is now.

### P2 — Article-read access copy disagrees with the simulator

The read operation schema says `full content chỉ khi có Knowledges`, while its description and evaluator grant full sample content to Knowledges, Kết hợp, or Cộng đồng (`:427`, `:463`, `:466`). This makes the schema panel suggest a narrower entitlement than the actual demo and weakens the shared API/CLI/MCP policy explanation.

Use one qualifying-plan phrase in the schema, description, and response copy. Preserve the current conjunction checks and the explicit sample-only wording.

### P2 — Expired-key denial is not exercisable in the preview

`keyState()` handles `expired`, but creation only offers 30/90/365 future days and there is no expired fixture or preview time control. The current report correctly treats expiry and cross-user isolation as production contracts, so this is not a production blocker. If the preview is intended to demonstrate every listed credential error, add a clearly labelled nonfunctional expired fixture/time simulation; otherwise state beside the sandbox error examples that expired-key behavior is contract-only in this offline preview.

## Verified dispositions

- Key specimens are literal noncredentials, clear on section leave/page hide/dismiss, absent from the masked list and exports, and never persisted by the preview.
- Scope allowlisting, current simulated membership checks, revoked-key denial, quota errors, checkout no-payment/no-entitlement, replacement overlap, targeted revoke, and dialog focus/cancel behavior are covered by the current browser evidence.
- The mobile captures at 320/375px keep controls usable and wrap the developer grids; tablet/desktop captures remain readable. The current renderer reports no overflow warnings.
- Proposed OpenAPI export now models search success data as an array and declares path/request/error schemas; the remaining CLI and read-copy mismatches above are documentation-contract issues only.

## Status

**Status:** DONE_WITH_CONCERNS

**Summary:** Offline user API docs and key management preview meets the tested interaction, mobile, focus, and secret-boundary acceptance. Four bounded follow-ups remain: unique per-key action names, complete checkout CLI specimen, aligned read entitlement copy, and an explicit decision on whether expired-key behavior is demonstrable in this preview.

**Concerns/Blockers:** No blocker to the offline preview. Real authentication, member-scoped endpoints, cross-user isolation, expiry enforcement, and CLI/MCP interoperability remain production acceptance work as already stated by the owning report.
