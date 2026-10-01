# Membership preview UX/AX review — 2026-10-01

## Verdict

The preview already has a recognizable editorial direction: warm paper surfaces, serif headings, a centered profile, and a clear Vietnamese promise. The highest-risk gaps are trust disclosure and the requested roaming character/filter redesign: the current UI does not explain restricted audited admin chat access, hides the character at tablet widths, and exposes five dense controls in the knowledge panel.

The recommendations below are for the offline HTML preview only. Keep the accepted prices, access matrix, five-locale/manual-editing model, and the repeated `Preview giả định`/hypothetical labeling.

## Scope and environment

- Artifact: `plans/visuals/explain-zuey-membership.html` (offline, no server or external requests).
- Evidence reviewed: `375x812.png`, `768x1024.png`, `1440x900.png`, `desktop-home.png`, `mobile-ai.png` under `plans/reports/zuey-membership-preview-render-check/`.
- Baseline reports: `render-report.json` reports no overflow/clipping findings; `interaction-report.json` passes paywall, slider, search-empty, category, mobile navigation, MCP explanation, and zero-network checks.
- Source review: HTML/CSS/JS lines 1–181; image data URIs were redacted while reading. The file is 2,143,106 bytes and contains two duplicated inline images of about 1,044,866 bytes each.
- Discovery scan: not run. This is an offline artifact with no site origin, sitemap, or crawlable route in scope; the preview itself must retain its explicit offline/live status.

## Baseline scores

| Area | Score | Evidence |
|---|---:|---|
| First impression | 2/3 | The 375×812 and 1440×900 captures expose the outcome headline and the `Preview giả định` banner immediately; the mobile first view is already dense. |
| Brand recall | 2/3 | Warm paper palette, Georgia headings, `/zuey/`, and the character/portrait repeat across `desktop-home.png`; the current character is a rectangular source image rather than a distinctive cutout animation. |
| Content punch | 2/3 | `Một nơi để đọc, hỏi và kết nối với Zuey.` is concrete; the subhead combines membership, Knowledges, AI, community, identity, MCP, and payment state in one paragraph (HTML:11). |
| Clarity and hierarchy | 2/3 | Numbered sections and three-panel shell are easy to scan on desktop; five controls compete inside the knowledge panel (HTML:17). |
| Storytelling | 2/3 | Profile → article → access → operations → architecture is a coherent proposal sequence; the admin/privacy scenario is absent. |
| Knowledge and trust | 1/3 | The preview/hypothetical caveat is good (HTML:11, diagram subtitle around HTML:27), but current copy only says memory can be disabled/deleted and that `manage_*` is admin-only (HTML:15–16). It does not state service-only personal-data use or restricted audited admin access. |
| Motion | 1/3 | Current motion is hover-only `nod`; the character is hidden on tablet and at `max-width:1080px` (CSS:5–8), and there is no sprite state, drag affordance, pause/mute, or overhead bubble. Reduced motion is globally disabled correctly but has no explicit static character state. |
| Responsive | 2/3 | Baseline render reports no overflow and the 375/768/1440 captures reflow; the 768 layout hides the character, and the mobile/tablet control cluster plus horizontally scrollable pricing table add friction. |
| Accessibility | 1/3 | Controls meet the 44px token and have focus-visible styling (CSS:3), but mobile panel toggles lack `aria-controls`/tab semantics, `mcp-example` has no `aria-expanded`, and the requested drag/roam interaction needs a keyboard equivalent. |
| Performance feel | 1/3 | Offline screenshot render works, but the 2.14MB document duplicates a ~1.04MB image twice and also embeds a large architecture SVG; no real LCP/INP/CLS measurement is available for this artifact. |

## Ranked proposals

### P1 — Make the privacy and admin-MCP boundary explicit (Must)

