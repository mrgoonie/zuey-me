# Article taxonomy and AI-assisted audit preview

## Scope and DONE before edits
Extend the existing advisory HTML and its preview checks only; no deployed API/MCP or production article data changes. Add typed multi-label facets: content nature (fact/opinion/experience/hypothesis), freshness (current/needs-review/outdated), domain, tools, versioned AI models, workflow, mindset and extensible admin-approved labels. Fact is an evidence-backed claim classification, not an AI certainty score or whole-article truth guarantee; a fact may also be outdated for today's context. Evidence, scope, as-of/review dates and version applicability belong to the classification record.

Show a local preview of AI proposal → focused admin interview → before/after review → explicit approval → label update. No AI call or server persistence claimed. Fact proposals need source/claim scope/date and admin review. Proposed API/MCP share the taxonomy, support list/filter/write and bulk audit jobs; classification proposals remain read-only until approved and are checked against article revision. Admin identity and OAuth scopes enforced server-side; public users only see approved metadata under existing access policy.

Accept: initial labels and collapsed filters; combinations of label/category/locale/search; propose never changes labels; fact approval blocked without evidence; administrator can revise answers, inspect diff, approve or cancel; label update visible in reader and corresponding sample list; explicit outdated status independent of fact; no unsafe HTML or external requests. Existing browser checks remain passing. Four viewport render and runtime syntax checks; independent read-only critique. Production schema/tool interoperability, actual AI corpus audit and interviews stay launch acceptance requirements.

## Todo
- [x] Add taxonomy, workflows, API/MCP contract and verify criteria.
- [x] Verify local preview interactions and responsive rendering.
- [x] Resolve independent critique.

## Verification
Direct Chrome/CDP: **99/99 pass**, including the previous 82 checks and 17 taxonomy/filter/interview/approval/Markdown/responsive checks. No runtime exceptions. Offline UI operations issue zero HTTP; the preserved explicit GitHub refresh test separately makes only public GitHub requests.

Verified: facet/category composition/reset; proposal is read-only; fact requires evidence URL, claim scope and date in demo; before/after diff retains fact + outdated independently; changed answers invalidate approval; explicit checkbox approval applies local metadata; only VI evidence classification changes (other locales remain unverified); Markdown carries approved label metadata but omits private claim/evidence text; cancel preserves last approved state. Interviews fit 320/375/1440; four-width full render 320/375/768/1440 has **0 errors / 0 warnings** after increasing disclosure hit targets to44px. Captures: taxonomy-320.png, taxonomy-375.png, taxonomy-overview.png in zuey-membership-ux-render-check.

Source/runtime syntax and harness node --check pass. Fresh bun test: **21 pass / 0 fail**. Fresh bun run build: **0 errors / 0 warnings**, 2 pre-existing informational hints. No production app/endpoints changed. Existing previews stay noindex and self-contained; taxonomy API/MCP endpoints and actual AI evidence verification/audit/interviews remain proposed, not tested live.

Fact certainty is not manufactured: the contract requires actual source retrieval, evidence/claim matching, version/date context and admin review; missing/contradictory evidence returns needs-review/questions. URL-presence checks in the offline form demonstrate input completeness only and explicitly do not verify the source.

Docs impact: minor, preview and own reports only. No deployed write, AI call, production classification or evergreen authority change. Headless browser/profile cleaned in finally; completed idle Node runners stopped when necessary.

## Independent critique resolved
Both review findings fixed and browser-tested: review heading receives keyboard focus when the diff opens; before/after comparison includes source, claim scope, as-of date and reason, including when a later proposal keeps the same label names. Proposal captures the prior record; editing answers still invalidates approval.

## Unresolved questions
No additional input needed to update the accepted preview. Final domain/tool/model dictionaries and fact-source verification policy are admin-curated; production audit execution is not performed in this task.
