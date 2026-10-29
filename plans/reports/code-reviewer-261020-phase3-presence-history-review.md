# Code Review: Activity Monitor Phase 3 (24h presence history + Studio diagnostics), issue #203

## Scope
- Range: `f732099~1..3c6e49d` (6 commits), 40 files, +2809 / -227
- Focus: Worker history recorder + `/v1/history`, `/internal/diagnostics`, Pages `GET /api/v1/presence/diagnostics`, Activity Monitor chart, Studio Presence tab, docs, tests
- Checks run: 6 phase-3 test files: 47 pass / 0 fail. `tsc -p workers/presence`: 0 errors. `astro check`: 1 error, and it is in the **untracked** `scripts/presence-load-test.ts:220` (`protocols` not in `string[]`), outside the range. Full `bun test`, first run: 1506 pass / 1 fail (637 s). That run's output was truncated, so the failing test's name was not captured. A second full run produced no `(fail)` lines, so the failure looks like a timing flake under machine load (the load test was running). I did not attribute it to this range. Re-run once before marking the PR done.

## Overall
The structure is sound. Suppression is shared with the snapshot through `suppressedCategories`, the diagnostics parser rebuilds the object field by field, the internal route reuses the owner HMAC guard, and the cache is factored out without changing its behaviour. One real correctness defect: the history write throttle and the "final write" alarm assume the Durable Object stays in memory. Under the Hibernation API it does not, and the tests never model that. Acceptance criteria otherwise verified (details below).

## Critical
None found. No auth bypass, and nothing leaks.

## High

### H1. Throttled history peaks and the "final history write" are lost when the Durable Object hibernates
`workers/presence/src/presence-history.ts:87-147`, `presence-hub.ts:259-260, 307-311`

The recorder keeps the unwritten bucket only in memory (`buckets`, `dirty`). It relies on an alarm at `lastWriteAt + 60s` to write the last peak once activity ends. A Durable Object using hibernatable WebSockets hibernates after about 10 s without events, and that discards in-memory state (Cloudflare DO lifecycle docs). A pending alarm does not prevent hibernation. When the flush alarm wakes a fresh instance, `load()` reads the older stored value, `dirty` is false, and nothing is written.

Failure scenario: the site is quiet. Visitor A arrives at 12:00:00, which is written at once (peak 1). Visitors B, C and D arrive by 12:00:20 (peak 4, `dirty`, throttled). All leave or go idle by 12:00:45. Idle clients send no heartbeats, so the DO hibernates around 12:00:55. The flush alarm fires at 12:01:00 on a new instance, and bucket 12:00 keeps **peak 1** permanently. On a low-traffic site, short bursts like this are the common case. The chart under-reports exactly the spikes it exists to show. The final-flush branch in `nextAlarm` and `armIfNone` therefore mostly arms useless alarms.

The test `presence-worker-history.test.ts:237` ("writes the final peak when activity ends") reuses the same `hub` instance across the drain loop, so it never exercises hibernation. It passes only because memory survives in the fake.

Fix options (any one):
- When `active` drops to 0 (end of activity) with `dirty`, write immediately and skip the throttle. The extra write is bounded: one per activity end, and you can keep a floor of about 10 s to stop 0↔1 flapping. The flush alarm can then be removed.
- Or write whenever the bucket peak rises, with a short floor (for example 10 s) instead of 60 s. Peaks only rise within a bucket, so writes stay bounded by distinct peak increases. This needs re-agreeing the "about 1 per 60 s" budget with the orchestrator.
- Either way, add a hub test that builds a **new** `PresenceHub(state, ENV)` between the throttled peak and the alarm (`fireAlarm` on the revived hub) and asserts the peak is stored.

Also correct the module comment ("A peak that rose and fell again ... right before an eviction can be lost"). With hibernation this is the normal path, not a rare edge.

## Medium

### M1. Diagnostics counters and alarm timings reset on every hibernation, so the runbook signals are unreliable
`presence-hub.ts:93-100` (`counters = newHubCounters(Date.now())`, `lastAlarmRunAt/Ms` in memory), `hub-diagnostics.ts`, `docs/presence-operations.md:38,59`

The same hibernation behaviour (about 10 s idle) recreates the class. `connectsAccepted`, `connectsRejected`, `messagesDropped`, `abuseCloses`, `broadcasts`, `lastRunAt` and `lastRunMs` cover only the current wake period, often seconds. The diagnostics request itself wakes the object, so an admin opening the panel typically sees `startedAt` of "just now", zero counters and `Last run: —`.

The runbook says "Rising `connectsRejected` points at the limits; rising `abuseCloses` ...". That trend is usually invisible, because the counters are reset between 30 s panel refreshes whenever the hub went quiet for 10 s. During a real flood the hub stays awake, so counters do work in the scenario that matters most. The docs and UI label should say so.

Fix: either (a) persist the counters into DO storage piggy-backed on existing writes (history write, signature write) with a coarse throttle, or (b) keep them in memory but rename and document them as "since the object last woke (resets after ~10 s idle under hibernation)". Then change the runbook step 2 wording and the panel group title "Counters (since start)" to match.

## Low

### L1. Docs claim gaps are drawn as gaps; they are not
`docs/analytics-events.md` (24h history bullet: "Slots with no recording read back as peak 0, and the Activity Monitor draws them as gaps").

The Worker always sends all 288 buckets (`presence-history.ts:162-165`), so `buildHistorySeries` marks every slot `gap: false`. The chart draws a continuous area at 0, and the tooltip says "Peak: 0". `strings.noBucket` is only reachable with a malformed or short answer. Either drop "draws them as gaps" from the docs or omit zero buckets on the wire. The second option also shrinks the payload by about 10x on a quiet day. In the same docs, "written at most once a minute and only while someone is live" (`presence-operations.md:50`, `analytics-events.md`) is contradicted by the post-activity flush write. Reword once H1 is fixed.

