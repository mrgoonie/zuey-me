# Review: PR #270 (closes #255) and PR #272 (closes #214)

Independent review, 2026-10-23. Heads reviewed: #270 `d1bb41e` (`test/zueyos-condition-waits`), #272 `9e808ef` (`fix/zueyos-opaque-mobile-sheets`). Nothing was pushed, commented or merged.

## Verdicts

| PR | Verdict | Blockers | Majors |
| --- | --- | --- | --- |
| #270 | Approve (minor follow-ups optional) | 0 | 0 |
| #272 | Approve | 0 | 0 |

## Gates

| Check | #270 | #272 |
| --- | --- | --- |
| `bun test` | 1729 pass, 0 fail (103 files, 72.95 s) | 1780 pass, 0 fail (108 files, 80.60 s) |
| `bun run build` | astro check 0 errors, 0 warnings (70 hints); build Complete | astro check 0 errors, 0 warnings (70 hints); build Complete |
| `git merge-tree` vs current `origin/main` (`93ac444`) | clean | clean |
| Endpoints changed | no | no |

---

## PR #270: condition waits in the ZueyOS DOM tests

### Stress results

The load harness ran N parallel `bun test` processes of the 4 ZueyOS files. Alongside them ran 28 or 40 CPU-burner processes (on 28 logical CPUs) and a looping `bun run build`. Script: `scratchpad/stress.ps1`.

| Tree | Load | Runs | Failing runs |
| --- | --- | --- | --- |
| main | 8 parallel, 28 burners + build | 40 | 1 (8 tests failed) |
| main | 12 parallel, 40 burners + build (stopped after 2 rounds) | 24 | **23** |
| main, liquid-glass file only | 12 parallel, 40 burners + build | 24 | **24** |
| PR #270 | 8 parallel, 28 burners + build | 48 | 0 |
| PR #270 | 12 parallel, 40 burners + build | 36 | 0 |
| PR #270, liquid-glass file only | 12 parallel, 40 burners + build | 24 | 0 (each file run took 16.5 s to 26.8 s) |

The flake reproduces on main under load, and the PR removes it under identical load.

### What actually fails on main (differs from the PR's explanation)

- Every main failure starts with `this test timed out after 5000ms` (63 timeouts in the heavy batch, 24 out of 24 in the liquid-glass-only batch). React then logs `You seem to have overlapping act() calls`, and the following tests fail in a cascade.
- Of the About assertions that failed (`zueyos-controls-dom.test.ts:422/427/447/452` on main), all 24 report `Received: undefined`. In those runs the window had already been unmounted after a timeout. None reports `Received: false`, which is what a hashchange reopening About would produce.
- The happy-dom claim itself is correct. In `node_modules/happy-dom/lib/location/Location.js` (v20.14.6), `[PropertySymbol.setURL]` is called by `History.replaceState`/`pushState` (`history/History.js:128,163`). When the hash changes it queues a `HashChangeEvent` and dispatches the whole batch from one `setTimeout`, clearing and re-arming that timer on every change. That is non-standard (browsers do not fire hashchange on replaceState). It is plausible as a race, but my runs did not show it. Instrumented runs logged at most 3 hashchanges per test, with no ping-pong.
- The fix works mainly because of `setDefaultTimeout(30_000)`, because the 4.85 s toast sleep is gone, and because waits now track conditions rather than fixed 20 ms rounds. The hashchange guard is defensive and harmless.

### Findings

**Blocker:** none. **Major:** none.

**Minor**

1. *PR body overstates the cause.* The body says the hashchange trace is "the evidence for the cause". Under load, main fails through bun's 5 s per-test timeout and the cascade that follows, not through a reopened About window (evidence above). Suggest rewording the Cause section so #255's record matches what reproduces.
2. *`waitFor` never fails on its own, so a stuck wait can surface as a test timeout instead of a clear failure.* See `tests/zueyos-controls-dom.test.ts:71-74` and `tests/zueyos-liquid-glass.test.ts:322-325`. Most waits are followed by a matching `expect`, which then reports the wrong value, so that case is fine. The motion test is the exception (`zueyos-controls-dom.test.ts:242-253`). Its five `waitFor(shown(...))` calls have no direct `expect`. If `shown` never holds, they spend 5 × 10 s = 50 s, past the 30 s file timeout, and the test fails with "timed out" and no hint which step stuck. The same applies when only `hashSettled()` never holds. Suggest returning a boolean or throwing `Error('waitFor timed out: <label>')`.
3. *`hashSettled()` can be fooled by a batch that returns to the same hash.* See `zueyos-controls-dom.test.ts:64-65`. It compares the last delivered `newURL.hash` with `location.hash`. happy-dom delivers queued events as one batch, so a sequence `#a` (delivered) → `''` → `#a` inside one task reads as settled while two events are still queued. None of the current tests do this. The guard is a heuristic, not a proof that no events are queued.

**Nit**