- Evidence: Knowledge/trust is 1/3. The AI panel says `Bộ nhớ riêng của bạn có thể tắt hoặc xoá` but does not describe service-only personal-data use or the admin access boundary (HTML:15). The profile MCP copy ends at `manage_* dành cho admin` (HTML:16).
- Change: Add a non-blocking admin-MCP announcement near the character/MCP connection. It should state: personal data is used only to provide the requested service; admin access to chat sessions is restricted, audited, and used for operations/safety; this is not a promise that admins can never read chats. Show preview-only status and the three requested capabilities in plain language: list all chat sessions, view aggregate statistics, and query sessions. Keep real data/API clearly absent.
- Interaction: Give the announcement an expression/state (for example `admin notice`), an explicit TTL label, a dismiss button, and a persistent accessible way to reopen the notice. Auto-hide must never be the only place the privacy boundary appears. Use `role="status"` or an appropriate live region without stealing focus; restore focus after dismiss/reopen.
- Files: `plans/visuals/explain-zuey-membership.html` only.
- Acceptance: At 375, 768, and 1440 the notice is readable, does not cover the reader/search controls, and is dismissible by mouse, keyboard, and Escape if implemented as a popover. The copy includes all three policy points and says `preview/offline`, `no real sessions`, and `no external API`. Screenshot the visible and dismissed states; verify the TTL does not remove the only durable policy text.

### P2 — Replace the dense filter row with progressive disclosure and shared locale (Must)

- Evidence: HTML:17 renders search plus category, sort, locale, and read-rights selects together. At mobile this panel is already a long vertical card; `filterPosts()` still reads `locale` and `access` (HTML:176–177). The user explicitly requires compact search/sort/category, no local language dropdown, and per-article rights icons.
- Change: Keep search visible. Put only category and sort behind a labeled disclosure (`button` + `aria-expanded`/`aria-controls`, or native `details`). Remove `#locale` and `#access` from the local filter state. Read the shared page language (`document.documentElement.lang` or one preview state value) and display it as a noninteractive badge; keep the five-locale availability/manual-editing note in the content. Add a per-article lock/open icon with text and an accessible label that maps to the existing Free/AI-only versus Knowledges/combined/community access decisions.
- Files: `plans/visuals/explain-zuey-membership.html` only.
- Acceptance: Initial mobile view exposes search plus one filter/disclosure control; category/sort remain keyboard reachable after expansion; no language or read-rights dropdown exists; changing the shared page language updates the visible article metadata without a second locale state; rights icons have text/labels and do not rely on color; empty state still works after search/category/sort.

### P3 — Implement the sprite character as a bounded, accessible layer (Must)

- Evidence: Current character is one full rectangular image inside a button and only changes a text bubble on click (HTML:15, 173). CSS applies hover-only `nod` and hides `.character` for tablet/≤1080px (CSS:5–8). The baseline `mobile-ai.png` shows the large image consuming most of the AI panel, while the 768 capture has no character at all.
- Change: Use the supplied actual spritesheet for idle/talk/notice expressions. Place the character in a bounded layer inside the preview shell so it can roam within the active panel/shell without covering headings, inputs, article cards, or the viewport. Keep the bubble anchored overhead with a collision-safe fallback below/aside. Make the character clickable and draggable with pointer events; add a keyboard path (focus, arrow keys or explicit move controls, and reset) that does not require dragging. Do not rely on hover for state changes.
- Accessibility and motion: Give the character a meaningful accessible name and current expression/status, keep the bubble text in a live region with sensible politeness, expose pause/mute where automatic speech-like motion exists, and freeze on a stable frame under `prefers-reduced-motion`. Use a static fallback if the sprite fails.
- Files: `plans/visuals/explain-zuey-membership.html` only; sprite asset supplied by the root agent.
- Acceptance: Screenshots at 375×812, 768×1024, 1440×900, and a 320px reflow show the character and bubble inside bounds with no obstruction or overlap. Mouse/touch drag, click, keyboard movement, reset, focus-visible, reduced-motion, and dismiss/reopen states are manually verified. Tablet retains a compact character state instead of hiding it.

### P4 — Add consistent branded article thumbnails and rights metadata (Should)

