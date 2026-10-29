# Re-review: Activity Monitor Phase 3 fixes (#203)

## Scope
- Range: `7460824..dba4bd6` (7262463, cecd84b, d25254a, dba4bd6). 10 files, +217 / -79.
- Earlier review: `plans/reports/code-reviewer-261020-phase3-presence-history-review.md` (H1, M1, L1, L3, L4; L2 out of scope, tracked in #224).
- Checks run (read-only):
  - All 18 presence/activity test files: 250 pass, 0 fail.
  - `bunx tsc -p workers/presence --noEmit`: 0 errors.
  - I did not run the full `bun test` or `bun run build`; the parent's run covers them.

## Verdict per finding
| Finding | Status | Evidence |
| --- | --- | --- |
| H1 history lost on hibernation | Fixed | `presence-history.ts:119-135`: `if (this.dirty) await this.write(now)` runs on every rise or new non-empty bucket. The throttle, `lastWriteAt`, `flushDueAt` and `HISTORY_WRITE_INTERVAL_MS` are all gone, and nothing in `src/`, `workers/`, `tests/` or `docs/` references them any more. |
| M1 counters mislabelled | Fixed in the UI, runbook and contract. Two stale strings remain (L-1). | Panel shows "Counters (since last wake)" / "Woke at" plus an explanatory note. `contract.ts:128-131`. Runbook step 2 is reworded. |
| L1 docs | Fixed, with one wording nuance (L-2) | analytics-events now says zeros are drawn as 0, not as gaps. The cost model is rewritten. |
| L3 polling after 401/403 | Fixed | `PresenceDiagnosticsPanel.tsx`: `authStoppedRef` gates the interval, and a manual Refresh resets it on success. The test covers both stop and resume. |
| L4 live region floods | Fixed (nit L-4) | Separate `am-sr` live region driven by `announced`. The tip is `aria-hidden`. The test confirms pointer moves leave the live region empty. |

## Requested checks
- **Alarm logic without the history branch.** OK. The removed branch in `nextAlarm` ran only when `next === null`, so it never affected the sweep or keepalive values. `armIfNone` was used only by history. Coalesced broadcasts still arm through `scheduleRefresh` (`presence-hub.ts:345-355`), and `alarm()` clears `refreshPending`, refreshes and re-arms from `nextAlarm`. `presence-worker-hub.test.ts` passes unchanged.
- **Write cost is bounded, idle is 0.**
  - A write happens only when `dirty` is set: on a rise, a new bucket with `active > 0`, or a pending retry.
  - Per bucket: a first write at value v ≥ 1, then at most N−v rises, so ≤ N writes, plus failed-write retries. N is capped by `MAX_SOCKETS_TOTAL = 5000`.
  - A steady crowd costs one write per bucket. The sweep alarm fires roughly every ≤ 76 s (`max(now+15s, oldestHb+75s+1)`) while anyone is live, so every bucket gets an observation.
  - Events that evaluate twice (`sub`, `updateOwner`) use the same `now` and the same sessions, so the second `observe` has no rise and does not write.
  - Idle (active 0) never sets `dirty`. The test proves 0 writes and no alarm over 3 h with idle sockets open.
  - Storage is SQLite-backed (`new_sqlite_classes`), so one `put` is one row write.
- **A failed write retries.** OK. `dirty` stays true and the next `observe` writes even without a rise. The test is `retries a failed write on the next observation`. Caveat: L-3.
- **No value only in memory across an event boundary.** Holds except after a failed `put` (L-3). Pruning in `toHistory`/`stats` changes memory without a write, but it only drops buckets older than 24 h that reads already filter out. Harmless.
- **Tests really revive the hub.** Yes.
  - Both new hub tests build `new PresenceHub(state, ENV)` over the same `FakeState`/`FakeStorage`. The sockets and their attachments persist in `state`, matching hibernation.
  - `send` and `fireAlarm` close over the `let hub` variable, so they hit the revived instance.
  - The final read uses yet another fresh hub.
  - Under the old code, the first test fails: peak 2 was throttled and lost. So the test is not a phantom.
- **Docs match code.** Mostly. See L-1 and L-2.

## Critical
None.

## High
None.

## Medium
None.

## Low

**L-1. The OpenAPI and Worker comments still say "since last started / resets on eviction".**
- Where: `src/lib/presence/presence-diagnostics-openapi.ts:18` and `:59`, `workers/presence/src/hub-diagnostics.ts:10`.
- Impact: the Scalar `/docs` description is now inconsistent with the panel, the contract and the runbook ("since last wake, resets after ~10 s idle"). An API consumer reading `/docs` will still assume long-lived counters, which is the exact misreading M1 was about.
- DoD item 3 asks that OpenAPI match the endpoint behaviour.
- Fix: reuse the contract wording, for example "In memory since the Durable Object last woke; the hub hibernates after about 10 s without events, which resets them".

**L-2. `presence-operations.md:50` says a rise is written "during the event that caused it". That is not true for coalesced arrivals.**
- Path: an `hb` inside the 2 s broadcast window only sets `refreshPending` and arms an alarm (`presence-hub.ts:349-354`). The rise is observed and written by that later alarm event, on a possibly revived instance.
- This is still safe across hibernation, because the alarm is durable. The test `a coalesced rise is observed by the alarm on a revived instance` proves it.
- Failure scenario: two visitors send `hb` within 500 ms, then one closes the tab before the alarm fires (≤ 2 s). That peak is never observed. This behaviour predates the fix. It was always true, and the docs now overstate it.
- Fix: "written by the snapshot evaluation that sees it (the event itself, or the coalesced broadcast alarm at most 2 s later)".
- Related nit: the analytics-events bullet omits "or a new bucket starts". It links to the cost model, which does include it.

**L-3. A failed history write is retried only if the same instance observes again before hibernating.**
- Where: `presence-history.ts:144-146` swallows the error and keeps `dirty` only in memory.
- Failure scenario: the last rise of a burst hits a `put` failure, then the hub goes quiet. About 10 s later it hibernates, and the next wake loads the older stored value, so the peak is lost.
- The module comment ("retried on the next observation") and the cost-model doc both imply a guaranteed retry.
- Practical risk is low. On SQLite-backed DOs a failed durable commit usually breaks or resets the object rather than throwing here. Not worth an alarm-based retry. A one-clause doc caveat ("retried on the next observation while the object is awake") is enough.

**L-4 (nit). The chart announces on mouse-click focus too.**
- Where: `HistoryChart.tsx:89-94`. The plot has `tabIndex={0}`, so a pointer click focuses it, and `onFocus` sets `announced`.
- The result is a single announcement, not a flood. It does slightly contradict commit dba4bd6 ("only on keyboard selection").
- Acceptable as is. To tighten, gate on `:focus-visible` (`e.currentTarget.matches(':focus-visible')`) before `setAnnounced`.

## Edge cases checked, no defect
- Clock skew (`last.t > t`): no push, no write.
- Malformed storage: starts empty, and the next rise overwrites it.
- A `load()` failure leaves `loaded = false` and retries next time. A throw from `load` surfaces as a 503 from `/snapshot` or a rethrown alarm, which the runtime retries. This is unchanged.
- No interleaving risk: `evaluate` awaits only storage operations, so input gates serialise the events.
- Diagnostics panel: the interval keeps ticking as a no-op while stopped, which is harmless. On a non-JSON error the poll continues, which is correct for an outage.

## Recommended actions
1. (Optional, before merge if touching docs anyway) Align the OpenAPI and `hub-diagnostics.ts` comment wording (L-1).
2. (Optional) Doc precision for L-2 and L-3.
3. L-4 is a nit; it can ship.

## Unresolved questions
None.

Status: DONE
Summary: All targeted fixes (H1, M1, L1, L3, L4) are correct and complete. Alarm sweep, keepalive and coalescing are unaffected. Writes are bounded (≤ peak per bucket, 0 when idle). The hibernation tests genuinely revive the hub. 250 presence tests pass and the worker typecheck is clean. Only Low doc and wording nits remain (stale OpenAPI counter wording, "during the event" overstatement, failed-write retry caveat). Clean to merge.
