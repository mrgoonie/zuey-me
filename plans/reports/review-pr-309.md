# Review: PR #309 (Closes #299), head `50dffb9`

Fresh-context review of "fix(widgets): align the ready-to-loaded watchdog with the heartbeat limit". Read issue #299, the PR body and diff, and Round 2 of `review-pr-290.md` (Minor A and Nit A are the source of this PR). Gates ran in a temp worktree at `50dffb9`, which was removed afterwards (its `dist`, `.wrangler` and `node_modules` went with it).

## Verdict

**MERGE.** No blocking findings. The change does exactly what Minor A asked for, the doc corrections match the code, and every gate is green.

## Gates

| Gate | Result |
| --- | --- |
| `bun install --frozen-lockfile` | 744 packages, lockfile unchanged |
| `bun test tests/interactive-autorun-dom.test.ts` | 37 pass, 0 fail |
| `bun test` | 1957 pass, 0 fail (112 files) |
| `bun run build` | 0 errors, 0 warnings (70 hints), `[build] Complete!` |
| `gh pr checks 309` | Test & Build: pass (2m46s) |

No endpoints changed, so OpenAPI is unaffected.

## Security guarantees from #290

The diff changes one value: `LOADED_AFTER_READY_MS` goes from 5 000 to `HEARTBEAT_TIMEOUT_MS` (8 000). It also exports `HEARTBEAT_TIMEOUT_MS`. No control flow changed (`InteractiveFrame.tsx:155-255` is identical apart from the constant).

- **Halt on `leave`** (`:188`, `:204`): unchanged. It still requires this run's nonce, plus `source === contentWindow` or (`source === null` and `type === 'leave'`).
- **Second `load` and the 1 s load handshake** (`:139-148`): unchanged. A post-load navigation to a page that finishes loading is still halted within 1 s.
- **`document.open()` with a page that never finishes loading:** this was already caught only by the heartbeat watchdog (8 s visible, 180 s hidden). It is unchanged, because the loaded timer is cleared once `loaded` has arrived.
- **Hidden-tab limit** (`:171`, `:175`): `HIDDEN_HEARTBEAT_TIMEOUT_MS = 180_000` is unchanged. The loaded timer is a plain `setTimeout` in the parent and does not depend on visibility, so it is still 8 s while hidden. That is still a tighter bound than the hidden heartbeat.
- **The only weakening:** in Safari and Firefox, a widget can navigate while its document is still parsing, to a page that never fires `load`. That foreign page now runs without the widget CSP for up to 8 s instead of 5 s. Chromium is not affected, because the `csp` attribute refuses the page. Round 2 of #290 recommended this trade, and #299 accepts it. The playbook now says "up to 8 s". The PR claims "halts nothing the heartbeat watchdog would tolerate", and that holds: a ready, silent frame is halted at 8 s by either rule.

## Doc corrections vs code (`docs/agent-article-playbook.md:137-139`)

- "reports `ready` without reporting its own load within 8 s": matches `:195-196`.
- "When the old document's `pagehide` report arrives, the halt is near-immediate": matches. `leave` calls `haltNavigated()` synchronously (`:204`), and this agrees with the `nocsp` measurement in #290 Round 2.
- "Without that report it takes about 1 s after the landed page's `load`": matches `LOAD_HANDSHAKE_MS` (`:146`).
- "Up to 8 s when the widget navigates while its own document is still loading": matches.
- "replies that settle after a run is halted … are dropped; a reply that settles in the few milliseconds between the navigation and the halt can still reach the navigated page": matches. `cancelled` is set only in the effect cleanup (`:248`), which runs after the state change, and `answer()` checks it (`:221`).
- The search for stale "5 s" or `LOADED_AFTER_READY` references in `docs/`, `src/`, README and AGENTS found none.

## Tests

- **Timers are exercised and restored.** Both new tests use the file's `advance()`, which calls `jest.advanceTimersByTime` inside `act`. `beforeEach` sets up fake timers. `afterEach` unmounts, drains the start queue, calls `jest.useRealTimers()` and restores `fetch`, `IntersectionObserver`, `matchMedia` and `userAgent`. Bun's fake timers also drive `Date.now`, which the watchdog's `silentFor()` depends on.
- **No new global patches.** The two new tests touch no globals, `Object.defineProperty`, `visibilityState` or happy-dom settings. Nothing can leak into later test files. The suite-wide run (112 files, 0 fail) confirms it.
- **Test 1** ("keeps a ready widget … delayed by a busy shared process") discriminates. With 5 s, the loaded timer fires during `advance(6_000)`, and the PR shows that failure on main.

## Findings

### Nit 1: the second new test does not prove the loaded timer itself fires at 8 s

**Where:** `tests/interactive-autorun-dom.test.ts:608-617`

**Scenario:** the test sends `ready`, advances to 7 999 ms, then advances 2 001 more ms to 10 000 ms. By then the heartbeat watchdog would also halt the frame: its 2 s tick at 10 000 sees 10 000 ms of silence, more than 8 000. So the timing part would still pass if the loaded timer were removed or set much higher. Only the `toBe(HEARTBEAT_TIMEOUT_MS)` equality pins the constant.

**Impact:** low. The older test at `:580-591` still exercises the loaded timer on its own: it keeps the frame non-silent with heartbeats, then expects a halt at exactly `LOADED_AFTER_READY_MS`, now 8 s, which the heartbeat watchdog cannot cause. Optional tightening: advance to exactly `HEARTBEAT_TIMEOUT_MS` (8 000) instead of 10 000. At that point only the loaded timer fires, because the watchdog's 8 000 ms tick sees silence equal to the limit, not greater.

### Nit 2: the PR body says the second test fails on main because of the timing

This is cosmetic. On main the second test fails at the constant equality (`Expected: 8000, Received: 5000`), not at the timing check. The PR's own output shows this, and it is consistent with Nit 1.

No critical, major or minor findings.

## Unresolved questions

None.

Status: DONE
Summary: MERGE. Focused file 37/0, full suite 1957/0, build 0 errors and 0 warnings, CI Test & Build pass. No blocking findings, only two test and wording nits.