4. `flush`, `waitFor`, `hashSettled`, `WAIT_MS` and the hashchange listener are copied verbatim in both files (`zueyos-controls-dom.test.ts:50-74,100` and `zueyos-liquid-glass.test.ts:302-325,353`). A small `tests/helpers/` module would keep the two from drifting (DRY).

### Checks that passed

- **No assertion weakened.** Every `expect` in both files is unchanged. The Escape steps that were `await escape(); await settle();` now wait on stricter conditions (modal gone and focus back on `share`, or `about().hidden === true`). The menu test's `settle(2)` → `flush()` is safe because everything it asserts afterwards is synchronous (`zueyos-controls-dom.test.ts:298-315`).
- **Waits are bounded.** Each wait has a 10 s limit (14.85 s for the toast), and the per-file default is 30 s.
- **Timeout stays per file.** `setDefaultTimeout` does not leak into other test files. On bun 1.4.2, a file that calls `setDefaultTimeout(30_000)` and runs before a file with a 6 s test leaves that test timing out at 5000 ms.

---

## PR #272: opaque paper and stage sheets on mobile

### Static review

- The change is three lines inside `@media (max-width: 767px)` (`src/components/os/os.css:331-333`). They override `--osw-bg` with the same RGB at alpha 1. The specificity equals the base rules at `os.css:143-144` and the override comes later, so it wins on phones only.
- The Liquid Glass and frost rules that read `--osw-bg` (`os.css:441-474`) are all inside `@media (min-width: 768px)`, so phones are unaffected by them and desktop is unaffected by the new lines. `--osw-bg` is not used anywhere else in `src/`.

### Browser check

Setup: Chromium via playwright-core. Dev servers ran on 127.0.0.1:4460 (PR) and :4461 (main) and were stopped afterwards. Script: `scratchpad/pw/review-272-sheets.mjs`. The sheet worktrees had to live at `D:\www\zuey\r272*` because the scratchpad path pushes the nested wrangler `esbuild.exe` past Windows MAX_PATH (`spawn ... ENOENT`).

| Viewport | Stack (under > top) | main | PR |
| --- | --- | --- | --- |
| 390x844, dark and light | github > pricing (stage) | `rgba(24, 21, 19, 0.96)` | `rgb(24, 21, 19)` |
| 390x844, dark and light | pricing > about (paper) | `rgba(245, 239, 235, 0.97)` | `rgb(245, 239, 235)` |
| 390x844, dark and light | pricing > knowledges (paper) | `rgba(245, 239, 235, 0.97)` | `rgb(245, 239, 235)` |
| 390x844, dark and light | about > reads (stage) | `rgba(24, 21, 19, 0.96)` | `rgb(24, 21, 19)` |
| 1440x900, liquid tier, dark and light | all four stacks | sheet `rgba(0,0,0,0)`, body `color(srgb …)` | identical to main |

- **Desktop is unchanged.** Computed sheet and body backgrounds match main for all 8 desktop cases.
- **Mobile bleed is gone.** The main screenshot of Pricing over GitHub shows the GitHub contribution grid faintly through the sheet. The PR screenshot is solid.
- **Contrast does not change.** Text colours are untouched, and the backgrounds move only from alpha .96/.97 to 1 over the same RGB, so contrast holds or improves slightly. Text stays legible on both paper and stage sheets.
- There were no page errors in any context.

### Conflict risk with draft PR #213

- `git merge-tree --write-tree` of #272 with #213 (`claude/trusting-hypatia-muwp5g`) is clean (exit 0). Each PR is also clean against `origin/main`.
- The merged block reads correctly. #213 sets `.osw--glass` to an opaque colour (plus a light-theme `:where()` rule), and #272 sets `.osw--paper`/`.osw--stage`. The selectors are different and do not interact.

### Findings

**Blocker:** none. **Major:** none. **Minor:** none.

**Nit**

1. Once both #213 and #272 land, the mobile block has two near-identical comments a few lines apart (`os.css:327` from #213 and `os.css:331` from #272). Whoever merges second could fold them into one comment.
2. `rgb(245, 239, 235)` and `rgb(24, 21, 19)` (`os.css:332-333`) repeat the base colours at `os.css:143-144`. If the base palette changes, phones would drift. `rgb(from var(--osw-bg) r g b / 1)` is already used at `os.css:474`, but it needs relative colour syntax on older mobile Safari, so keeping the literals is defensible.

---

## Cleanup

Removed: the review worktrees (`scratchpad/wt270`, `wt272`, `wtmain`, `D:\www\zuey\r272`, `D:\www\zuey\r272m`) together with their `node_modules`, `dist/` and `.wrangler/`, the instrumented test copies, and the temp timeout probe. CPU burners and dev servers were stopped, and ports 4460/4461 are no longer listening.

## Unresolved questions

- Should #270's PR body be corrected before merge so #255's record shows the observed cause (5 s timeout and cascade)?