- Evidence: Current cards contain only a small metadata line and text button (HTML:17); `desktop-home.png` confirms there is no thumbnail or per-card access affordance. The card list uses a 20px serif title but no stable visual anchor.
- Change: Add a fixed-ratio thumbnail slot to every article card using a consistent Zuey treatment (real article asset when available; otherwise a clearly labeled branded placeholder). Keep aspect ratio, crop, and loading dimensions stable. Pair the thumbnail with the per-article lock/open icon and a short text label such as `Preview ~1/3` or `Đọc toàn bài với Knowledges`; preserve the current pricing/access table unchanged.
- Performance: Do not duplicate the current ~1MB inline image for each card or sprite frame. Use one optimized, self-contained asset/reference where the offline constraint requires embedding, with explicit dimensions and meaningful alt text.
- Files: `plans/visuals/explain-zuey-membership.html` only.
- Acceptance: Every card has the same thumbnail ratio and no layout shift; icons/labels remain legible at 375 and 768; keyboard focus covers the whole read action; screenshots show no broken or fabricated imagery; the HTML size does not multiply with each card/frame.

### P5 — Preserve clarity on tablet/mobile while retaining the accepted content model (Should)

- Evidence: Baseline captures pass overflow checks, but `768x1024.png` has AI above two narrow panels and no character; the 375 capture renders the pricing table as a 583px inner table inside a horizontally scrollable wrapper, and the page reaches 8,206px. The current CSS intentionally changes composition at 1080px/600px (CSS:6–8).
- Change: Keep the existing desktop three-column / tablet two-column / mobile tab intent, but make the tablet AI panel compact and visible, keep the search disclosure collapsed by default, and provide a clear scroll cue or stacked/card alternative for the pricing matrix on narrow screens. Keep the article reader wide and the existing prices/access/locale decisions verbatim.
- Files: `plans/visuals/explain-zuey-membership.html` only.
- Acceptance: Render 320px, 375px, 768px, and 1440px. No page-level horizontal scroll, clipped text, or covered controls; the active mobile panel is obvious; all touch targets remain at least 44px; the pricing content remains readable with headers or an explicit, accessible overflow affordance.

### P6 — Close disclosure and keyboard semantics for all new states (Should)

- Evidence: Mobile buttons use `aria-pressed` without relationships to panes (HTML:14, 171), and `mcp-example` toggles a hidden paragraph without `aria-expanded`/`aria-controls` (HTML:16, 175). The current `read-demo` scrolls to the article but has no focus handoff (HTML:178).
- Change: Add `aria-controls` and a clear active-state announcement for panel switching; add `aria-expanded`/`aria-controls` to MCP and filter disclosures; after a card opens the reader, move focus to the article heading or provide a skip link; preserve focus on dismiss/reopen for the admin notice. Use `change` listeners for selects if any remain, and ensure all new drag/roam controls work without a pointer.
- Files: `plans/visuals/explain-zuey-membership.html` only.
- Acceptance: Keyboard-only pass through all preview controls with visible focus; no focus enters hidden panels; screen-reader labels expose active panel, expanded filter, admin notice state, and rights state; `prefers-reduced-motion: reduce` removes sprite movement, roam transitions, and smooth scrolling while preserving content/state.

## DONE contract for this offline preview

Implementation is DONE only when every applicable item below is evidenced in a follow-up report:

1. P1–P2 and P3 acceptance checks pass; P4–P6 pass unless explicitly skipped with a reason accepted by the owner. Accepted pricing, access, locale, and manual-editing choices remain unchanged.
2. The offline file opens with zero external network requests and retains visible `preview/offline/not live` labeling. Discovery-surface scanning is recorded as not applicable because no URL/sitemap is in scope.
3. Screenshots at 1440×900, 768×1024, 375×812, and 320px reflow show no page overflow, clipping, broken thumbnails, character/bubble obstruction, or unreadable filter state. No High visual issue remains.
4. No baseline rubric area regresses. Knowledge/trust reaches at least 2/3 through the explicit data-use/admin-access copy; motion and accessibility reach at least 2/3 through sprite fallback, reduced-motion, keyboard, and disclosure checks.
5. Search, category, sort, shared-language metadata, per-article rights icon, paywall state, panel switching, character click/drag/keyboard movement, MCP announcement TTL/dismiss/reopen, and empty state all work offline.
6. All interactive controls expose visible focus, sensible labels, `aria-expanded`/`aria-controls` relationships where relevant, and no hidden panel is keyboard reachable. Reduced-motion mode keeps the character static and disables movement/scroll animation.
7. The artifact stays self-contained and the new sprite/thumbnails do not duplicate the existing large image data for every card or frame. Any size trade-off is reported with before/after byte counts.
8. No production data, credentials, API calls, payment state, or live MCP session is used. The report distinguishes preview behavior from live implementation claims.