### L2. The internal HMAC is not bound to method or path
`src/lib/presence/internal-auth.ts` (signature covers only `label:seconds`)

A header minted for `GET /internal/diagnostics` is equally valid for `PUT /internal/owner` within ±120 s. Today the header travels only over the service binding (and over https in unbound dev), so there is no concrete exposure. Phase 3 does add a second caller that fires every 30 s for every admin, though. Defence in depth: sign `${method} ${path}:${seconds}` and verify the same on the Worker.

### L3. The Studio diagnostics panel polls forever after a 401/403
`PresenceDiagnosticsPanel.tsx:71-77`

When the Studio session expires, it keeps calling every 30 s, and each call resolves the principal against D1. Stop the interval on 401/403. Minor.

### L4. The chart tooltip's live region announces on every pointer move
`HistoryChart.tsx:40-43, 89`

With `role="status"` + `aria-live="polite"`, a screen-reader user who moves the mouse across 288 slots gets a queue of announcements. Consider announcing only on keyboard selection (for example a `focused` gate on the live region, or a separate visually hidden live region updated from `onKeyDown`).

### L5. Untracked `scripts/presence-load-test.ts` fails `astro check`
Line 220: `'protocols' does not exist in type 'string[]'`. It is not in the range. If it gets committed as-is, `bun run build` fails and that breaks the Definition of Done. Fix the typing or exclude it before committing.

## Acceptance criteria verification
| Criterion | Result |
| --- | --- |
| `/v1/history`: 288 × 5-min buckets, peak + categories, suppression same as snapshot | Pass. `toHistory` always emits 288 buckets, and `publish` → `suppressedCategories(peak, counts)` is the same function as the snapshot uses (groups < 3 fold into `other`, empty when peak < 3). No members, IDs, URLs or owner data. Raw counts stay in the DO. |
| One DO storage key, never D1 | Pass. `HISTORY_STORAGE_KEY='history'`, tuples, pruned to 24h. The size is about 288×9 numbers, far under the value limit. |
| Writes ≤ ~1/60 s, 0 when idle | Pass for rate (the throttle survives restart via `savedAt`), and idle writes are 0. **Correctness of what gets written fails under hibernation (H1).** |
| Memo/edge cache, CORS, size | Pass. Shared `createHubResponseCache` (30 s memo, 60 s edge, 15 min stale, internal cache key). CORS uses the same allow-list plus `Vary: Origin`, and 403 for foreign origins. Payload is about 16 KB uncompressed. |
| `/internal/diagnostics` guarded like `/internal/owner` (404) | Pass. `isInternalCaller` runs before the method check, there are no CORS headers, `no-store` is set, and the route is dispatched before origin handling. |
| Diagnostics counts/timings only | Pass. Built field by field on the Worker and re-parsed field by field on Pages (`parsePresenceDiagnostics`). |
| Pages endpoint auth matrix | Pass. `requirePresenceDiagnosticsReader` admits `kind==='admin'` (Studio session, admin member session, admin key) and `via==='read_api_key'`. Everything else goes through `requireCan('admin')`: anonymous → 401, member or `zk_` key → 403, invalid key → 401. GET counts as same-origin under `isSameOriginRequest` (safe method), so member-session admins work. No bypass found. Worker failure → 503, and `no-store` is set on both success and error. |
| Chart loads only when open and visible, failure is graceful | Pass. The poller runs only while `active`, skips scheduling while hidden, uses a generation counter to drop late answers, and has its own error state. The live panel is untouched. |
| i18n in 5 locales | Pass (en/vi/zh/ko/ja, typed against `en`). |
| Accessibility | Mostly pass: focusable group, label with max and time, keyboard nav (arrows, PgUp/PgDn, Home/End, Esc), hint via `aria-describedby`, SVG `aria-hidden`. See L4. |
| Studio tab visible to every admin, owner controls owner-only | Pass. The tab is always listed, `PresenceOwnerPanel` renders only when `owner`, and the test confirms a non-owner never calls the owner endpoint. The `#presence` hash now works for every admin. |
| OpenAPI | Pass. Path and schema are registered in the Presence fragment, with security `MemberSession` + admin schemes. |
| Docs accurate | Mostly. See L1 and the M1 wording. Log prefix change (`presence owner:` → `presence internal:`) is reflected in the docs. |
| Tests meaningful | Mostly. Good coverage of the auth matrix, guards, suppression, throttle, cache and poller lifecycle. Gap: no hibernation simulation for the hub, which is why H1 slipped through. |

## Recommended actions
1. Fix H1 (write on activity end, or a short-floor write on peak rise) and add a test with a revived hub.
2. Fix M1: persist the counters, or relabel them and update the runbook and panel wording.
3. Correct the docs (L1).
4. Optional hardening: L2, L3, L4. Fix L5 before committing the load-test script.

## Unresolved questions
- Is the "~1 write per 60 s" budget a hard requirement, or just a cost guide? It decides which H1 fix is acceptable.
- Should diagnostics counters survive hibernation (cost: occasional storage writes), or is "since wake" acceptable if it is labelled honestly?

Status: DONE_WITH_CONCERNS
Summary: No auth or privacy defects; the access policy, internal guard, suppression, caching, i18n and Studio gating meet the acceptance criteria. One High: in-memory throttled history and the final-flush alarm lose peaks when the Durable Object hibernates (~10 s idle), and the tests miss it because they never revive the hub. One Medium: diagnostics counters reset on every hibernation, so the runbook's "rising counter" signals are unreliable.
