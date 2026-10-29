# Review: PR #292 (closes #282): deterministic work bounds instead of wall-clock asserts

Reviewed on `origin/test/282-deterministic-timing` @ 244f515, in a short-path worktree (now removed). The PR changes tests only: `git diff main` touches 7 files under `tests/`.

## Verification

| Check | Result |
| --- | --- |
| `bun test` (full, run once in the foreground) | 1907 pass, 0 fail, 111 files, 89.2 s |
| `bun run build` | 0 errors, 0 warnings (70 hints) |
| Re-break 1: removed the `MAX_PHONE_DIGITS` cap (`pii.ts:273`) | Count test **fails in 292 ms** with `RangeError: more than 524288 regex runs (bound 262144)`. The smoke test also fails, but only after **275 s** (see m2). |
| Re-break 2: restored the old JWT regex `eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}` in `redactJwts` | eyJ test **fails** in 4966 ms. It fails on the smoke ceiling, not on the run count (see m3). |
| Measured regex runs per char on the phone shapes | worst is `%2B84%20` at 7.38 and `12 ` at 7.33. The rest are 0 to 4.5. Bound is 16. |
| Measured eyJ runs | value scan 39, token 9. Bound is 100. |
| Measured non-ASCII runs | 9 per shape. Bound is `value.length`, about 16 000 (see m4). |
| `replace` / `split` / `matchAll` route through the patched `exec` | yes: 5, 5 and 4 calls on the tiny probes, so the counter sees them |

Production code was restored after each re-break (`git checkout`, then `git status` clean). The probe files were deleted.

## Critical
None.

## Major
None.

## Minor

**m1. Patching `RegExp.prototype.exec` slows regexes for the rest of the bun process, and restoring it does not undo that.** `tests/helpers/work-bound.ts:23-31`. The `finally` puts back the original function, so behaviour is correct. Performance is not restored, though. JSC's fast paths for `RegExp.prototype` stop being used once `exec` is overwritten, and they stay off after the restore.
- Measured in one process, on a loop of 200 000 `/\d+/.test` calls plus 2000 global `replace` calls: 62-73 ms before a single `regexRuns` call, 441-521 ms after it, about 7x slower.
- Across files in one `bun test` run, a probe file measured 90-134 ms when run alone and 522-737 ms when it ran after a file that called `regexRuns`.
- Real-world impact is small today. `data-table-v2` plus `site` took 211 ms alone and 227 ms after the patch file.
- The risk is that every later regex-heavy test, including the remaining 1000 ms ceilings, runs on the slow path. The helper's docstring says nothing about this.
- Suggested fix: document it in the helper's JSDoc ("the patch disables JSC regex fast paths for the remaining process; keep bounds count-based"). A cleaner option is to count at production seams, as the crafted-URL test already does with `decodeURIComponent`. Not blocking.

**m2. A regression that fails the count test can still hang the run for minutes in the smoke test.** `tests/analytics-phone-numbers.test.ts:201-207`. With the digit cap removed, the count test aborted in 292 ms. The separate smoke test then ran `elapsedMs(scan, 10)` across 10 shapes for 275 s of synchronous work. Bun's per-test timeout cannot stop synchronous code. The PR body says "a runaway scan fails at once", which holds only for `regexRuns`. Suggested fix: make each smoke iteration stop early once the ceiling has passed, for example a loop that checks elapsed time after each scan, or run the smoke check only after the count check passes. This affects failure latency only, not correctness.

**m3. The eyJ run-count bound does not catch the original JWT bug; only the wall-clock ceiling does.** `tests/analytics-encoded-pii.test.ts:178-181`. The comment says "a scan that restarts at every eyJ makes thousands". The original bug restarted *inside the regex engine* within one `replace`, which `regexRuns` cannot see; its own docstring says so. The PR body's table is accurate about this ("eyJ test: fail: 4858 ms"). The guarantee therefore rests on 60 repetitions against a 1000 ms ceiling. The re-break took about 4.97 s, so the margin is about 5x, which is enough for today's quadratic regex. A milder super-linear regression could pass. Suggested fix: reword the comment so it says the count bound only catches JS-level restart loops, and engine-level backtracking is caught by the ceiling.

**m4. The non-ASCII bound is far looser than the code needs.** `tests/analytics-encoded-pii.test.ts:191-192`. The bound is `value.length` (about 16 000), while the actual count is 9. A JS loop that runs one regex per `@` (4000 `@` in shape 2) would pass. In practice the protection again comes from the smoke ceiling. Suggested fix: a constant bound such as 50, or a per-`@` bound such as `count('@') + 20`, so it stays principled.

## Nit

- **n1. The PR body's audit of wall-clock asserts leaves out two remaining 1000 ms ceilings.** `tests/data-table-v2.test.ts:354-360` (it counts cells too) and `tests/analytics-phone-numbers.test.ts:228-232` (it counts `decodeURIComponent` too). Both are already a work count plus a generous ceiling, so they are fine. They still hard-code `1000` rather than `SMOKE_CEILING_MS`, as do `analytics.test.ts:390-392` and the `math-block` call sites that were converted. Consider using the constant consistently.
- **n2. `waitFor` timeout vs the per-test timeout.** `tests/helpers/zueyos.ts:49-56`. With `WAIT_MS = 10 s` and `setDefaultTimeout(30_000)`, one stuck step names itself, which is the goal. The keyboard-flow test chains about 8 waits, and the toast wait is `4800 + 10 000` ms. On a very slow machine the cumulative time can still reach bun's unlabelled 30 s timeout before any single wait expires. That is acceptable and much better than before; it is noted only so nobody assumes every timeout is labelled now.
- **n3. `flush()` in the shared helper calls `await import('react')` on every iteration.** `tests/helpers/zueyos.ts:23-26`. It resolves to the same cached module as the test files' `React`, so behaviour matches the old `React.act`. It adds a microtask hop per flush, which is harmless.

## Shared ZueyOS helpers: equivalence check
- `FakeAnimation`, `profile`, `flush` and the `WAIT_MS` value match the removed copies in both files. The liquid-glass copy's JSDoc was slightly shorter, but the code is the same.
- Hash tracking now keeps its state at module level in the helper. `trackHashChanges()` resets `deliveredHash` and attaches the listener to the current happy-dom window. Each file calls it in `beforeAll` after `GlobalRegistrator.register`, which matches the old per-file `addEventListener`. A stale listener on an unregistered window from an earlier file cannot write to the new state, because that window no longer dispatches events.
- `waitFor` checks once more after the last flush before it throws, and the message names the condition plus any pending hashchange. The new helper test (`zueyos-controls-dom.test.ts` "waitFor names the condition that never held") covers it. Every call site now passes a descriptive name.

## KaTeX budget
`spyOn(katex, 'renderToString')` intercepts production because `src/lib/blocks/math-render.ts:5,79` calls `katex.renderToString` on the default import. `perFormula` comes from a single `renderTex` call, so it is 0 for TeX that is refused before KaTeX runs. The expected count `withinBudget * perFormula` therefore means "KaTeX once per formula within budget, never after". `mockRestore` runs in `finally`. This is sound.

## Verdict
Each converted test still protects its guarantee. I confirmed this by re-breaking the phone cap and the JWT regex independently. The phone bounds (16 runs per char against a worst case of about 7.4) are principled. The helpers restore global state for correctness, and the build and suite are green. The findings are documentation, failure latency and tightness, not correctness.

Status: DONE_WITH_CONCERNS
Verdict: MERGE (m1 to m4 are optional follow-ups)