## Unresolved questions

- Exact spritesheet dimensions/frame order and whether the offline deliverable must remain one file or may reference a sibling optimized asset.
- The owner’s preferred character roam boundary: active AI panel only on mobile, preview shell on tablet/desktop, or one shared shell rule.
- Exact TTL duration and whether dismiss state should persist for the current tab/session or reset on reload.

## Final verification pass — updated preview (2026-10-01)

The final evidence is materially stronger: source checks pass 21/21, interaction checks pass 25/25, four viewport renders (320, 375, 768, 1440) report zero errors/warnings/findings, and the offline run made zero external requests. The 4×4 alpha spritesheet, 16px viewport margin/64px control clearance, and in-memory TTL with dismiss-ID preferences are verified decisions. The admin copy, weather demo, enterprise pricing/credit, and click-to-load embed contract are clearly labeled as preview/proposed behavior and preserve the accepted business decisions.

### Remaining ranked findings

#### P1 — Fixed restore control still covers content (Must)

- Evidence: `desktop-business.png`, `mobile-business.png`, and `mobile-weather.png` show the fixed `Gọi Zuey AI lại` button over the business credit note, the lower business card, or the weather details row. The source keeps `.companion-layer` and `.restore-companion` fixed to the viewport, so the clean render report’s overflow result does not prove the no-obstruction requirement.
- Recommendation: reserve a safe bottom/right gutter for the fixed control, or collision-check it against the nearest interactive/text blocks and move it to an available shell edge/inline restore slot. Apply the same collision rule to the character tools and bubble. Re-run 320/375/768/1440 captures and keyboard tab order; no text, link, select, disclosure, or focus ring may sit under the companion layer.

#### P2 — Shared locale changes content state but not document language (Should)

- Evidence: the document starts as `<html lang="vi">`; the locale handler updates `state.locale`, greetings, labels, and card sets but never updates `document.documentElement.lang`.
- Recommendation: set the root `lang` to the selected locale in the shared locale handler. Keep untranslated/static preview copy explicitly scoped with its own language where needed; do not add a second local language control. Add one interaction assertion for `vi/en/zh/ko/ja` root language values.

#### P2 — Reader activation still leaves keyboard focus on the off-screen card (Should)

- Evidence: `.read-demo` only calls `scrollIntoView()` for `#article`; it does not move focus to the reader heading or provide a skip target. A keyboard user can activate a card and remain focused on the card while the reader moves elsewhere.
- Recommendation: make `#article-heading` (or the reader landmark heading) programmatically focusable and focus it after the scroll, with `preventScroll:true`; preserve the reduced-motion path. Assert focus handoff after keyboard activation.

#### P3 — MCP disclosure lacks the control-to-panel relationship (Should)

- Evidence: the script sets `aria-expanded` on `#mcp-example` and toggles `#mcp-status`, but no `aria-controls` relation is present.
- Recommendation: add `aria-controls="mcp-status"` to the trigger (and ensure the target has a stable id). This is a small screen-reader semantics fix and does not change the MCP contract or copy.

### Final disposition

The requested preview scope is implemented and honestly labeled, with one remaining visual acceptance blocker: the fixed restore companion can obscure content at the tested widths. The locale-language and reader-focus findings are accessibility follow-ups; the MCP relationship is a small semantics follow-up. The prior unresolved sprite/bounds/TTL questions are resolved by the latest evidence above.

