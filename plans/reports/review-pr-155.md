# Review: PR #155 (closes #65): product engagement events

Head `d3b7ffb`, base `39b84d8`. Reviewed in an isolated worktree. Reviewed against issue #65 and epic #24.

**Verdict: REQUEST_CHANGES.** One wording fix is needed on `/privacy` (vi and en). Everything else is acceptable or a follow-up.

## Gates

| Check | Result |
|---|---|
| `bun test` (PR head) | 1007 pass, 0 fail (55 files) |
| `bun run build` (PR head) | 0 errors, 0 warnings |
| Merged with `origin/main` (`6b5debd`, 8 commits ahead: #133, #136, #137, #139, #140, #142, #148, #152) | Clean auto-merge; 1071 pass, 0 fail (60 files); build has 0 errors and 0 warnings |
| GitHub `mergeable` | `MERGEABLE` (`UNSTABLE` = checks state) |
| Probe merge with open #151 | **Conflict in `src/pages/privacy.astro`** (adjacent analytics paragraphs). Whichever lands second must resolve it. |
| Probe merge with open #147 | Clean |
| Client bundle `dist/_astro` | 7,923,928 B. This matches the PR claim (+15.4 KB). |
| SSR worker | No `web-vitals` or `exception-autocapture` code in `dist/_worker.js`. The server growth comes from the islands and chat-service changes. |

## 1. Privacy

**Event properties are clean.** I checked every new `track` and `trackOnce` call against the spec. They send enums and `publicSlug`/`filterValue` values (slug regex, no 8-digit runs, `containsPii`). Domains are bare hosts (`siteDomain`). The rest are counts, lengths, `failureReason` codes and backend numbers:

- search sends `query_length`
- chat sends `chars`
- survey sends the `options` count

No free text, email, token, chat text or vote label reaches a property. `track()` still drops unknown properties and PII. The article and `/articles` scripts read only the hidden `data-*` elements.

**Consent is unchanged.** `PERFORMANCE_CAPTURE_OPTIONS` is spread into the existing `ph.init` call, and that call only runs after `consentState === 'granted'`. `respect_dnt`, the `loaded` opt-out re-check and `opt_out_capturing` also cover `$exception` and `$web_vitals`.

**`before_send` coverage.** posthog-js sends both `$exception` (`captureException`) and `$web_vitals` through `capture()`, so `scrubCaptureResult` runs on them.

- `scrubValue` scrubs strings at any depth, so these are all reached:
  - `$exception_list[].value`
  - `stacktrace.frames[].filename`
  - the nested `$web_vitals_*_event.$current_url`
- The only requests that bypass `before_send` are the lazy extension script loads (`web-vitals.js`, `exception-autocapture.js`) from PostHog's asset host. They carry only IP and user agent, and they happen only after consent.

**Residual risk (low to medium, disclosed).** Exception messages are free text. `redactString` removes emails, JWTs, secrets and sensitive `name=value` pairs, but nothing else. A message can still contain user input. Example: V8's `JSON.parse` errors quote part of the input, and a non-Error rejection value is serialised. Inline-script frames carry the page URL, so the `?q=` from #156 reaches them too.

`/privacy` does disclose "error type, message and code location", so I accept this. A future hardening step could cap or blank `$exception_list[].value` on `/chat`, or drop exceptions on `isSensitivePath`.

## 2. AI chat stream (server)

- `startedAt` is taken before validation. `latency_ms` is added to `done` and to both `error` yields. `cost_cents` is added to `done`.
- `latency_ms` includes the post-stream D1 writes: `finishMessage`, `addUsageCost` and the artifact inserts. That is fine as "time to end of reply", but it is worth knowing for p95 analysis.
- There is no regression in `chatSseResponse`, which spreads the event. `mcp.ts` `collect()` picks fields explicitly, so MCP output is unchanged. OpenAPI is updated.
- **Who sees cost.** Only the authenticated member who owns the session, and only for their own reply, over the existing SSE route. The same member already gets `spent_cents` (monthly running total) and `budget_cents` from `/api/v1/chat/status` and the 429 body, so the per-reply cost was already derivable. Nothing new is exposed to other users or to anonymous visitors. **Acceptable.** Sending it to PostHog under the internal member id matches the epic's AI unit-economics goal.

## 3. Correctness against #65

All 18 issue events are present with matching names. Web Vitals and exception autocapture are on.

- **StrictMode and remounts.** All mount-time events use `trackOnce`. The ReadsBrowser debounce clears its timer in cleanup. The KnowledgesPanel fetch is aborted on re-run, and AbortError is ignored. The CommunityAccess focus and visibility listeners are removed in cleanup and only exist while an invite is open. The article script clears its interval and scroll listener once engaged.
- **Low:** `knowledge_search` fires again on the home panel and Reads whenever a filter changes while a query is present. A filter change re-runs the fetch, or changes `filtered.length`. This inflates search counts compared with the docs' "each search". Consider firing only when `q` changes.
- **Low:** `app_opened` is not sent for the deep link present at first load. The initial state comes from `appFromHash` in `useState`, not from `openApp`. The docs say "including deep links"; that is true only for `hashchange`.
- **Low:** a retry sends `quoted: false` even when the original question carried a quote.
- **Low:** a `handlePreStreamError` code such as a sign-in or entitlement refusal is reported as `ai_response_failed` (`stage: request`). That is reasonable, but say so in the docs if dashboards should exclude it.
- **Nit:** `article_unlocked` fires on every full view of a `knowledges` article by an entitled reader, including admins. It is not a one-time "unlock".

## 4. Bundle

- +15.4 KB raw on the client: two small page scripts plus the island changes.
- posthog-js comes from the CDN snippet, so the Web Vitals and exception extensions add no bundle bytes.
- Nothing heavy entered the worker.

**Reasonable.**

## 5. Privacy wording (required change)

The new vi and en paragraphs say searches send "only the query length and the number of results" ("chỉ độ dài từ khoá và số kết quả"). The URL paragraph lists the scrubbed parameters, and `q` is not among them.

A reader will conclude that search words never reach PostHog. They do: `/articles?q=…` is in `$current_url`, `$session_entry_url` and the autocaptured `href` of the panel's "browse all" link (#156). The new `knowledge_search` event also carries that `$current_url`.

`docs/analytics-events.md` states this limit correctly, but `/privacy` does not.

**Fix:** add one clause in both languages. For example:

- en: "the address of the /articles results page still includes the search words"
- vi: "địa chỉ trang kết quả /articles vẫn chứa từ khoá tìm kiếm"

Alternatively, merge the `q` scrub from #156 first and keep the current wording.

The rest of the wording is accurate in vi and en: Web Vitals, JS error reports with message and location, the AI metrics measured by the server, and the PostHog processor row.

## 6. Rebase risk

- Against main: none. The auto-merge is clean and green.
- #151 will conflict in `privacy.astro`.
- #151 also adds `advanced_disable_flags: true`. Once both PRs are merged, check in PostHog Live Events that `$web_vitals` and `$exception` still arrive. The client config should enable them without remote flags, but nobody has verified that.

## Cleanup

The worktree, the `review-155`, `review-155-merge`, `rv-151` and `rv-147` branches, and the `dist/` output inside the worktree have been removed. No `.wrangler/` was created outside the worktree.