## Closure verification — final fixes (2026-10-01)

The owner applied all four findings from the previous pass. Source inspection (with embedded image data redacted) confirms:

- The restore control is now effectively static and `dockRestoreInline()` inserts it after a visible prose/heading anchor, with a global-bar fallback. It no longer occupies a viewport overlay slot.
- The shared locale handler updates `document.documentElement.lang` and `#chat-greeting.lang`; advisory/policy/bubble copy is explicitly scoped as Vietnamese, and article titles carry their own locale tags.
- `.read-demo` focuses `#article-heading` (`tabindex="-1"`, `preventScroll:true`) after scrolling.
- `#mcp-example` now declares `aria-controls="mcp-status"`; panel controls have stable relationships.

The updated interaction report passes 28/28 checks with zero runtime errors and zero external requests. It specifically passes root/greeting language for all five locales, reader-heading focus handoff, MCP controlled-content linkage, restore control document flow, and all previous 25 checks. The prior P1 obstruction and P2/P3 accessibility findings are therefore resolved.

**Final disposition: DONE.** No concrete UX/AX blocker remains in the reviewed offline preview scope. Business decisions, privacy wording, proposed/live boundary, weather opt-in contract, enterprise price/credit, and embed contract remain preserved and honestly labeled.

## Final pricing/share critique — 2026-10-01

This bounded pass covered only the pricing and article-sharing additions. The source extract and `desktop-pricing.png`, `desktop-sharing.png`, `pricing-375.png`, and `sharing-375.png` show the four monthly prices unchanged at $9 / $9 / $19 / $29, a two-column desktop and one-column mobile pricing layout, and a two-column share-action layout that remains usable at 375px.

- Pricing selection is explicitly preview-only: provider/checkout text says checkout is not connected, selecting a plan does not grant reading access or perform payment, and the existing entitlement state stays unchanged.
- Share scope is explicit: free users receive public preview Markdown, the member sample receives full sample Markdown only after the explicit demo unlock, and canonical/`.md` URLs contain no token or private chat content.
- Clipboard, native-share fallback, manual-copy textarea, Markdown-only text, dialog Escape/return focus, official ChatGPT/Claude/Gemini destinations, and public-URL-only prompt behavior are represented in the source contract. AI links open provider home pages and do not claim unsupported prefill or automatic sending.
- The supplied mobile renders keep touch targets and wrapped content inside the dialog; the owner’s sticky heading and open-scroll reset address close-control reachability while browsing long modal content.

The owner reports 42/42 browser checks passing, including real system clipboard, public/full export gating, no-grant plan selection, literal `.md` output, and public-only AI prompts; four viewport renders report zero errors/warnings. At the time of this review, the denied-clipboard/manual-fallback and missing-native-share → copy-URL branches were being rerun as two additional checks. No concrete UX/AX defect was found in the pricing/share scope; retain the proposed/offline labels until those two fallback checks also pass.

**Final disposition for pricing/share: DONE_WITH_CONCERNS.** Concern is verification timing only; no source, entitlement, payload, routing, or mobile-layout blocker was identified. Production `.md` routes, auth/checkout, provider credentials, and real MCP entitlement tests remain correctly marked as pending implementation.

## Final motion, command, account, and public activity critique — 2026-10-01

This bounded pass reviewed the stripped source extract, `command-320.png`, `account-375.png`, and `github-desktop.png`. The 77/77 interaction run, four-width render (zero errors/warnings), genuine public GitHub refresh, and offline-refresh failure path provide strong evidence for the new scope. GSAP motion is finite and cancelled for reduced motion, the account view keeps its tab-only/offline boundary, the graph exposes 84 dated 44px day buttons and public-only caveats, and the OAuth dialog clearly says proposed/not connected. No motion, graph, OAuth, pricing, privacy, or live-backend claim requires reversal.

### Remaining ranked findings

#### P2 — One command-palette action is undiscoverable at 320px

- Evidence: `commandActions` contains seven actions, including `Zuey đang làm gì` / GitHub (`motion-command-account-review-source.txt:326-340`), while `#command-results` is capped at `46vh` with overflow and no count, gradient, scrollbar cue, or “more actions” text (`:21`). The refreshed `command-320.png` visibly presents only six actions before the keyboard-help footer. Arrow-key navigation/search can still reach the seventh action, but a pointer-only visitor has no indication that another action exists.
- Recommendation: keep all seven visible where the mobile dialog allows, or add a small “7 actions”/scroll cue and include “GitHub” in the placeholder or helper copy. Preserve the existing combobox/listbox keyboard behavior.

#### P3 — Uploaded avatar retains the demo accessible name

- Evidence: the avatar wrapper is `role="img" aria-label="Ảnh đại diện tài khoản demo"` (`motion-command-account-review-source.txt:24`). Upload replaces its contents with an `<img alt="Ảnh đại diện bạn vừa chọn">`, but the wrapper label is never updated (`:352-356`). Because descendants of an image role are commonly flattened in the accessibility tree, assistive technology can continue announcing the stale demo label after a user selects a local image.
- Recommendation: make the uploaded `<img>` the sole semantic image, or update the wrapper’s accessible name on upload and restore it to the demo label on reset. Keep the existing local-only status copy.

### Final disposition

**DONE_WITH_CONCERNS.** The new motion, account, public-activity, and proposed OAuth surfaces meet the reviewed scope and remain honestly labeled. Two small follow-ups remain: mobile command-action discoverability and the uploaded-avatar accessible name. The extra latest-day resize assertion was still running at review time; no other concrete defect was observed.

## Final article taxonomy and audit critique — 2026-10-01

This bounded pass reviewed the stripped taxonomy source, `taxonomy-320.png`, `taxonomy-375.png`, `taxonomy-overview.png`, and `taxonomy-1440.png`. The corrected VI-only classification scope, shared taxonomy contract, URL-plus-claim/date/version evidence caveat, fact/outdated orthogonality, public-label/Markdown omission of evidence, 97/97 interaction run, and four-width zero-error render are verified. The local preview remains clearly separate from proposed AI, REST, MCP, and persistence behavior.

### Remaining ranked findings

#### P2 — The newly revealed diff does not receive focus

- Evidence: submitting `#taxonomy-interview` reveals `#taxonomy-review`, calls `motionIn()` and scrolls it into view, but leaves focus on the “Xem diff nhãn” submit button (`article-taxonomy-review-source.txt:275-276`). The review heading is a plain `<h4>` without an ID or `tabindex` (`:24`). Keyboard and screen-reader users can therefore remain focused above the newly displayed approval content.
- Recommendation: give the review heading a stable ID and `tabindex="-1"`, focus it with `preventScroll:true` after the diff is rendered, and retain the existing reduced-motion scroll path. Keep the status announcement as a secondary cue.

#### P2 — Later fact revisions omit the previous evidence metadata from the diff

- Evidence: a proposal stores only `revision` and `before: classificationText(classification)` (`article-taxonomy-review-source.txt:271,275`). `classificationText()` excludes `scope`, `evidence`, `asOf`, and `reason` (`:272-273`), while the review context renders only the proposed values (`:276`). The first experience → fact proposal is understandable, but after a fact label has been applied, a second source/date/scope revision shows the same label text on both sides and gives the admin no previous metadata to compare.
- Recommendation: snapshot the structured prior record and render before/after scope, evidence URL, as-of date, and reason in the admin-only diff. Continue omitting those fields from public reader labels and Markdown.

### Resolved and accepted scope

The VI-only apply selector (`data-order="3"[data-locale="vi"]`) prevents cross-locale fact certification; other locale records remain unmodified. The collapsed browser filter, proposed API/MCP multi-label contract, admin interview/approval guard, revision check, and no-external-request boundary remain within the stated preview scope.

### Final disposition

**DONE_WITH_CONCERNS.** No taxonomy content, privacy, entitlement, unsafe-HTML, or public Markdown defect was found. The two accessibility/editorial-review follow-ups above should be addressed before treating the local audit flow as fully reviewable for repeated fact revisions.
